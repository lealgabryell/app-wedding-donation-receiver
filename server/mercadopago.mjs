import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from './errors.mjs'
import { cents } from './model.mjs'

// Anti-corruption layer for the Mercado Pago Orders API. The rest of the server only sees
// PaymentSnapshot objects, so provider changes stay confined to this module.

const API = 'https://api.mercadopago.com'
const SEARCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000 - 60_000
const CLOCK_SKEW_MS = 10 * 60 * 1000

// Payment Brick `selectedPaymentMethod` → Orders `payment_method.type`.
// The SDK typings declare camelCase, but the Brick sends snake_case at runtime; accept both.
export const paymentMethodTypes = Object.freeze({
  credit_card: 'credit_card',
  debit_card: 'debit_card',
  prepaid_card: 'prepaid_card',
  bank_transfer: 'bank_transfer',
  creditCard: 'credit_card',
  debitCard: 'debit_card',
  prepaidCard: 'prepaid_card',
})

const orderStatuses = new Map([
  ['created', 'pending'],
  ['action_required', 'pending'],
  ['processing', 'in_process'],
  ['processed', 'approved'],
  ['failed', 'rejected'],
  ['canceled', 'cancelled'],
  ['refunded', 'refunded'],
  ['charged_back', 'charged_back'],
])

const knownErrorCodes = new Set([
  'unauthorized', 'forbidden', 'bad_request', 'invalid_token', 'invalid_credentials', 'invalid_client',
  'pa_unauthorized_result_from_policies', 'idempotency_key_already_used', 'empty_required_header',
  'required_properties', 'property_value', 'invalid_total_amount', 'order_not_found', 'too_many_requests',
  'usage_quota_exceeded', 'internal_error', 'invalid_parameter', 'missing_required_params', 'failed',
])
const testCredentialsHint = 'A Orders API não aceita credenciais TEST-. Em testes, use as credenciais de produção (APP_USR-) da aplicação criada pelo usuário vendedor de teste.'
const diagnoses = new Map([
  ['unauthorized use of live credentials', 'Uma das partes é de teste e a outra não: credenciais, comprador e cartão devem ser do mesmo ambiente.'],
  ['invalid_credentials', testCredentialsHint],
  ['invalid access token', 'Access Token inválido ou revogado. Confira a credencial configurada no ambiente do deploy.'],
  ['invalid_token', 'Access Token inválido ou revogado. Confira a credencial configurada no ambiente do deploy.'],
  ['invalid users involved', 'Usuários incompatíveis. Confira se vendedor e comprador pertencem ao ambiente de teste correto.'],
  ['pa_unauthorized_result_from_policies', 'Uma política do Mercado Pago bloqueou a operação. Confira as permissões e a situação da conta no provedor.'],
  ['forbidden', 'A aplicação não tem permissão para esta operação. Confira se ela foi criada para Checkout Transparente com a Orders API.'],
  ['idempotency_key_already_used', 'A chave de idempotência já foi usada; a tentativa será conferida pela consulta do pedido.'],
  ['required_properties', 'O pedido foi recusado por falta de campos obrigatórios.'],
  ['property_value', 'O pedido tem um valor recusado pela validação (o domínio do e-mail do comprador também pode ser recusado).'],
  ['invalid_total_amount', 'O valor total do pedido não corresponde à soma das transações.'],
])
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const DECIMAL = /^\d{1,9}(?:\.\d{1,2})?$/

function providerDiagnosis(body) {
  const list = (value) => (Array.isArray(value) ? value.slice(0, 10) : [])
  const causes = [...list(body?.cause), ...list(body?.errors)]
  const code = (value) => {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined
    const text = String(value).toLowerCase()
    return /^\d{1,5}$/.test(text) || knownErrorCodes.has(text) ? text : undefined
  }
  const error = code(body?.error)
  const codes = [...new Set([code(body?.code), ...causes.map((cause) => code(cause?.code))].filter(Boolean))]
  // Provider descriptions can echo payer data or credentials. Log only recognized, fixed guidance.
  const reasons = [body?.message, error, ...codes, ...causes.flatMap((cause) => [cause?.description, cause?.message])]
    .filter((value) => typeof value === 'string')
    .map((value) => diagnoses.get(value.trim().toLowerCase().replace(/\.$/, '')))
    .filter(Boolean)
  return {
    error, codes,
    diagnosis: [...new Set(reasons)].join(' ') || 'Motivo não reconhecido. Consulte o suporte do Mercado Pago com o HTTP e o requestId; o corpo da resposta foi omitido para proteger dados sensíveis.',
  }
}

export function verifySignature({ signature, requestId, dataId, secret }) {
  if (!signature || !requestId || !dataId || !secret) return false
  const parts = Object.fromEntries(signature.split(',').map((part) => part.trim().split('=')))
  if (!/^\d+$/.test(parts.ts ?? '') || !/^[a-f0-9]{64}$/i.test(parts.v1 ?? '')) return false
  // Orders ids are alphanumeric; the provider signs them lowercased.
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`
  const expected = createHmac('sha256', secret).update(manifest).digest()
  return timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'))
}

const decimal = (amount) => (cents(amount) / 100).toFixed(2)
const money = (value) => (typeof value === 'string' && DECIMAL.test(value) ? Number(value) : undefined)

export function buildOrderRequest(donation, item, { paymentType, form }) {
  const type = paymentMethodTypes[paymentType]
  if (!type) throw new AppError(400, 'Meio de pagamento não suportado.')
  const amount = decimal(donation.amount)
  const { email, first_name: firstName, last_name: lastName, identification } = form.payer
  return {
    type: 'online',
    processing_mode: 'automatic',
    external_reference: donation.id,
    total_amount: amount,
    description: `Presente de casamento: ${item.itemName}`.slice(0, 150),
    payer: {
      email,
      ...(firstName ? { first_name: firstName } : {}),
      ...(lastName ? { last_name: lastName } : {}),
      ...(identification ? { identification } : {}),
    },
    transactions: {
      payments: [{
        amount,
        payment_method: {
          id: form.payment_method_id,
          type,
          ...(type === 'bank_transfer' ? {} : { token: form.token, installments: form.installments ?? 1 }),
        },
      }],
    },
  }
}

function pixDetails(payment) {
  const method = payment?.payment_method
  if (typeof method?.qr_code !== 'string' || !method.qr_code || method.qr_code.length > 1000) return undefined
  const image = method.qr_code_base64
  let ticketUrl
  try {
    const url = new URL(method.ticket_url)
    if (url.protocol === 'https:') ticketUrl = url.href
  } catch { /* optional field */ }
  const expiresAt = Date.parse(payment.date_of_expiration)
  return {
    qrCode: method.qr_code,
    ...(typeof image === 'string' && image.length <= 60000 && /^[A-Za-z0-9+/=]+$/.test(image) ? { qrCodeBase64: image } : {}),
    ...(ticketUrl ? { ticketUrl } : {}),
    ...(Number.isFinite(expiresAt) ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
  }
}

// Order → PaymentSnapshot: { id, reference, status, amount, refundedAmount, currency, updatedAt, pix? }.
export function toPaymentSnapshot(order) {
  const invalid = () => new AppError(502, 'O Mercado Pago retornou um pedido em formato inesperado.')
  if (typeof order?.id !== 'string' || typeof order.external_reference !== 'string') throw invalid()
  let status = orderStatuses.get(order.status)
  if (!status) throw invalid()
  if (order.status === 'charged_back' && order.status_detail === 'reimbursed') status = 'approved'
  const amount = money(order.total_amount)
  if (amount === undefined) throw invalid()
  const refunds = Array.isArray(order.transactions?.refunds) ? order.transactions.refunds : []
  const refundedCents = refunds
    .filter((refund) => refund?.status === 'processed')
    .reduce((sum, refund) => sum + cents(money(refund.amount) ?? Number.NaN), 0)
  if (!Number.isSafeInteger(refundedCents)) throw invalid()
  if (order.status_detail === 'partially_refunded' && refundedCents === 0) {
    throw new AppError(502, 'O pedido tem reembolso parcial sem detalhes; consulte o painel do Mercado Pago.')
  }
  const currency = order.currency ?? order.currency_id ?? (order.country_code === 'BRA' ? 'BRL' : undefined)
  const pix = status === 'pending' ? pixDetails(order.transactions?.payments?.[0]) : undefined
  return {
    id: order.id,
    reference: order.external_reference,
    status,
    amount,
    refundedAmount: refundedCents / 100,
    currency,
    updatedAt: order.last_updated_date ?? order.created_date,
    ...(pix ? { pix } : {}),
  }
}

export function createOrdersGateway(accessToken, fetcher = fetch) {
  const authorization = { Authorization: `Bearer ${accessToken}` }

  // Distinguishes an invalid token from a valid token whose operation was refused; logs no personal data.
  async function inspectToken(payerEmail) {
    try {
      const response = await fetcher(`${API}/users/me`, { headers: authorization, signal: AbortSignal.timeout(5000) })
      if (response.status === 401) return { tokenValid: false }
      if (!response.ok) return {}
      const account = await response.json()
      const normalize = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')
      return {
        tokenValid: true,
        testUser: Array.isArray(account?.tags) && account.tags.includes('test_user'),
        accountSite: /^[A-Z]{3}$/.test(account?.site_id ?? '') ? account.site_id : undefined,
        payerIsSeller: payerEmail === undefined ? undefined : normalize(payerEmail) === normalize(account?.email),
      }
    } catch {
      return {}
    }
  }

  async function request(path, options = {}, payerEmail) {
    let response
    try {
      response = await fetcher(`${API}${path}`, {
        ...options,
        headers: { ...authorization, 'Content-Type': 'application/json', ...options.headers },
        signal: AbortSignal.timeout(12000),
      })
    } catch (error) {
      console.error('Falha de comunicação com Mercado Pago:', error.name)
      throw new AppError(503, 'Não foi possível confirmar a operação. Aguarde a consulta antes de tentar novamente.')
    }
    let body
    try {
      body = await response.json()
    } catch {
      if (response.ok) throw new AppError(502, 'O Mercado Pago retornou uma resposta ilegível.')
      console.error('Não foi possível ler o JSON de erro do Mercado Pago; corpo omitido. HTTP', response.status)
    }
    if (response.ok) return body
    // 402: the order exists but its transaction failed. It is a regular, definitive result.
    if (response.status === 402 && typeof body?.id === 'string' && typeof body?.status === 'string') return body
    const requestId = response.headers.get('x-request-id')
    console.error('Mercado Pago respondeu com HTTP', response.status, JSON.stringify({
      ...providerDiagnosis(body),
      ...(response.status === 401 ? await inspectToken(payerEmail) : {}),
      requestId: UUID.test(requestId ?? '') ? requestId : undefined,
    }))
    const error = new AppError(502, 'O Mercado Pago não confirmou a operação. Consulte o andamento antes de tentar novamente.')
    error.definitive = response.status >= 400 && response.status < 500 && ![408, 409, 423, 425, 429].includes(response.status)
    throw error
  }

  return {
    async create(donation, item, checkout) {
      const order = await request('/v1/orders', {
        method: 'POST',
        headers: { 'X-Idempotency-Key': donation.id },
        body: JSON.stringify(buildOrderRequest(donation, item, checkout)),
      }, checkout?.form?.payer?.email)
      return toPaymentSnapshot(order)
    },
    async get(id) {
      return toPaymentSnapshot(await request(`/v1/orders/${encodeURIComponent(id)}`))
    },
    // The search window is limited to 30 days, so it is anchored on the donation creation date.
    async find(reference, createdAt) {
      const begin = Date.parse(createdAt) - CLOCK_SKEW_MS
      if (!Number.isFinite(begin)) return undefined
      const end = Math.min(Date.now(), begin + SEARCH_WINDOW_MS)
      const query = new URLSearchParams({
        begin_date: new Date(begin).toISOString(),
        end_date: new Date(end).toISOString(),
        external_reference: reference,
        limit: '10',
      })
      const result = await request(`/v1/orders?${query}`)
      const order = Array.isArray(result?.data) ? result.data.find((entry) => entry?.external_reference === reference) : undefined
      return order ? toPaymentSnapshot(order) : undefined
    },
  }
}
