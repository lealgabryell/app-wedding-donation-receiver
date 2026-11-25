import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createStore } from './store.mjs'
import { fixture } from './test-helpers.mjs'

test('gravações simultâneas são serializadas e sobrevivem à reabertura do arquivo', async (t) => {
  const { store, file, seed } = await fixture(t)
  await Promise.all(Array.from({ length: 10 }, () => store.update((db) => {
    db.items[0].donatedValue += 1
    db.items[0].remainingValue -= 1
  })))
  const reopened = await createStore(file, seed)
  assert.equal(reopened.read().items[0].donatedValue, 110)
  assert.equal(reopened.read().items[0].remainingValue, 890)
})

test('uma atualização inválida não altera o arquivo nem impede a próxima gravação', async (t) => {
  const { store, file, seed } = await fixture(t)
  await assert.rejects(store.update((db) => { db.items[0].remainingValue = -1 }))
  await store.update((db) => {
    db.items[0].donatedValue = 200
    db.items[0].remainingValue = 800
  })
  assert.equal((await createStore(file, seed)).read().items[0].donatedValue, 200)
})

test('arquivo corrompido não é sobrescrito pelo catálogo inicial', async (t) => {
  const { file, seed } = await fixture(t)
  await writeFile(file, '{invalid')
  await assert.rejects(createStore(file, seed), SyntaxError)
})
