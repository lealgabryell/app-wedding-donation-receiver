export class MongoRateLimitStore {
  localKeys = false

  constructor(collection, prefix) {
    this.collection = collection
    this.prefix = prefix
  }

  init({ windowMs }) {
    this.windowMs = windowMs
  }

  async increment(key) {
    const now = new Date()
    const expired = { $lte: [{ $ifNull: ['$expiresAt', new Date(0)] }, now] }
    const update = [{ $set: {
      count: { $cond: [expired, 1, { $add: ['$count', 1] }] },
      expiresAt: { $cond: [expired, new Date(now.getTime() + this.windowMs), '$expiresAt'] },
    } }]
    let result
    try {
      result = await this.collection.findOneAndUpdate({ _id: `${this.prefix}:${key}` }, update, {
        upsert: true, returnDocument: 'after',
      })
    } catch (error) {
      if (error.code !== 11000) throw error
      result = await this.collection.findOneAndUpdate({ _id: `${this.prefix}:${key}` }, update, { returnDocument: 'after' })
    }
    if (!result) throw new Error('Não foi possível registrar o limite de requisições.')
    return { totalHits: result.count, resetTime: result.expiresAt }
  }

  async decrement(key) {
    await this.collection.updateOne({ _id: `${this.prefix}:${key}` }, [
      { $set: { count: { $max: [0, { $subtract: ['$count', 1] }] } } },
    ])
  }

  async resetKey(key) {
    await this.collection.deleteOne({ _id: `${this.prefix}:${key}` })
  }
}
