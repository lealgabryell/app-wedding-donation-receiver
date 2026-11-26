import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createPaymentService, publicItems } from './payments.mjs'
import { createOrdersGateway } from './mercadopago.mjs'
import { fixture, snapshotFor } from './test-helpers.mjs'

test('aprovação atualiza valores em centavos e repetição não contabiliza duas vezes', async (t) => {
  const { store, reopen } = await fixture(t)
  let calls = 0
  let snapshot
  const gateway = {
    async create(donation) { calls++; snapshot = snapshotFor(donation); return snapshot },
    async get() { return snapshot },
  }
  const service = createPaymentService(store, gateway)
  const input = { id: randomUUID(), itemId: 1, amount: 25.37, checkout: {} }
  await service.create(input)
  await service.create(input)
  await service.applyPayment(snapshot)
  const item = (await (await reopen()).read()).items[0]
  assert.equal(calls, 1)
  assert.equal(item.donatedValue, 125.37)
  assert.equal(item.remainingValue, 874.63)
})

test('Pix pendente reserva saldo, guarda o QR code e o descarta após aprovação; estorno reverte', async (t) => {
  const { store } = await fixture(t)
  let snapshot
  const pix = { qrCode: '00020126pix', qrCodeBase64: 'iVBORw0KGgo=' }
  const service = createPaymentService(store, {
    async create(donation) { snapshot = snapshotFor(donation, { status: 'pending', pix }); return snapshot },
    async get() { return snapshot },
  })
  const donation = await service.create({ id: randomUUID(), itemId: 1, amount: 100, checkout: {} })
  assert.deepEqual(donation.pix, pix)
  assert.equal(publicItems(await store.read())[0].availableValue, 800)
  assert.equal((await store.read()).items[0].donatedValue, 100)
  snapshot = { ...snapshot, status: 'approved', pix: undefined }
  const approved = await service.reconcile(donation.id)
  assert.equal(approved.pix, undefined)
  assert.equal((await store.read()).items[0].donatedValue, 200)
  await service.applyPayment({ ...snapshot, status: 'refunded' })
  await service.applyPayment({ ...snapshot, status: 'refunded' })
  assert.equal((await store.read()).items[0].donatedValue, 100)
  assert.equal((await store.read()).items[0].remainingValue, 900)
})

test('doações concorrentes não podem ultrapassar o saldo do presente', async (t) => {
  const { store, reopen } = await fixture(t)
  const gateway = {
    async create(donation) { return snapshotFor(donation, { status: 'pending', id: `ORD${donation.id.slice(0, 8)}` }) },
  }
  const services = [createPaymentService(store, gateway), createPaymentService(await reopen(), gateway)]
  const results = await Promise.allSettled(services.map((service) =>
    service.create({ id: randomUUID(), itemId: 1, amount: 600, checkout: {} })))
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal((await store.read()).donations.length, 1)
  assert.equal(publicItems(await store.read())[0].availableValue, 300)
})

test('estorno parcial reabre somente o valor estornado para novas doações', async (t) => {
  const { store } = await fixture(t)
  let snapshot
  const service = createPaymentService(store, {
    async create(donation) { snapshot = snapshotFor(donation); return snapshot },
  })
  await service.create({ id: randomUUID(), itemId: 1, amount: 100, checkout: {} })
  await service.applyPayment({ ...snapshot, refundedAmount: 25.25 })
  await service.applyPayment({ ...snapshot, refundedAmount: 25.25 })
  assert.equal((await store.read()).items[0].donatedValue, 174.75)
  assert.equal((await store.read()).items[0].remainingValue, 825.25)
  assert.equal(publicItems(await store.read())[0].availableValue, 825.25)
})

test('falha ambígua mantém reserva e recupera o pedido pela busca após reiniciar, sem nova cobrança', async (t) => {
  const { store, reopen } = await fixture(t)
  let recorded
  const input = { id: randomUUID(), itemId: 1, amount: 99, checkout: {} }
  await assert.rejects(createPaymentService(store, {
    async create(donation) { recorded = snapshotFor(donation); throw new Error('timeout') },
  }).create(input), /timeout/)
  assert.equal(publicItems(await store.read())[0].availableValue, 801)
  const reopened = await reopen()
  const searches = []
  const service = createPaymentService(reopened, {
    async find(reference, createdAt) { searches.push({ reference, createdAt }); return recorded },
  })
  await service.create(input)
  assert.equal(searches.length, 1)
  assert.equal(searches[0].reference, input.id)
  assert.ok(Number.isFinite(Date.parse(searches[0].createdAt)))
  assert.equal((await reopened.read()).items[0].donatedValue, 199)
  assert.equal((await reopened.findDonation(input.id)).orderId, recorded.id)
})

test('valores, moeda ou pedido divergentes nunca alteram o saldo', async (t) => {
  const { store } = await fixture(t)
  const service = createPaymentService(store, {
    async create(donation) { return snapshotFor(donation, { amount: 999 }) },
  })
  const id = randomUUID()
  await assert.rejects(service.create({ id, itemId: 1, amount: 20, checkout: {} }), /não correspondem/)
  await assert.rejects(service.applyPayment(snapshotFor({ id, amount: 20 }, { currency: 'USD' })), /não correspondem/)
  await assert.rejects(service.applyPayment(snapshotFor({ id, amount: 20 }, { currency: undefined })), /não correspondem/)
  assert.equal((await store.read()).items[0].donatedValue, 100)
})

test('recusa definitiva libera a reserva, mas erro de rede não gera cobrança automática adicional', async (t) => {
  const { store } = await fixture(t)
  t.mock.method(console, 'error', () => {})
  const gateway = createOrdersGateway('test', async () => new Response('{}', { status: 400 }))
  const service = createPaymentService(store, gateway)
  const id = randomUUID()
  const checkout = { paymentType: 'bank_transfer', form: { payment_method_id: 'pix', payer: { email: 'a@example.test' } } }
  await assert.rejects(service.create({ id, itemId: 1, amount: 10, checkout }))
  assert.equal((await service.reconcile(id)).status, 'rejected')
  assert.equal(publicItems(await store.read())[0].availableValue, 900)
})

test('registros da Payments API não são consultados na Orders API', async (t) => {
  const { store } = await fixture(t)
  const id = randomUUID()
  await store.update(1, (db) => db.donations.push({
    id, itemId: 1, amount: 10, status: 'pending', paymentId: '123456', creditedCents: 0, createdAt: new Date().toISOString(),
  }))
  const service = createPaymentService(store, {
    async get() { throw new Error('não deveria consultar') },
    async find() { throw new Error('não deveria consultar') },
  })
  assert.equal((await service.reconcile(id)).paymentId, '123456')
})

test('o mesmo UUID enviado a instâncias distintas não cria duas cobranças', async (t) => {
  const { store, reopen } = await fixture(t)
  let calls = 0
  let snapshot
  const gateway = {
    async create(donation) {
      calls++
      snapshot = snapshotFor(donation)
      return snapshot
    },
    async get() { return snapshot },
    async find() { return snapshot },
  }
  const input = { id: randomUUID(), itemId: 1, amount: 25, checkout: {} }
  const services = [createPaymentService(store, gateway), createPaymentService(await reopen(), gateway)]
  await Promise.all(services.map((service) => service.create(input)))
  assert.equal(calls, 1)
  assert.equal((await store.read()).donations.length, 1)
  assert.equal((await store.read()).items[0].donatedValue, 125)
  await assert.rejects(services[1].create({ ...input, itemId: 2 }), /já está associada/)
})

test('webhooks concorrentes contabilizam uma vez e respostas antigas não desfazem estornos', async (t) => {
  const { store, reopen } = await fixture(t)
  let snapshot
  const service = createPaymentService(store, {
    async create(donation) { snapshot = snapshotFor(donation, { status: 'pending' }); return snapshot },
  })
  const other = createPaymentService(await reopen(), {})
  await service.create({ id: randomUUID(), itemId: 1, amount: 100, checkout: {} })
  const approved = { ...snapshot, status: 'approved', updatedAt: '2026-01-02T12:00:00.000Z' }
  await Promise.all([service.applyPayment(approved), other.applyPayment(approved)])
  assert.equal((await store.read()).items[0].donatedValue, 200)
  await other.applyPayment({ ...approved, status: 'refunded', updatedAt: '2026-01-03T12:00:00.000Z' })
  await service.applyPayment(approved)
  assert.equal((await store.read()).items[0].donatedValue, 100)
  assert.equal((await store.findDonation(snapshot.reference)).status, 'refunded')
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
