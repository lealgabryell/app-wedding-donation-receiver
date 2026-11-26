import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { after } from 'node:test'
import { MongoClient } from 'mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { createStore, initializeDatabase } from './store.mjs'

let replica
after(async () => { if (replica) await (await replica).stop() })

export async function fixture(t, { initialize = true } = {}) {
  replica ??= MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] })
  const uri = (await replica).getUri()
  const client = await new MongoClient(uri).connect()
  const db = client.db(`wedding_test_${randomUUID().replaceAll('-', '')}`)
  const clients = [client]
  t.after(async () => {
    try { await db.dropDatabase() }
    finally { await Promise.all(clients.map((entry) => entry.close())) }
  })
  // Pin item 1 to a known baseline so edits to the real catalog do not break tests.
  const catalog = JSON.parse(await readFile(new URL('../data/seed.json', import.meta.url), 'utf8'))
  Object.assign(catalog.items[0], { totalPrice: 1000, donatedValue: 100, remainingValue: 900 })
  if (initialize) await initializeDatabase(client, db, catalog)
  return {
    store: initialize ? await createStore(client, db) : null,
    client, db, catalog, uri,
    async reopen() {
      const other = await new MongoClient(uri).connect()
      clients.push(other)
      return createStore(other, other.db(db.databaseName))
    },
  }
}

// Domain-level PaymentSnapshot, as returned by any gateway.
export function snapshotFor(donation, overrides = {}) {
  return {
    id: 'ORD01TEST', status: 'approved', currency: 'BRL', reference: donation.id,
    amount: donation.amount, refundedAmount: 0, updatedAt: '2026-01-01T12:00:00.000Z', ...overrides,
  }
}

// Raw Mercado Pago Orders API payload.
export function orderFor(donation, overrides = {}) {
  const amount = donation.amount.toFixed(2)
  return {
    id: 'ORD01TEST', type: 'online', external_reference: donation.id, total_amount: amount,
    total_paid_amount: amount, country_code: 'BRA', status: 'processed', status_detail: 'accredited',
    created_date: '2026-01-01T12:00:00.000000000Z', last_updated_date: '2026-01-01T12:00:00.000000000Z',
    transactions: { payments: [{ id: 'PAY01TEST', amount, status: 'processed', payment_method: { id: 'master', type: 'credit_card' } }] },
    ...overrides,
  }
}
