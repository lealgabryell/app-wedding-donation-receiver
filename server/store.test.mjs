import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createStore, initializeDatabase } from './store.mjs'
import { fixture } from './test-helpers.mjs'

test('gravações em clientes independentes são atômicas e sobrevivem à reconexão', async (t) => {
  const { store, reopen } = await fixture(t)
  const other = await reopen()
  await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? store : other).update(1, (db) => {
    db.items[0].donatedValue += 1
    db.items[0].remainingValue -= 1
  })))
  const reopened = await reopen()
  const item = (await reopened.read()).items[0]
  assert.equal(item.donatedValue, 110)
  assert.equal(item.remainingValue, 890)
})

test('uma atualização inválida reverte a transação e não impede a próxima gravação', async (t) => {
  const { store, reopen } = await fixture(t)
  await assert.rejects(store.update(1, (db) => { db.items[0].remainingValue = -1 }))
  assert.equal((await (await reopen()).read()).items[0].remainingValue, 900)
  await store.update(1, (db) => {
    db.items[0].donatedValue = 200
    db.items[0].remainingValue = 800
  })
  assert.equal((await (await reopen()).read()).items[0].donatedValue, 200)
})

test('inicialização é explícita, importa histórico e nunca sobrescreve dados existentes', async (t) => {
  const { client, db, catalog } = await fixture(t, { initialize: false })
  await assert.rejects(createStore(client, db), /não inicializado/)
  const imported = { ...catalog, donations: [{
    id: randomUUID(), itemId: 1, amount: 10, status: 'pending', creditedCents: 0,
    createdAt: new Date().toISOString(),
  }] }
  await initializeDatabase(client, db, imported)
  const store = await createStore(client, db)
  assert.equal((await store.read()).donations.length, 1)
  await assert.rejects(initializeDatabase(client, db, catalog), /já contém dados/)
  assert.deepEqual(await store.read(), imported)
  assert.equal(await db.collection('rateLimits').indexExists('expiresAt_1'), true)
})

test('importação inválida não deixa um catálogo parcial', async (t) => {
  const { client, db, catalog } = await fixture(t, { initialize: false })
  catalog.items[0].remainingValue = -1
  await assert.rejects(initializeDatabase(client, db, catalog))
  assert.equal(await db.collection('items').countDocuments(), 0)
  assert.equal(await db.collection('metadata').countDocuments(), 0)
})

test('falha de unicidade reverte o saldo e todas as escritas da transação', async (t) => {
  const { store } = await fixture(t)
  const id = randomUUID()
  const donation = { id, itemId: 1, amount: 10, status: 'pending', creditedCents: 0, createdAt: new Date().toISOString() }
  await store.update(1, (db) => db.donations.push(donation))
  await assert.rejects(store.update(2, (db) => {
    db.items[0].donatedValue += 10
    db.items[0].remainingValue -= 10
    db.donations.push({ ...donation, itemId: 2 })
  }), { code: 11000 })
  const state = await store.read()
  assert.equal(state.items[1].donatedValue, 0)
  assert.equal(state.donations.length, 1)
})
