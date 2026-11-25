import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { createStore } from './store.mjs'
import { createGateway, createPaymentService, publicItems, verifySignature } from './payments.mjs'
import { fixture, paymentFor } from './test-helpers.mjs'

test('aprovação atualiza valores em centavos e repetição não contabiliza duas vezes', async (t) => {
  const { store, file, seed } = await fixture(t)
  let calls = 0
  let payment
  const gateway = {
    async create(donation) { calls++; payment = paymentFor(donation); return payment },
    async get() { return payment },
  }
  const service = createPaymentService(store, gateway)
  const input = { id: randomUUID(), itemId: 1, amount: 25.37, form: {} }
  await service.create(input)
  await service.create(input)
  await service.applyPayment(payment)
  const item = (await createStore(file, seed)).read().items[0]
  assert.equal(calls, 1)
  assert.equal(item.donatedValue, 125.37)
  assert.equal(item.remainingValue, 874.63)
})

test('Pix pendente reserva saldo sem alterar o progresso; webhook aprova e estorno reverte', async (t) => {
  const { store } = await fixture(t)
  let payment
  const service = createPaymentService(store, {
    async create(donation) { payment = paymentFor(donation, { status: 'pending' }); return payment },
    async get() { return payment },
  })
  const donation = await service.create({ id: randomUUID(), itemId: 1, amount: 100, form: {} })
  assert.equal(publicItems(store.read())[0].availableValue, 800)
  assert.equal(store.read().items[0].donatedValue, 100)
  payment.status = 'approved'
  await service.reconcile(donation.id)
  assert.equal(store.read().items[0].donatedValue, 200)
  await service.applyPayment({ ...payment, status: 'refunded' })
  await service.applyPayment({ ...payment, status: 'refunded' })
  assert.equal(store.read().items[0].donatedValue, 100)
  assert.equal(store.read().items[0].remainingValue, 900)
})

test('doações concorrentes não podem ultrapassar o saldo do presente', async (t) => {
  const { store } = await fixture(t)
  const service = createPaymentService(store, {
    async create(donation) { return paymentFor(donation, { status: 'pending', id: donation.id }) },
  })
  const results = await Promise.allSettled([1, 2].map(() =>
    service.create({ id: randomUUID(), itemId: 1, amount: 600, form: {} })))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(store.read().donations.length, 1)
  assert.equal(publicItems(store.read())[0].availableValue, 300)
})

test('estorno parcial reabre somente o valor estornado para novas doações', async (t) => {
  const { store } = await fixture(t)
  let payment
  const service = createPaymentService(store, {
    async create(donation) { payment = paymentFor(donation); return payment },
  })
  await service.create({ id: randomUUID(), itemId: 1, amount: 100, form: {} })
  await service.applyPayment({ ...payment, transaction_amount_refunded: 25.25 })
  await service.applyPayment({ ...payment, transaction_amount_refunded: 25.25 })
  assert.equal(store.read().items[0].donatedValue, 174.75)
  assert.equal(store.read().items[0].remainingValue, 825.25)
  assert.equal(publicItems(store.read())[0].availableValue, 825.25)
})

test('falha ambígua mantém reserva e recupera aprovação após reiniciar sem criar nova cobrança', async (t) => {
  const { store, file, seed } = await fixture(t)
  let recordedPayment
  const input = { id: randomUUID(), itemId: 1, amount: 99, form: {} }
  await assert.rejects(createPaymentService(store, {
    async create(donation) { recordedPayment = paymentFor(donation); throw new Error('timeout') },
  }).create(input), /timeout/)
  assert.equal(publicItems(store.read())[0].availableValue, 801)
  const reopened = await createStore(file, seed)
  const service = createPaymentService(reopened, { async find() { return recordedPayment } })
  await service.create(input)
  assert.equal(reopened.read().items[0].donatedValue, 199)
})

test('valores ou moeda divergentes nunca alteram o saldo', async (t) => {
  const { store } = await fixture(t)
  const service = createPaymentService(store, {
    async create(donation) { return paymentFor(donation, { transaction_amount: 999 }) },
  })
  const id = randomUUID()
  await assert.rejects(service.create({ id, itemId: 1, amount: 20, form: {} }), /não correspondem/)
  await assert.rejects(service.applyPayment(paymentFor({ id, amount: 20 }, { currency_id: 'USD' })), /não correspondem/)
  assert.equal(store.read().items[0].donatedValue, 100)
})

test('recusa definitiva libera a reserva, mas erro de rede não gera cobrança automática adicional', async (t) => {
  const { store } = await fixture(t)
  const gateway = createGateway('test', 'https://example.test/webhook', async () => new Response('{}', { status: 400 }))
  const service = createPaymentService(store, gateway)
  const id = randomUUID()
  await assert.rejects(service.create({ id, itemId: 1, amount: 10, form: {} }))
  assert.equal((await service.reconcile(id)).status, 'rejected')
  assert.equal(publicItems(store.read())[0].availableValue, 900)
})

test('assinatura válida é aceita e adulterações são recusadas', () => {
  const secret = 'local-test-secret'
  const signature = createHmac('sha256', secret).update('id:123;request-id:request-1;ts:1704908010;').digest('hex')
  const input = { secret, dataId: '123', requestId: 'request-1', signature: `ts=1704908010,v1=${signature}` }
  assert.equal(verifySignature(input), true)
  assert.equal(verifySignature({ ...input, dataId: '124' }), false)
  assert.equal(verifySignature({ ...input, signature: 'invalid' }), false)
})

test('gateway define valor, referência e idempotência a partir dos dados do servidor', async () => {
  const donation = { id: randomUUID(), amount: 25 }
  const gateway = createGateway('test-token', 'https://example.test/webhook', async (url, options) => {
    assert.equal(url, 'https://api.mercadopago.com/v1/payments')
    assert.equal(options.headers['X-Idempotency-Key'], donation.id)
    const body = JSON.parse(options.body)
    assert.equal(body.transaction_amount, 25)
    assert.equal(body.external_reference, donation.id)
    assert.equal(body.notification_url, 'https://example.test/webhook')
    return Response.json(paymentFor(donation))
  })
  await gateway.create(donation, { itemName: 'Flores' }, {
    transaction_amount: 999, external_reference: 'forged', notification_url: 'https://other.example.test',
  })
})
