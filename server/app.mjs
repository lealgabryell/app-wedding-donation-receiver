import express from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { AppError, publicItems, verifySignature } from './payments.mjs'

const submissionSchema = z.object({
  id: z.uuid(),
  itemId: z.number().int().positive(),
  amount: z.number().min(1).max(1000000).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001),
  form: z.object({
    payment_method_id: z.string().min(1).max(100),
    token: z.string().max(512).optional(),
    installments: z.number().int().min(1).max(12).optional(),
    issuer_id: z.union([z.string().max(30), z.number()]).optional(),
    payer: z.object({
      email: z.email().max(254),
      first_name: z.string().max(100).optional(),
      last_name: z.string().max(100).optional(),
      identification: z.object({ type: z.string().max(20), number: z.string().max(30) }).optional(),
    }),
  }),
})

const publicDonation = (donation) => ({
  id: donation.id,
  itemId: donation.itemId,
  amount: donation.amount,
  status: donation.status,
  paymentId: donation.paymentId,
})

export function createApp({ store, service, gateway, config }) {
  const app = express()
  app.disable('x-powered-by')
  // Bricks loads its own scripts and payment frames. Do not block them with Helmet's default CSP.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))
  app.use(express.json({ limit: '20kb' }))
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  app.get('/api/config', (_req, res) => res.json({
    publicKey: config.publicKey,
    paymentsEnabled: Boolean(config.publicKey && config.accessToken && config.webhookSecret && config.notificationUrl),
  }))
  app.get('/api/items', (_req, res) => res.json(publicItems(store.read())))

  app.post('/api/donations', rateLimit({
    windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Muitas tentativas. Aguarde um minuto antes de tentar novamente.', donationRecorded: false },
  }), async (req, res) => {
    if (req.get('origin') !== config.origin) throw new AppError(403, 'Origem da requisição não autorizada.')
    if (!config.publicKey || !config.accessToken || !config.webhookSecret || !config.notificationUrl) {
      throw new AppError(503, 'As doações ainda não foram habilitadas pelos organizadores.')
    }
    const parsed = submissionSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, 'Confira o valor e os dados de pagamento informados.')
    res.json(publicDonation(await service.create(parsed.data)))
  })

  app.get('/api/donations/:id', rateLimit({
    windowMs: 60000, limit: 90, legacyHeaders: false, standardHeaders: 'draft-8',
    message: { error: 'Muitas consultas. Aguarde um minuto.' },
  }), async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) throw new AppError(400, 'Identificador de doação inválido.')
    res.json(publicDonation(await service.reconcile(req.params.id)))
  })

  app.post('/api/webhooks/mercadopago', async (req, res) => {
    const dataId = req.query['data.id']
    if (typeof dataId !== 'string' || !/^\d+$/.test(dataId) || !verifySignature({
      signature: req.get('x-signature'), requestId: req.get('x-request-id'),
      dataId, secret: config.webhookSecret,
    })) throw new AppError(401, 'Notificação não autenticada.')
    if (req.body.type !== 'payment') throw new AppError(400, 'Tipo de notificação não suportado.')
    await service.applyPayment(await gateway.get(dataId))
    res.sendStatus(200)
  })

  app.use((error, req, _res, next) => {
    if (req.method === 'POST' && req.path === '/api/donations') {
      error.donationRecorded = store.read().donations.some((donation) => donation.id === req.body?.id)
    }
    next(error)
  })
  return app
}

export function errorHandler(error, _req, res, _next) {
  const status = error instanceof AppError ? error.status : error.status === 400 ? 400 : 500
  console.error('Erro na API:', error instanceof AppError ? error.message : error.name)
  res.status(status).json({
    error: error instanceof AppError ? error.message : status === 400 ? 'Requisição inválida.' : 'Não foi possível concluir. Tente novamente em instantes.',
    ...(typeof error.donationRecorded === 'boolean' ? { donationRecorded: error.donationRecorded } : {}),
  })
}
