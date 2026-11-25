import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createApp, errorHandler } from './app.mjs'
import { createPaymentService } from './payments.mjs'
import { fixture, paymentFor } from './test-helpers.mjs'

async function setup(t, overrides = {}) {
  const { store } = await fixture(t)
  const config = {
    origin: 'http://localhost:5173', publicKey: 'public-test', accessToken: 'private-test',
    webhookSecret: 'webhook-test', notificationUrl: 'https://example.test/webhook', ...overrides,
  }
  let payment
  const gateway = {
    async create(donation) { payment = paymentFor(donation, { status: 'pending' }); return payment },
    async get() { return payment },
  }
  const service = createPaymentService(store, gateway)
  const app = createApp({ store, config, gateway, service })
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const input = { id: randomUUID(), itemId: 1, amount: 50, form: { payment_method_id: 'pix', payer: { email: 'test@example.test' } } }
  const post = (body = input, origin = config.origin) => fetch(`${url}/api/donations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(body),
  })
  return { store, url, input, post, config, getPayment: () => payment }
}

test('API cria Pix, valida webhook, confirma pagamento e publica apenas catálogo e configuração pública', async (t) => {
  const { url, input, post, getPayment, config } = await setup(t)
  const created = await post()
  assert.equal(created.status, 200)
  assert.equal((await created.json()).status, 'pending')
  let items = await (await fetch(`${url}/api/items`)).json()
  assert.equal(items[0].donatedValue, 100)
  getPayment().status = 'approved'
  const signature = createHmac('sha256', config.webhookSecret)
    .update('id:123456;request-id:request-1;ts:1704908010;').digest('hex')
  const notify = () => fetch(`${url}/api/webhooks/mercadopago?data.id=123456`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-request-id': 'request-1',
      'x-signature': `ts=1704908010,v1=${signature}`,
    }, body: JSON.stringify({ type: 'payment' }),
  })
  assert.equal((await notify()).status, 200)
  assert.equal((await notify()).status, 200)
  items = await (await fetch(`${url}/api/items`)).json()
  assert.equal(items[0].donatedValue, 150)
  assert.equal(items[0].remainingValue, 850)
  assert.equal((await (await fetch(`${url}/api/donations/${input.id}`)).json()).status, 'approved')
  assert.deepEqual(await (await fetch(`${url}/api/config`)).json(), { publicKey: 'public-test', paymentsEnabled: true })
  assert.equal(JSON.stringify(items).includes('payer'), false)
})

test('origem inválida, valor inválido e webhook sem assinatura não alteram o JSON', async (t) => {
  const { store, url, post, input } = await setup(t)
  const unauthorized = await post(input, 'https://other.example.test')
  assert.equal(unauthorized.status, 403)
  assert.equal((await unauthorized.json()).donationRecorded, false)
  assert.equal((await post({ ...input, amount: -1 })).status, 400)
  assert.equal((await post({ ...input, amount: 0.001 })).status, 400)
  assert.equal((await post({ ...input, amount: 901 })).status, 409)
  assert.equal((await fetch(`${url}/api/webhooks/mercadopago?data.id=123456`, { method: 'POST' })).status, 401)
  assert.equal(store.read().donations.length, 0)
  assert.equal(store.read().items[0].remainingValue, 900)
})

test('sem credenciais catálogo continua disponível e pagamentos são explicitamente desabilitados', async (t) => {
  const { url, post } = await setup(t, { accessToken: '' })
  assert.equal((await fetch(`${url}/api/items`)).status, 200)
  assert.equal((await (await fetch(`${url}/api/config`)).json()).paymentsEnabled, false)
  assert.equal((await post()).status, 503)
})
