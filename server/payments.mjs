import { createHmac, timingSafeEqual } from 'node:crypto'
import { cents } from './model.mjs'

export class AppError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const released = new Set(['rejected', 'cancelled', 'refunded', 'charged_back'])

export function availableCents(db, item) {
  const reserved = db.donations
    .filter((donation) => donation.itemId === item.id && donation.status !== 'approved' && !released.has(donation.status))
    .reduce((sum, donation) => sum + cents(donation.amount) - donation.creditedCents, 0)
  return Math.max(0, cents(item.remainingValue) - reserved)
}

export function publicItems(db) {
  return db.items.map((item) => ({ ...item, availableValue: availableCents(db, item) / 100 }))
}

export function verifySignature({ signature, requestId, dataId, secret }) {
  if (!signature || !requestId || !dataId || !secret) return false
  const parts = Object.fromEntries(signature.split(',').map((part) => part.trim().split('=')))
  if (!/^\d+$/.test(parts.ts ?? '') || !/^[a-f0-9]{64}$/i.test(parts.v1 ?? '')) return false
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`
  const expected = createHmac('sha256', secret).update(manifest).digest()
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'))
}

export function createGateway(accessToken, notificationUrl, fetcher = fetch) {
  async function request(path, options = {}) {
    let response
    try {
      response = await fetcher(`https://api.mercadopago.com${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...options.headers },
        signal: AbortSignal.timeout(12000),
      })
    } catch (error) {
      console.error('Falha de comunicação com Mercado Pago:', error.name)
      throw new AppError(503, 'Não foi possível confirmar a operação. Aguarde a consulta antes de tentar novamente.')
    }
    if (!response.ok) {
      console.error('Mercado Pago respondeu com HTTP', response.status)
      const error = new AppError(502, 'O Mercado Pago não confirmou a operação. Consulte o andamento antes de tentar novamente.')
      error.definitive = response.status >= 400 && response.status < 500 && ![408, 409, 425, 429].includes(response.status)
      throw error
    }
    return response.json()
  }
  return {
    create(donation, item, form) {
      return request('/v1/payments', {
        method: 'POST',
        headers: { 'X-Idempotency-Key': donation.id },
        body: JSON.stringify({
          ...form,
          transaction_amount: donation.amount,
          description: `Presente de casamento: ${item.itemName}`,
          external_reference: donation.id,
          notification_url: notificationUrl,
        }),
      })
    },
    get: (id) => request(`/v1/payments/${encodeURIComponent(id)}`),
    async find(reference) {
      const result = await request(`/v1/payments/search?external_reference=${encodeURIComponent(reference)}&sort=date_created&criteria=desc`)
      return result.results?.[0]
    },
  }
}

export function createPaymentService(store, gateway) {
  const inFlight = new Set()
  async function applyPayment(payment) {
    const recorded = await store.findDonation(payment.external_reference)
    if (!recorded) return null
    return store.update(recorded.itemId, (db) => {
      const donation = db.donations.find((entry) => entry.id === payment.external_reference)
      if (!donation) return null
      if (!payment.id || payment.currency_id !== 'BRL' ||
          cents(payment.transaction_amount) !== cents(donation.amount) ||
          (donation.paymentId && donation.paymentId !== String(payment.id))) {
        throw new AppError(502, 'Os dados do pagamento não correspondem à doação.')
      }
      if (!Number.isFinite(Date.parse(payment.date_last_updated))) {
        throw new AppError(502, 'O pagamento não possui uma data de atualização válida.')
      }
      if (donation.paymentUpdatedAt && Date.parse(payment.date_last_updated) < Date.parse(donation.paymentUpdatedAt)) {
        return { ...donation }
      }
      const item = db.items.find((entry) => entry.id === donation.itemId)
      const credited = payment.status === 'approved'
        ? cents(payment.transaction_amount) - cents(payment.transaction_amount_refunded ?? 0)
        : payment.status === 'refunded' || payment.status === 'charged_back' ? 0 : donation.creditedCents
      const delta = credited - donation.creditedCents
      if (!Number.isSafeInteger(credited) || credited < 0 || credited > cents(donation.amount) ||
          cents(item.donatedValue) + delta > cents(item.totalPrice)) {
        throw new AppError(409, 'O pagamento precisa de conferência. Entre em contato com os organizadores.')
      }
      item.donatedValue = (cents(item.donatedValue) + delta) / 100
      item.remainingValue = (cents(item.totalPrice) - cents(item.donatedValue)) / 100
      donation.creditedCents = credited
      donation.status = payment.status
      donation.paymentId = String(payment.id)
      donation.paymentUpdatedAt = new Date(payment.date_last_updated).toISOString()
      return { ...donation }
    })
  }
  async function reconcile(id) {
    const donation = await store.findDonation(id)
    if (!donation) throw new AppError(404, 'Doação não encontrada.')
    if (donation.status === 'rejected' && !donation.paymentId) return donation
    const payment = donation.paymentId ? await gateway.get(donation.paymentId) : await gateway.find(id)
    return payment ? applyPayment(payment) : donation
  }
  return {
    applyPayment,
    reconcile,
    async reconcileBatch() {
      const batch = await store.reconciliationBatch()
      const results = await Promise.all(batch.map(async (donation) => {
        let success = true
        try {
          await reconcile(donation.id)
        } catch (error) {
          console.error('Falha ao reconciliar doação:', donation.id, error.name)
          success = false
        }
        try {
          await store.markReconciled(donation.id)
        } catch (error) {
          console.error('Falha ao registrar reconciliação:', donation.id, error.name)
          success = false
        }
        return success
      }))
      return { checked: results.length, failed: results.filter((success) => !success).length }
    },
    async create({ id, itemId, amount, form }) {
      if (inFlight.has(id)) throw new AppError(409, 'Seu pagamento já está sendo enviado. Aguarde.')
      inFlight.add(id)
      try {
        const existing = await store.findDonation(id)
        if (existing) {
          if (existing.itemId !== itemId || cents(existing.amount) !== cents(amount)) {
            throw new AppError(409, 'Esta tentativa já está associada a outra doação.')
          }
          return await reconcile(id)
        }
        let reservation
        try {
          reservation = await store.update(itemId, (db) => {
            const previous = db.donations.find((entry) => entry.id === id)
            if (previous) {
              if (previous.itemId !== itemId || cents(previous.amount) !== cents(amount)) {
                throw new AppError(409, 'Esta tentativa já está associada a outra doação.')
              }
              return { donation: { ...previous }, created: false }
            }
            const item = db.items.find((entry) => entry.id === itemId)
            if (!item) throw new AppError(404, 'Presente não encontrado.')
            if (cents(amount) > availableCents(db, item)) {
              throw new AppError(409, 'Este valor não está mais disponível. Atualize a lista e escolha outro valor.')
            }
            const entry = { id, itemId, amount, status: 'creating', creditedCents: 0, createdAt: new Date().toISOString() }
            db.donations.push(entry)
            return { donation: { ...entry }, created: true, item: { ...item } }
          })
        } catch (error) {
          if (error.code !== 11000) throw error
          const duplicate = await store.findDonation(id)
          if (!duplicate || duplicate.itemId !== itemId || cents(duplicate.amount) !== cents(amount)) {
            throw new AppError(409, 'Esta tentativa já está associada a outra doação.')
          }
          return reconcile(id)
        }
        if (!reservation.created) return reconcile(id)
        const { donation, item } = reservation
        try {
          const payment = await gateway.create(donation, item, form)
          return await applyPayment(payment)
        } catch (error) {
          if (error.definitive) {
            await store.update(itemId, (db) => {
              const entry = db.donations.find((candidate) => candidate.id === id)
              if (!entry.paymentId && entry.status === 'creating') entry.status = 'rejected'
            })
          }
          throw error
        }
      } finally {
        inFlight.delete(id)
      }
    },
  }
}
