import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
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
const donationSchema = z.object({
  id: z.uuid(),
  itemId: z.number().int(),
  amount: money.refine((value) => value >= 1),
  status: z.string(),
  paymentId: z.string().optional(),
  creditedCents: z.number().int().nonnegative(),
  createdAt: z.string(),
})
const databaseSchema = z.object({
  items: z.array(itemSchema),
  donations: z.array(donationSchema),
}).superRefine((db, ctx) => {
  if (new Set(db.items.map((item) => item.id)).size !== db.items.length ||
      new Set(db.donations.map((donation) => donation.id)).size !== db.donations.length ||
      db.donations.some((donation) => !db.items.some((item) => item.id === donation.itemId))) {
    ctx.addIssue({ code: 'custom', message: 'Identificadores inválidos no arquivo de dados.' })
  }
})

export async function createStore(file, seedFile) {
  await mkdir(dirname(file), { recursive: true })
  let state
  try {
    state = databaseSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = databaseSchema.parse(JSON.parse(await readFile(seedFile, 'utf8')))
    await writeFile(file, JSON.stringify(state, null, 2), { flag: 'wx' })
  }
  let queue = Promise.resolve()
  return {
    read: () => structuredClone(state),
    update(change) {
      const task = queue.then(async () => {
        const next = structuredClone(state)
        const result = await change(next)
        databaseSchema.parse(next)
        const temporary = `${file}.${randomUUID()}.tmp`
        await writeFile(temporary, JSON.stringify(next, null, 2))
        await rename(temporary, file)
        state = next
        return result
      })
      // Keep later writes available; the caller still receives every write error.
      queue = task.catch(() => {})
      return task
    },
  }
}
