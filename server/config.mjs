import { MongoClient } from 'mongodb'

export function databaseConfig(env = process.env) {
  if (!/^mongodb(\+srv)?:\/\//.test(env.MONGODB_URI ?? '')) {
    throw new Error('Configure MONGODB_URI no .env ou nas variáveis do servidor.')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(env.MONGODB_DB ?? '')) {
    throw new Error('Configure MONGODB_DB com o nome do banco (letras, números, _ ou -).')
  }
  return { uri: env.MONGODB_URI, database: env.MONGODB_DB }
}

export async function connectDatabase(env = process.env) {
  const { uri, database } = databaseConfig(env)
  const client = new MongoClient(uri, { maxPoolSize: 5, maxIdleTimeMS: 60000, serverSelectionTimeoutMS: 5000 })
  try {
    await client.connect()
    return { client, db: client.db(database) }
  } catch (error) {
    await client.close()
    throw error
  }
}

export function paymentConfig(env = process.env) {
  const vercel = env.VERCEL === '1'
  const origin = env.APP_ORIGIN || (vercel ? '' : 'http://localhost:5173')
  let url
  try { url = new URL(origin) } catch { throw new Error('Configure APP_ORIGIN com a origem do frontend.') }
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || (vercel && url.protocol !== 'https:')) {
    throw new Error('APP_ORIGIN deve ser uma origem válida, sem caminho ou barra final; na Vercel, use HTTPS.')
  }
  const notificationUrl = env.MERCADO_PAGO_NOTIFICATION_URL ?? ''
  if (notificationUrl) {
    let notification
    try { notification = new URL(notificationUrl) } catch { throw new Error('MERCADO_PAGO_NOTIFICATION_URL inválida.') }
    if (notification.protocol !== 'https:' || notification.username || notification.password) {
      throw new Error('MERCADO_PAGO_NOTIFICATION_URL deve ser uma URL pública HTTPS.')
    }
  }
  return {
    publicKey: env.MERCADO_PAGO_PUBLIC_KEY ?? '',
    accessToken: env.MERCADO_PAGO_ACCESS_TOKEN ?? '',
    webhookSecret: env.MERCADO_PAGO_WEBHOOK_SECRET ?? '',
    notificationUrl, origin, cronSecret: env.CRON_SECRET ?? '', vercel,
  }
}
