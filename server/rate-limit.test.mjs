import test from 'node:test'
import assert from 'node:assert/strict'
import { MongoRateLimitStore } from './rate-limit.mjs'
import { fixture } from './test-helpers.mjs'

test('limites são compartilhados entre instâncias, isolados por rota e reiniciam sem depender do TTL', async (t) => {
  const { db } = await fixture(t)
  const collection = db.collection('rateLimits')
  const stores = [new MongoRateLimitStore(collection, 'create'), new MongoRateLimitStore(collection, 'create')]
  stores.forEach((store) => store.init({ windowMs: 60000 }))
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => stores[index % 2].increment('client')))
  assert.equal(Math.max(...results.map((result) => result.totalHits)), 20)
  const other = new MongoRateLimitStore(collection, 'status')
  other.init({ windowMs: 60000 })
  assert.equal((await other.increment('client')).totalHits, 1)
  await collection.updateOne({ _id: 'create:client' }, { $set: { expiresAt: new Date(0) } })
  assert.equal((await stores[0].increment('client')).totalHits, 1)
  await stores[1].resetKey('client')
  assert.equal((await stores[0].increment('client')).totalHits, 1)
})
