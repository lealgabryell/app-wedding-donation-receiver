import { z } from 'zod'

export const cents = (value) => Math.round(value * 100)
const money = z.number().nonnegative().finite().refine((value) =>
  Number.isSafeInteger(cents(value)) && Math.abs(value * 100 - cents(value)) < 0.00001)
const itemSchema = z.object({
  id: z.number().int().positive(),
  itemName: z.string().min(1),
  totalPrice: money.refine((value) => value > 0),
  donatedValue: money,
  remainingValue: money,
  description: z.string(),
  itemProvider: z.string(),
  pictureUrl: z.string(),
  category: z.enum(['Cerimônia', 'Festa']),
}).refine((item) => cents(item.totalPrice) - cents(item.donatedValue) === cents(item.remainingValue))
const pixSchema = z.object({
  qrCode: z.string().min(1).max(1000),
  qrCodeBase64: z.string().max(60000).regex(/^[A-Za-z0-9+/=]+$/).optional(),
  ticketUrl: z.url({ protocol: /^https$/ }).optional(),
  expiresAt: z.iso.datetime().optional(),
})
const donationSchema = z.object({
  id: z.uuid(),
  itemId: z.number().int().positive(),
  amount: money.refine((value) => value >= 1),
  status: z.string(),
  orderId: z.string().max(64).optional(),
  // Legacy Payments API id, kept only for records created before the Orders migration.
  paymentId: z.string().optional(),
  pix: pixSchema.optional(),
  creditedCents: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  paymentUpdatedAt: z.iso.datetime({ offset: true }).optional(),
  lastReconciledAt: z.iso.datetime().optional(),
})

export const databaseSchema = z.object({
  items: z.array(itemSchema),
  donations: z.array(donationSchema),
}).superRefine((db, ctx) => {
  if (new Set(db.items.map((item) => item.id)).size !== db.items.length ||
      new Set(db.donations.map((donation) => donation.id)).size !== db.donations.length ||
      db.donations.some((donation) => !db.items.some((item) => item.id === donation.itemId) ||
        donation.creditedCents > cents(donation.amount))) {
    ctx.addIssue({ code: 'custom', message: 'Identificadores ou créditos inválidos nos dados.' })
  }
})
