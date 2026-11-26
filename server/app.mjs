import express from 'express'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { AppError } from './errors.mjs'
import { publicItems } from './payments.mjs'
import { paymentMethodTypes, verifySignature } from './mercadopago.mjs'

const MAX_INSTALLMENTS = 6

const submissionSchema = z.object({
  id: z.uuid(),
  itemId: z.number().int().positive(),
  amount: z.number().min(1).max(1000000).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001),
  paymentType: z.enum(Object.keys(paymentMethodTypes)),
  form: z.object({
    payment_method_id: z.string().min(1).max(100),
    token: z.string().max(512).optional(),
    installments: z.number().int().min(1).max(MAX_INSTALLMENTS).optional(),
    payer: z.object({
      email: z.email().max(254),
      first_name: z.string().max(100).optional(),
      last_name: z.string().max(100).optional(),
      identification: z.object({ type: z.string().max(20), number: z.string().max(30) }).optional(),
    }),
  }),
}).refine(({ paymentType, form }) => paymentType === 'bank_transfer'
  ? form.payment_method_id === 'pix' && !form.token
  : Boolean(form.token))
  // Only credit cards may be split into installments.
  .refine(({ paymentType, form }) => (form.installments ?? 1) === 1 || paymentMethodTypes[paymentType] === 'credit_card')

const publicDonation = (donation) => ({
  id: donation.id,
  itemId: donation.itemId,
  amount: donation.amount,
  status: donation.status,
  ...(donation.pix ? { pix: donation.pix } : {}),
  ...(donation.statusDetail ? { statusDetail: donation.statusDetail } : {}),
})

export function createApp({ store, service, gateway, config, rateLimitStore }) {
  const paymentsEnabled = Boolean(config.publicKey && config.accessToken && config.webhookSecret)
  const app = express()
  app.disable('x-powered-by')
  if (config.vercel) app.set('trust proxy', 1)
  // Bricks loads its own scripts and payment frames. Do not block them with Helmet's default CSP.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))
  app.use(express.json({ limit: '20kb' }))
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  app.get('/api/config', (_req, res) => res.json({ publicKey: config.publicKey, paymentsEnabled }))
  app.get('/api/items', async (_req, res) => res.json(publicItems(await store.read())))

  app.post('/api/donations', rateLimit({
    windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    store: rateLimitStore?.('create'),
    message: { error: 'Muitas tentativas. Aguarde um minuto antes de tentar novamente.', donationRecorded: false },
  }), async (req, res) => {
    if (req.get('origin') !== config.origin) throw new AppError(403, 'Origem da requisição não autorizada.')
    if (!paymentsEnabled) {
      throw new AppError(503, 'As doações ainda não foram habilitadas pelos organizadores.')
    }
    const parsed = submissionSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, 'Confira o valor e os dados de pagamento informados.')
    const { paymentType, form, ...donation } = parsed.data
    res.json(publicDonation(await service.create({ ...donation, checkout: { paymentType, form } })))
  })

  app.get('/api/donations/:id', rateLimit({
    windowMs: 60000, limit: 90, legacyHeaders: false, standardHeaders: 'draft-8',
    store: rateLimitStore?.('status'),
    message: { error: 'Muitas consultas. Aguarde um minuto.' },
  }), async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) throw new AppError(400, 'Identificador de doação inválido.')
    res.json(publicDonation(await service.reconcile(req.params.id)))
  })

  app.post('/api/webhooks/mercadopago', async (req, res) => {
    const dataId = req.query['data.id']
    if (typeof dataId !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(dataId) || !verifySignature({
      signature: req.get('x-signature'), requestId: req.get('x-request-id'),
      dataId, secret: config.webhookSecret,
    })) throw new AppError(401, 'Notificação não autenticada.')
    if (req.body?.type !== 'order') throw new AppError(400, 'Tipo de notificação não suportado.')
    await service.applyPayment(await gateway.get(dataId))
    res.sendStatus(200)
  })

  app.get('/api/cron/reconcile', async (req, res) => {
    if (!config.cronSecret) throw new AppError(503, 'A reconciliação agendada não foi configurada.')
    const expected = Buffer.from(`Bearer ${config.cronSecret}`)
    const supplied = Buffer.from(req.get('authorization') ?? '')
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      throw new AppError(401, 'Agendamento não autenticado.')
    }
    if (!config.accessToken) throw new AppError(503, 'O acesso ao provedor de pagamentos não foi configurado.')
    const result = await service.reconcileBatch()
    res.status(result.failed ? 503 : 200).json(result)
  })

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endereço não encontrado.' }))
  app.use(async (error, req, _res, next) => {
    if (req.method === 'POST' && req.path === '/api/donations') {
      try {
        error.donationRecorded = z.uuid().safeParse(req.body?.id).success
          ? Boolean(await store.findDonation(req.body.id)) : false
      } catch (lookupError) {
        console.error('Falha ao consultar registro da doação:', lookupError.name)
      }
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
