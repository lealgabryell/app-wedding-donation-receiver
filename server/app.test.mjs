import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createApp, errorHandler } from './app.mjs'
import { createPaymentService } from './payments.mjs'
import { fixture, snapshotFor } from './test-helpers.mjs'
import { MongoRateLimitStore } from './rate-limit.mjs'

async function setup(t, overrides = {}) {
  const { store, db } = await fixture(t)
  const config = {
    origin: 'http://localhost:5173', publicKey: 'public-test', accessToken: 'private-test',
    webhookSecret: 'webhook-test', cronSecret: 'cron-test', ...overrides,
  }
  let payment
  const gateway = {
    async create(donation) {
      payment = snapshotFor(donation, { status: 'pending', pix: { qrCode: '00020126pix', qrCodeBase64: 'iVBORw0KGgo=' } })
      return payment
    },
    async get() { return payment },
  }
  const service = createPaymentService(store, gateway)
  const app = createApp({
    store, config, gateway, service,
    rateLimitStore: (prefix) => new MongoRateLimitStore(db.collection('rateLimits'), prefix),
  })
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const input = {
    id: randomUUID(), itemId: 1, amount: 50, paymentType: 'bank_transfer',
    form: { payment_method_id: 'pix', payer: { email: 'test@example.test' } },
  }
  const post = (body = input, origin = config.origin) => fetch(`${url}/api/donations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(body),
  })
  return { store, url, input, post, config, getPayment: () => payment }
}

test('API cria Pix, valida webhook, confirma pagamento e publica apenas catálogo e configuração pública', async (t) => {
  const { url, input, post, getPayment, config } = await setup(t)
  const created = await post()
  assert.equal(created.status, 200)
  const pending = await created.json()
  assert.equal(pending.status, 'pending')
  assert.equal(pending.pix.qrCode, '00020126pix')
  assert.equal('orderId' in pending, false)
  let items = await (await fetch(`${url}/api/items`)).json()
  assert.equal(items[0].donatedValue, 100)
  getPayment().status = 'approved'
  delete getPayment().pix
  const signature = createHmac('sha256', config.webhookSecret)
    .update('id:ord01test;request-id:request-1;ts:1704908010;').digest('hex')
  const notify = (type = 'order') => fetch(`${url}/api/webhooks/mercadopago?data.id=ORD01TEST`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-request-id': 'request-1',
      'x-signature': `ts=1704908010,v1=${signature}`,
    }, body: JSON.stringify({ type, action: 'order.processed' }),
  })
  assert.equal((await notify('payment')).status, 400)
  assert.equal((await notify()).status, 200)
  assert.equal((await notify()).status, 200)
  items = await (await fetch(`${url}/api/items`)).json()
  assert.equal(items[0].donatedValue, 150)
  assert.equal(items[0].remainingValue, 850)
  assert.equal((await (await fetch(`${url}/api/donations/${input.id}`)).json()).status, 'approved')
  assert.deepEqual(await (await fetch(`${url}/api/config`)).json(), { publicKey: 'public-test', paymentsEnabled: true })
  assert.equal(JSON.stringify(items).includes('payer'), false)
})

test('origem inválida, valor inválido e webhook sem assinatura não alteram os dados', async (t) => {
  const { store, url, post, input } = await setup(t)
  const unauthorized = await post(input, 'https://other.example.test')
  assert.equal(unauthorized.status, 403)
  assert.equal((await unauthorized.json()).donationRecorded, false)
  assert.equal((await post({ ...input, amount: -1 })).status, 400)
  assert.equal((await post({ ...input, amount: 0.001 })).status, 400)
  assert.equal((await post({ ...input, amount: 901 })).status, 409)
  assert.equal((await post({ ...input, paymentType: undefined })).status, 400)
  assert.equal((await post({ ...input, paymentType: 'creditCard' })).status, 400)
  assert.equal((await post({ ...input, form: { ...input.form, token: 'card-token' } })).status, 400)
  assert.equal((await fetch(`${url}/api/webhooks/mercadopago?data.id=ORD01TEST`, { method: 'POST' })).status, 401)
  assert.equal((await store.read()).donations.length, 0)
  assert.equal((await store.read()).items[0].remainingValue, 900)
})

test('sem credenciais catálogo continua disponível e pagamentos são explicitamente desabilitados', async (t) => {
  const { url, post } = await setup(t, { accessToken: '' })
  assert.equal((await fetch(`${url}/api/items`)).status, 200)
  assert.equal((await (await fetch(`${url}/api/config`)).json()).paymentsEnabled, false)
  assert.equal((await post()).status, 503)
})

test('rotas desconhecidas retornam JSON e não expõem arquivos nem credenciais', async (t) => {
  const { url } = await setup(t)
  const response = await fetch(`${url}/api/not-found`)
  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type'), /application\/json/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { error: 'Endereço não encontrado.' })
  const config = await (await fetch(`${url}/api/config`)).text()
  for (const secret of ['private-test', 'cron-test', 'webhook-test', 'MONGODB_URI']) {
    assert.equal(config.includes(secret), false)
  }
})

test('cron exige segredo, reconcilia pendências e informa falhas sem repetir cobranças', async (t) => {
  const { url, post, getPayment, store } = await setup(t)
  const cron = (authorization) => fetch(`${url}/api/cron/reconcile`, {
    headers: authorization ? { authorization } : {},
  })
  assert.equal((await cron()).status, 401)
  assert.equal((await cron('Bearer wrong')).status, 401)
  await post()
  getPayment().status = 'approved'
  const response = await cron('Bearer cron-test')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { checked: 1, failed: 0 })
  assert.equal((await store.read()).items[0].donatedValue, 150)
  getPayment().amount = 999
  const failed = await cron('Bearer cron-test')
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { checked: 1, failed: 1 })
  assert.equal((await store.read()).items[0].donatedValue, 150)
})

test('limite de criação bloqueia a 11ª tentativa e não registra doação inválida', async (t) => {
  const { post, store } = await setup(t)
  for (let count = 0; count < 10; count++) assert.equal((await post({})).status, 400)
  const limited = await post({})
  assert.equal(limited.status, 429)
  assert.equal((await limited.json()).donationRecorded, false)
  assert.equal((await store.read()).donations.length, 0)
})

test('entrada inválida não pode transformar identificador em consulta MongoDB', async (t) => {
  const { post, input, store } = await setup(t)
  await post()
  const response = await post({ ...input, id: { $ne: null } })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).donationRecorded, false)
  assert.equal((await store.read()).donations.length, 1)
})
