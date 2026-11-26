import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { buildOrderRequest, createOrdersGateway, toPaymentSnapshot, verifySignature } from './mercadopago.mjs'
import { orderFor } from './test-helpers.mjs'

const item = { itemName: 'Jogo de panelas' }
const card = {
  paymentType: 'creditCard',
  form: { token: 'card-token', payment_method_id: 'master', installments: 2, issuer_id: '12749', payer: { email: 'a@example.test' } },
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('cria pedido com valores decimais em texto, chave de idempotência e sem notification_url', async () => {
  const donation = { id: randomUUID(), amount: 25.5 }
  const calls = []
  const gateway = createOrdersGateway('APP_USR-test', async (url, options) => {
    calls.push({ url, options })
    return json(orderFor(donation))
  })
  const snapshot = await gateway.create(donation, item, card)
  const [{ url, options }] = calls
  const body = JSON.parse(options.body)
  assert.equal(url, 'https://api.mercadopago.com/v1/orders')
  assert.equal(options.headers['X-Idempotency-Key'], donation.id)
  assert.equal(options.headers.Authorization, 'Bearer APP_USR-test')
  assert.equal(body.total_amount, '25.50')
  assert.equal(body.external_reference, donation.id)
  assert.deepEqual(body.transactions.payments, [{
    amount: '25.50', payment_method: { id: 'master', type: 'credit_card', token: 'card-token', installments: 2 },
  }])
  assert.equal('notification_url' in body, false)
  assert.equal(JSON.stringify(body).includes('issuer_id'), false)
  // Formato real enviado pelo Brick em produção (snake_case).
  const runtime = buildOrderRequest(donation, item, { ...card, paymentType: 'credit_card' })
  assert.deepEqual(runtime.transactions.payments, body.transactions.payments)
  assert.deepEqual(snapshot, {
    id: 'ORD01TEST', reference: donation.id, status: 'approved', amount: 25.5, refundedAmount: 0,
    currency: 'BRL', updatedAt: '2026-01-01T12:00:00.000000000Z',
  })
})

test('Pix usa bank_transfer sem token e expõe apenas dados seguros do QR code enquanto pendente', () => {
  const donation = { id: randomUUID(), amount: 10 }
  const request = buildOrderRequest(donation, item, { paymentType: 'bank_transfer', form: { payment_method_id: 'pix', payer: { email: 'a@example.test' } } })
  assert.deepEqual(request.transactions.payments[0].payment_method, { id: 'pix', type: 'bank_transfer' })
  const payment = {
    id: 'PAY01', status: 'action_required', date_of_expiration: '2026-01-02T12:00:00.000-03:00',
    payment_method: { id: 'pix', type: 'bank_transfer', qr_code: '00020126pix', qr_code_base64: 'iVBORw0KGgo=', ticket_url: 'https://www.mercadopago.com.br/pix' },
  }
  const pending = toPaymentSnapshot(orderFor(donation, { status: 'action_required', transactions: { payments: [payment] } }))
  assert.equal(pending.status, 'pending')
  assert.deepEqual(pending.pix, {
    qrCode: '00020126pix', qrCodeBase64: 'iVBORw0KGgo=', ticketUrl: 'https://www.mercadopago.com.br/pix', expiresAt: '2026-01-02T15:00:00.000Z',
  })
  const unsafe = { ...payment, payment_method: { ...payment.payment_method, qr_code_base64: '<svg>', ticket_url: 'javascript:alert(1)' } }
  assert.deepEqual(toPaymentSnapshot(orderFor(donation, { status: 'action_required', transactions: { payments: [unsafe] } })).pix, {
    qrCode: '00020126pix', expiresAt: '2026-01-02T15:00:00.000Z',
  })
  assert.equal(toPaymentSnapshot(orderFor(donation, { transactions: { payments: [payment] } })).pix, undefined)
})

test('status da Orders API são traduzidos para o domínio e formatos inesperados são rejeitados', () => {
  const donation = { id: randomUUID(), amount: 10 }
  const statusOf = (status, extra = {}) => toPaymentSnapshot(orderFor(donation, { status, ...extra })).status
  assert.equal(statusOf('created'), 'pending')
  assert.equal(statusOf('processing'), 'in_process')
  assert.equal(statusOf('processed'), 'approved')
  assert.equal(statusOf('failed'), 'rejected')
  assert.equal(statusOf('canceled'), 'cancelled')
  assert.equal(statusOf('refunded'), 'refunded')
  assert.equal(statusOf('charged_back'), 'charged_back')
  assert.equal(statusOf('charged_back', { status_detail: 'reimbursed' }), 'approved')
  assert.throws(() => statusOf('unknown'), /formato inesperado/)
  assert.throws(() => toPaymentSnapshot(orderFor(donation, { total_amount: 10 })), /formato inesperado/)
  assert.equal(toPaymentSnapshot(orderFor(donation, { country_code: 'ARG' })).currency, undefined)
})

test('reembolsos parciais somam apenas estornos processados', () => {
  const donation = { id: randomUUID(), amount: 100 }
  const refunds = [{ amount: '25.25', status: 'processed' }, { amount: '10.00', status: 'processing' }]
  const snapshot = toPaymentSnapshot(orderFor(donation, { status_detail: 'partially_refunded', transactions: { refunds } }))
  assert.equal(snapshot.status, 'approved')
  assert.equal(snapshot.refundedAmount, 25.25)
  assert.throws(() => toPaymentSnapshot(orderFor(donation, { status_detail: 'partially_refunded', transactions: {} })), /reembolso parcial/)
})

test('HTTP 402 com pedido é resultado definitivo; 409 e 5xx não liberam a reserva', async (t) => {
  t.mock.method(console, 'error', () => {})
  const donation = { id: randomUUID(), amount: 10 }
  const failed = orderFor(donation, { status: 'failed', status_detail: 'failed' })
  assert.equal((await createOrdersGateway('x', async () => json(failed, 402)).create(donation, item, card)).status, 'rejected')
  for (const [status, definitive] of [[400, true], [409, false], [423, false], [500, false]]) {
    await assert.rejects(createOrdersGateway('x', async () => json({ errors: [{ code: 'failed' }] }, status)).create(donation, item, card),
      (error) => error.status === 502 && error.definitive === definitive)
  }
})

test('401 registra diagnóstico sem dados pessoais e identifica credencial de teste', async (t) => {
  const logs = []
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')))
  const fetcher = async (url) => url.endsWith('/users/me')
    ? json({ tags: ['test_user'], site_id: 'MLB', email: 'seller@example.test' })
    : json({ errors: [{ code: 'invalid_credentials', message: 'a@example.test' }] }, 401)
  await assert.rejects(createOrdersGateway('x', fetcher).create({ id: randomUUID(), amount: 10 }, item, card))
  assert.match(logs[0], /APP_USR-/)
  assert.match(logs[0], /"testUser":true/)
  assert.equal(logs[0].includes('a@example.test'), false)
})

test('busca por referência usa janela limitada e filtra pela referência exata', async () => {
  const donation = { id: randomUUID(), amount: 10 }
  let requested
  const gateway = createOrdersGateway('x', async (url) => {
    requested = new URL(url)
    return json({ data: [orderFor({ id: randomUUID(), amount: 10 }), orderFor(donation)] })
  })
  const createdAt = '2026-01-01T12:00:00.000Z'
  assert.equal((await gateway.find(donation.id, createdAt)).reference, donation.id)
  assert.equal(requested.pathname, '/v1/orders')
  assert.equal(requested.searchParams.get('external_reference'), donation.id)
  assert.equal(requested.searchParams.get('begin_date'), '2026-01-01T11:50:00.000Z')
  assert.ok(Date.parse(requested.searchParams.get('end_date')) - Date.parse(requested.searchParams.get('begin_date')) <= 30 * 86_400_000)
  assert.equal(await gateway.find(donation.id, 'invalid'), undefined)
})

test('assinatura do webhook usa o id do pedido em minúsculas', () => {
  const secret = 'webhook-test'
  const v1 = createHmac('sha256', secret).update('id:ord01abc;request-id:r1;ts:1704908010;').digest('hex')
  const base = { requestId: 'r1', dataId: 'ORD01ABC', secret }
  assert.equal(verifySignature({ ...base, signature: `ts=1704908010,v1=${v1}` }), true)
  assert.equal(verifySignature({ ...base, signature: `ts=1704908011,v1=${v1}` }), false)
  assert.equal(verifySignature({ ...base, signature: 'ts=1704908010' }), false)
})
