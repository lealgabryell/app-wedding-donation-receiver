import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.mjs'

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wedding-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'wedding.json')
  // Pin item 1 to a known baseline so edits to the real catalog do not break tests.
  const catalog = JSON.parse(await readFile(fileURLToPath(new URL('../data/seed.json', import.meta.url)), 'utf8'))
  Object.assign(catalog.items[0], { totalPrice: 1000, donatedValue: 100, remainingValue: 900 })
  const seed = join(directory, 'seed.json')
  await writeFile(seed, JSON.stringify(catalog))
  return { store: await createStore(file, seed), file, seed }
}

export function paymentFor(donation, overrides = {}) {
  return {
    id: '123456', status: 'approved', currency_id: 'BRL',
    external_reference: donation.id, transaction_amount: donation.amount,
    ...overrides,
  }
}
