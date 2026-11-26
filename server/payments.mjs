import { AppError } from './errors.mjs'
import { cents } from './model.mjs'

// Donation domain rules. Gateways must return PaymentSnapshot objects:
// { id, reference, status, amount, refundedAmount, currency, updatedAt, pix? }.

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

function creditedCents(snapshot, donation) {
  if (snapshot.status === 'approved') return cents(snapshot.amount) - cents(snapshot.refundedAmount ?? 0)
  if (snapshot.status === 'refunded' || snapshot.status === 'charged_back') return 0
  return donation.creditedCents
}

export function createPaymentService(store, gateway) {
  const inFlight = new Set()

  async function applyPayment(snapshot) {
    const recorded = await store.findDonation(snapshot.reference)
    if (!recorded) return null
    return store.update(recorded.itemId, (db) => {
      const donation = db.donations.find((entry) => entry.id === snapshot.reference)
      if (!donation) return null
      if (!snapshot.id || snapshot.currency !== 'BRL' ||
          cents(snapshot.amount) !== cents(donation.amount) ||
          (donation.orderId && donation.orderId !== snapshot.id)) {
        throw new AppError(502, 'Os dados do pagamento não correspondem à doação.')
      }
      const updatedAt = Date.parse(snapshot.updatedAt)
      if (!Number.isFinite(updatedAt)) {
        throw new AppError(502, 'O pagamento não possui uma data de atualização válida.')
      }
      if (donation.paymentUpdatedAt && updatedAt < Date.parse(donation.paymentUpdatedAt)) {
        return { ...donation }
      }
      const item = db.items.find((entry) => entry.id === donation.itemId)
      const credited = creditedCents(snapshot, donation)
      const delta = credited - donation.creditedCents
      if (!Number.isSafeInteger(credited) || credited < 0 || credited > cents(donation.amount) ||
          cents(item.donatedValue) + delta > cents(item.totalPrice)) {
        throw new AppError(409, 'O pagamento precisa de conferência. Entre em contato com os organizadores.')
      }
      item.donatedValue = (cents(item.donatedValue) + delta) / 100
      item.remainingValue = (cents(item.totalPrice) - cents(item.donatedValue)) / 100
      donation.creditedCents = credited
      donation.status = snapshot.status
      donation.orderId = snapshot.id
      donation.paymentUpdatedAt = new Date(updatedAt).toISOString()
      if (snapshot.pix) donation.pix = snapshot.pix
      else delete donation.pix
      if (snapshot.statusDetail) donation.statusDetail = snapshot.statusDetail
      else delete donation.statusDetail
      return { ...donation }
    })
  }

  async function reconcile(id) {
    const donation = await store.findDonation(id)
    if (!donation) throw new AppError(404, 'Doação não encontrada.')
    if (donation.status === 'rejected' && !donation.orderId) return donation
    // Records created with the former Payments API cannot be looked up through Orders.
    if (!donation.orderId && donation.paymentId) return donation
    const snapshot = donation.orderId
      ? await gateway.get(donation.orderId)
      : await gateway.find(id, donation.createdAt)
    return snapshot ? applyPayment(snapshot) : donation
  }

  async function reserve({ id, itemId, amount }) {
    try {
      return await store.update(itemId, (db) => {
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
      return { created: false }
    }
  }

  async function releaseIfUnconfirmed(itemId, id) {
    await store.update(itemId, (db) => {
      const entry = db.donations.find((candidate) => candidate.id === id)
      if (!entry.orderId && entry.status === 'creating') entry.status = 'rejected'
    })
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
    async create({ id, itemId, amount, checkout }) {
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
        const reservation = await reserve({ id, itemId, amount })
        if (!reservation.created) return await reconcile(id)
        try {
          return await applyPayment(await gateway.create(reservation.donation, reservation.item, checkout))
        } catch (error) {
          if (error.definitive) await releaseIfUnconfirmed(itemId, id)
          throw error
        }
      } finally {
        inFlight.delete(id)
      }
    },
  }
}
