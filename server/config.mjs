import { MongoClient } from 'mongodb'

// Messages of this class never contain configuration values, so they are safe to log.
export class ConfigurationError extends Error {
  name = 'ConfigurationError'
}

const networkErrors = new Set(['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoTopologyClosedError'])

// Driver messages may contain hosts or credentials. Map them to fixed guidance instead of logging them.
export function startupDiagnosis(error) {
  if (error instanceof ConfigurationError) return error.message
  if (networkErrors.has(error?.name)) {
    return `${error.name}: cluster inacessível. Libere a saída da Vercel em Atlas → Network Access e confira o host de MONGODB_URI.`
  }
  if (error?.code === 18 || error?.code === 8000) {
    return `${error.name}: autenticação recusada. Confira usuário e senha de MONGODB_URI; codifique caracteres especiais da senha.`
  }
  if (error?.code === 13) return `${error.name}: usuário sem permissão readWrite no banco MONGODB_DB.`
  if (error?.name === 'MongoParseError' || error?.name === 'MongoInvalidArgumentError' || error?.name === 'MongoAPIError') {
    return `${error.name}: MONGODB_URI inválida. Copie novamente a connection string do Atlas, sem aspas ou espaços.`
  }
  return `${error?.name ?? 'Erro'}${typeof error?.code === 'number' ? ` (código ${error.code})` : ''}: falha inesperada ao iniciar.`
}

export function databaseConfig(env = process.env) {
  if (!/^mongodb(\+srv)?:\/\//.test(env.MONGODB_URI ?? '')) {
    throw new ConfigurationError('Configure MONGODB_URI no .env ou nas variáveis do servidor.')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(env.MONGODB_DB ?? '')) {
    throw new ConfigurationError('Configure MONGODB_DB com o nome do banco (letras, números, _ ou -).')
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
  // Copy/paste often adds spaces or a trailing slash; both are harmless for an origin.
  const raw = (env.APP_ORIGIN ?? '').trim() || (vercel ? '' : 'http://localhost:5173')
  const invalid = (reason) => new ConfigurationError(`APP_ORIGIN inválida: ${reason} Exemplo: https://seu-dominio.vercel.app`)
  if (!raw) throw invalid('variável ausente ou vazia.')
  if (/^["']|["']$/.test(raw)) throw invalid('remova as aspas do valor.')
  let url
  try { url = new URL(raw) } catch { throw invalid('não é uma URL; inclua o protocolo https://.') }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid('use http:// ou https://.')
  if (vercel && url.protocol !== 'https:') throw invalid('na Vercel, use https://.')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw invalid('informe somente protocolo e domínio, sem caminho, parâmetros ou credenciais.')
  }
  const origin = url.origin
  const notificationUrl = env.MERCADO_PAGO_NOTIFICATION_URL ?? ''
  if (notificationUrl) {
    let notification
    try { notification = new URL(notificationUrl) } catch { throw new ConfigurationError('MERCADO_PAGO_NOTIFICATION_URL inválida.') }
    if (notification.protocol !== 'https:' || notification.username || notification.password) {
      throw new ConfigurationError('MERCADO_PAGO_NOTIFICATION_URL deve ser uma URL pública HTTPS.')
    }
  }
  return {
    publicKey: env.MERCADO_PAGO_PUBLIC_KEY ?? '',
    accessToken: env.MERCADO_PAGO_ACCESS_TOKEN ?? '',
    webhookSecret: env.MERCADO_PAGO_WEBHOOK_SECRET ?? '',
    notificationUrl, origin, cronSecret: env.CRON_SECRET ?? '', vercel,
  }
}
