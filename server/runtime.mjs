import { connectDatabase, paymentConfig } from './config.mjs'
import { createStore } from './store.mjs'
import { createGateway, createPaymentService } from './payments.mjs'
import { createApp } from './app.mjs'
import { MongoRateLimitStore } from './rate-limit.mjs'

export async function createRuntime(env = process.env) {
  const config = paymentConfig(env)
  const { client, db } = await connectDatabase(env)
  try {
    const store = await createStore(client, db)
    const gateway = createGateway(config.accessToken, config.notificationUrl)
    const service = createPaymentService(store, gateway)
    const app = createApp({
      store, gateway, service, config,
      rateLimitStore: (prefix) => new MongoRateLimitStore(db.collection('rateLimits'), prefix),
    })
    return { app, store, service, config, close: () => client.close() }
  } catch (error) {
    await client.close()
    throw error
  }
}
