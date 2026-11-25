import { databaseSchema } from './model.mjs'
import { ConfigurationError } from './config.mjs'

const transactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
}
const activeStatuses = { $nin: ['rejected', 'cancelled', 'refunded', 'charged_back'] }

export async function initializeDatabase(client, db, input) {
  const data = databaseSchema.parse(input)
  await db.collection('donations').createIndex({ itemId: 1 })
  await db.collection('donations').createIndex({ lastReconciledAt: 1, createdAt: 1 })
  await db.collection('rateLimits').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  const session = client.startSession()
  try {
    await session.withTransaction(async () => {
      if (await db.collection('metadata').findOne({ _id: 'catalog' }, { session }) ||
          await db.collection('items').findOne({}, { session }) ||
          await db.collection('donations').findOne({}, { session })) {
        throw new Error('O banco já contém dados. A inicialização não sobrescreve o catálogo nem as doações.')
      }
      await db.collection('metadata').insertOne({ _id: 'catalog', version: 1 }, { session })
      if (data.items.length) {
        await db.collection('items').insertMany(data.items.map((item) => ({ _id: item.id, ...item })), { session })
      }
      if (data.donations.length) {
        await db.collection('donations').insertMany(data.donations.map((donation) => ({ _id: donation.id, ...donation })), { session })
      }
    }, transactionOptions)
  } finally {
    await session.endSession()
  }
}

export async function createStore(client, db) {
  const metadata = await db.collection('metadata').findOne({ _id: 'catalog' })
  if (metadata?.version !== 1) {
    throw new ConfigurationError('Banco não inicializado ou versão incompatível. Confira MONGODB_DB e execute npm run db:init.')
  }
  const items = db.collection('items')
  const donations = db.collection('donations')
  async function transaction(action) {
    const session = client.startSession()
    try {
      return await session.withTransaction(() => action(session), transactionOptions)
    } finally {
      await session.endSession()
    }
  }
  return {
    read: () => transaction(async (session) => databaseSchema.parse({
      items: await items.find({}, { session }).sort({ _id: 1 }).toArray(),
      donations: await donations.find({}, { session }).toArray(),
    })),
    async findDonation(id) {
      const donation = await donations.findOne({ _id: id }, { projection: { _id: 0 } })
      return donation ?? null
    },
    update(itemId, change) {
      return transaction(async (session) => {
        const item = await items.findOne({ _id: itemId }, { session })
        const state = databaseSchema.parse({
          items: item ? [item] : [],
          donations: await donations.find({ itemId }, { session }).toArray(),
        })
        const original = new Map(state.donations.map((donation) => [donation.id, JSON.stringify(donation)]))
        // Callbacks must be synchronous and side-effect free: MongoDB can retry a transaction.
        const result = change(state)
        if (result instanceof Promise) throw new TypeError('A atualização deve ser síncrona.')
        const next = databaseSchema.parse(state)
        if (next.items.length !== (item ? 1 : 0) || next.items.some((entry) => entry.id !== itemId) ||
            next.donations.some((entry) => entry.itemId !== itemId) ||
            [...original.keys()].some((id) => !next.donations.some((entry) => entry.id === id))) {
          throw new Error('A atualização não pode remover registros nem alterar outro presente.')
        }
        if (item) {
          // A reservation must write the item too, so competing transactions cannot overspend it.
          await items.updateOne({ _id: itemId }, { $set: next.items[0], $inc: { revision: 1 } }, { session })
        }
        for (const donation of next.donations) {
          if (!original.has(donation.id)) {
            await donations.insertOne({ _id: donation.id, ...donation }, { session })
          } else if (original.get(donation.id) !== JSON.stringify(donation)) {
            await donations.replaceOne({ _id: donation.id }, { _id: donation.id, ...donation }, { session })
          }
        }
        return result
      })
    },
    reconciliationBatch(limit = 5) {
      return donations.find({ status: activeStatuses }, { projection: { _id: 0 } })
        .sort({ lastReconciledAt: 1, createdAt: 1, _id: 1 }).limit(limit).toArray()
    },
    async markReconciled(id) {
      await donations.updateOne({ _id: id }, { $set: { lastReconciledAt: new Date().toISOString() } })
    },
  }
}
