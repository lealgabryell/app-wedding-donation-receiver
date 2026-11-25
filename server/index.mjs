import express from 'express'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createStore } from './store.mjs'
import { createGateway, createPaymentService } from './payments.mjs'
import { createApp, errorHandler } from './app.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const config = {
  publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY ?? '',
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN ?? '',
  webhookSecret: process.env.MERCADO_PAGO_WEBHOOK_SECRET ?? '',
  notificationUrl: process.env.MERCADO_PAGO_NOTIFICATION_URL ?? '',
  origin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
}
if (config.notificationUrl && !config.notificationUrl.startsWith('https://')) {
  throw new Error('MERCADO_PAGO_NOTIFICATION_URL deve ser uma URL pública HTTPS.')
}
const store = await createStore(
  process.env.DATA_FILE || resolve(root, 'data', 'wedding.json'),
  resolve(root, 'data', 'seed.json'),
)
const gateway = createGateway(config.accessToken, config.notificationUrl)
const service = createPaymentService(store, gateway)
const app = createApp({ store, service, gateway, config })
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endereço não encontrado.' }))
app.use(express.static(resolve(root, 'dist')))
app.get('/{*path}', (_req, res) => res.sendFile(resolve(root, 'dist', 'index.html')))
app.use(errorHandler)

// Webhooks are primary; reconciliation also recovers interrupted requests and server downtime.
let reconciling = false
const timer = setInterval(async () => {
  if (reconciling || !config.accessToken) return
  reconciling = true
  try {
    for (const donation of store.read().donations) {
      if (!['rejected', 'cancelled', 'refunded', 'charged_back'].includes(donation.status)) {
        try {
          await service.reconcile(donation.id)
        } catch (error) {
          console.error('Falha ao reconciliar doação:', donation.id, error.message)
        }
      }
    }
  } finally {
    reconciling = false
  }
}, 60000)
timer.unref()

const server = app.listen(Number(process.env.PORT || 3001), process.env.HOST || '127.0.0.1', () => {
  console.log(`API disponível na porta ${process.env.PORT || 3001}. Pagamentos ${config.accessToken ? 'configurados' : 'desabilitados: configure o .env'}.`)
})
function shutdown() {
  clearInterval(timer)
  server.close()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
