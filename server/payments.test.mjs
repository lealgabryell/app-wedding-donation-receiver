import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { createGateway, createPaymentService, publicItems, verifySignature } from './payments.mjs'
import { fixture, paymentFor } from './test-helpers.mjs'

test('aprovação atualiza valores em centavos e repetição não contabiliza duas vezes', async (t) => {
  const { store, reopen } = await fixture(t)
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
  const item = (await (await reopen()).read()).items[0]
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
  assert.equal(publicItems(await store.read())[0].availableValue, 800)
  assert.equal((await store.read()).items[0].donatedValue, 100)
  payment.status = 'approved'
  await service.reconcile(donation.id)
  assert.equal((await store.read()).items[0].donatedValue, 200)
  await service.applyPayment({ ...payment, status: 'refunded' })
  await service.applyPayment({ ...payment, status: 'refunded' })
  assert.equal((await store.read()).items[0].donatedValue, 100)
  assert.equal((await store.read()).items[0].remainingValue, 900)
})

test('doações concorrentes não podem ultrapassar o saldo do presente', async (t) => {
  const { store, reopen } = await fixture(t)
  const gateway = {
    async create(donation) { return paymentFor(donation, { status: 'pending', id: donation.id }) },
  }
  const services = [createPaymentService(store, gateway), createPaymentService(await reopen(), gateway)]
  const results = await Promise.allSettled(services.map((service) =>
    service.create({ id: randomUUID(), itemId: 1, amount: 600, form: {} })))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal((await store.read()).donations.length, 1)
  assert.equal(publicItems(await store.read())[0].availableValue, 300)
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
  assert.equal((await store.read()).items[0].donatedValue, 174.75)
  assert.equal((await store.read()).items[0].remainingValue, 825.25)
  assert.equal(publicItems(await store.read())[0].availableValue, 825.25)
})

test('falha ambígua mantém reserva e recupera aprovação após reiniciar sem criar nova cobrança', async (t) => {
  const { store, reopen } = await fixture(t)
  let recordedPayment
  const input = { id: randomUUID(), itemId: 1, amount: 99, form: {} }
  await assert.rejects(createPaymentService(store, {
    async create(donation) { recordedPayment = paymentFor(donation); throw new Error('timeout') },
  }).create(input), /timeout/)
  assert.equal(publicItems(await store.read())[0].availableValue, 801)
  const reopened = await reopen()
  const service = createPaymentService(reopened, { async find() { return recordedPayment } })
  await service.create(input)
  assert.equal((await reopened.read()).items[0].donatedValue, 199)
})

test('valores ou moeda divergentes nunca alteram o saldo', async (t) => {
  const { store } = await fixture(t)
  const service = createPaymentService(store, {
    async create(donation) { return paymentFor(donation, { transaction_amount: 999 }) },
  })
  const id = randomUUID()
  await assert.rejects(service.create({ id, itemId: 1, amount: 20, form: {} }), /não correspondem/)
  await assert.rejects(service.applyPayment(paymentFor({ id, amount: 20 }, { currency_id: 'USD' })), /não correspondem/)
  assert.equal((await store.read()).items[0].donatedValue, 100)
})

test('recusa definitiva libera a reserva, mas erro de rede não gera cobrança automática adicional', async (t) => {
  const { store } = await fixture(t)
  const gateway = createGateway('test', 'https://example.test/webhook', async () => new Response('{}', { status: 400 }))
  const service = createPaymentService(store, gateway)
  const id = randomUUID()
  await assert.rejects(service.create({ id, itemId: 1, amount: 10, form: {} }))
  assert.equal((await service.reconcile(id)).status, 'rejected')
  assert.equal(publicItems(await store.read())[0].availableValue, 900)
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
    assert.equal(options.headers.Authorization, 'Bearer test-token')
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

test('gateway diferencia recusa de credenciais e permissões sem registrar dados sensíveis', async (t) => {
  const logs = []
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')))
  const requestId = randomUUID()
  const gateway = createGateway('private-token', 'https://example.test/webhook', async (url) => url.endsWith('/users/me')
    ? Response.json({ id: 1, email: 'seller@example.test', site_id: 'MLB', tags: ['normal', 'test_user'] })
    : Response.json({
    error: 'unauthorized',
    message: 'Unauthorized use of live credentials',
    cause: [
      { code: 300, description: 'Unauthorized use of live credentials' },
      { code: 'private-token', description: 'payer@example.test private-token card-token' },
    ],
    payer: { email: 'payer@example.test', identification: { number: '00000000000' } },
    token: 'card-token',
  }, { status: 401, headers: { 'x-request-id': requestId } }))
  await assert.rejects(gateway.create({ id: randomUUID(), amount: 25 }, { itemName: 'Flores' }, { payer: { email: ' Seller@Example.test ' } }), (error) => {
    assert.equal(error.status, 502)
    assert.equal(error.definitive, true)
    assert.equal(error.message.includes('private-token'), false)
    return true
  })
  const output = logs.join('\n')
  assert.match(output, /HTTP 401/)
  assert.match(output, /"codes":\["300"\]/)
  assert.match(output, /mesmo ambiente/)
  assert.match(output, /"tokenValid":true,"testUser":true,"accountSite":"MLB","payerIsSeller":true/)
  assert.match(output, new RegExp(requestId))
  for (const secret of ['private-token', 'card-token', 'payer@example.test', '00000000000', 'seller@example.test', 'Seller@Example.test']) {
    assert.equal(output.includes(secret), false)
  }
})

test('gateway preserva classificação de falhas com respostas inesperadas e omite conteúdo desconhecido', async (t) => {
  const logs = []
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')))
  for (const [status, body, definitive] of [
    [401, '<html>private-token</html>', true],
    [403, JSON.stringify({ error: 'PA_UNAUTHORIZED_RESULT_FROM_POLICIES', cause: null }), true],
    [429, 'null', false],
    [503, JSON.stringify({ message: 'private-token', cause: { code: 'private-token' } }), false],
  ]) {
    const gateway = createGateway('private-token', 'https://example.test/webhook', async () =>
      new Response(body, { status, headers: { 'x-request-id': 'private-token' } }))
    await assert.rejects(gateway.find(randomUUID()), (error) => {
      assert.equal(error.status, 502)
      assert.equal(error.definitive, definitive)
      return true
    })
  }
  const output = logs.join('\n')
  assert.match(output, /Não foi possível ler o JSON/)
  assert.match(output, /política do Mercado Pago/)
  assert.match(output, /Motivo não reconhecido/)
  assert.match(output, /"tokenValid":false/)
  assert.equal(output.includes('private-token'), false)
})

test('o mesmo UUID enviado a instâncias distintas não cria duas cobranças', async (t) => {
    const { store, reopen } = await fixture(t)
    let calls = 0
    let payment
    const gateway = {
      async create(donation) {
        calls++
        payment = paymentFor(donation)
        return payment
      },
      async get() { return payment },
      async find() { return payment },
    }
    const input = { id: randomUUID(), itemId: 1, amount: 25, form: {} }
    const services = [createPaymentService(store, gateway), createPaymentService(await reopen(), gateway)]
    await Promise.all(services.map((service) => service.create(input)))
    assert.equal(calls, 1)
    assert.equal((await store.read()).donations.length, 1)
    assert.equal((await store.read()).items[0].donatedValue, 125)
    await assert.rejects(services[1].create({ ...input, itemId: 2 }), /já está associada/)
})

test('webhooks concorrentes contabilizam uma vez e respostas antigas não desfazem estornos', async (t) => {
    const { store, reopen } = await fixture(t)
    let payment
    const service = createPaymentService(store, {
      async create(donation) { payment = paymentFor(donation, { status: 'pending' }); return payment },
    })
    const other = createPaymentService(await reopen(), {})
    await service.create({ id: randomUUID(), itemId: 1, amount: 100, form: {} })
    const approved = { ...payment, status: 'approved', date_last_updated: '2026-01-02T12:00:00.000Z' }
    await Promise.all([service.applyPayment(approved), other.applyPayment(approved)])
    assert.equal((await store.read()).items[0].donatedValue, 200)
    await other.applyPayment({ ...approved, status: 'refunded', date_last_updated: '2026-01-03T12:00:00.000Z' })
    await service.applyPayment(approved)
    assert.equal((await store.read()).items[0].donatedValue, 100)
    assert.equal((await store.findDonation(payment.external_reference)).status, 'refunded')
})

test('reconciliação trabalha em lotes e avança sem abandonar pagamentos antigos', async (t) => {
    const { store } = await fixture(t)
    const visited = []
    for (let index = 0; index < 7; index++) {
      await store.update(1, (db) => db.donations.push({
        id: randomUUID(), itemId: 1, amount: 1, status: 'creating', creditedCents: 0,
        createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      }))
    }
    const service = createPaymentService(store, { async find(id) { visited.push(id); return undefined } })
    assert.deepEqual(await service.reconcileBatch(), { checked: 5, failed: 0 })
    assert.deepEqual(await service.reconcileBatch(), { checked: 5, failed: 0 })
    assert.equal(new Set(visited).size, 7)
    assert.equal((await store.read()).donations.length, 7)
})
