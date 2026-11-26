import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import { createHandler } from './handler.mjs'
import { createRuntime } from './runtime.mjs'
import { databaseConfig, paymentConfig } from './config.mjs'
import { fixture } from './test-helpers.mjs'

async function serve(t, handler) {
  const app = express()
  app.use(handler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('cold start reutiliza uma inicialização e serve API com MongoDB sem app.listen na função', async (t) => {
  const { uri, db } = await fixture(t)
  let starts = 0
  let runtime
  t.after(async () => { if (runtime) await runtime.close() })
  const url = await serve(t, createHandler(async () => {
    starts++
    runtime = await createRuntime({
      MONGODB_URI: uri, MONGODB_DB: db.databaseName, APP_ORIGIN: 'https://example.test', VERCEL: '1',
    })
    return runtime
  }))
  const results = await Promise.all(Array.from({ length: 5 }, () => fetch(`${url}/api/items`)))
  for (const response of results) {
    assert.equal(response.status, 200)
    const items = await response.json()
    assert.equal(items.length, 6)
    assert.equal(items[0].availableValue, 900)
    assert.equal('_id' in items[0], false)
  }
  assert.equal(starts, 1)
  assert.equal((await fetch(`${url}/api/missing`)).status, 404)
  const config = await (await fetch(`${url}/api/config`)).json()
  assert.deepEqual(config, { publicKey: '', paymentsEnabled: false })
})

test('falha de inicialização retorna JSON sem segredo e permite uma nova tentativa', async (t) => {
  let starts = 0
  const app = express()
  app.get('/api/items', (_req, res) => res.json([]))
  const url = await serve(t, createHandler(async () => {
    starts++
    if (starts === 1) throw new Error('mongodb://username:secret@private-host')
    return { app }
  }))
  const failed = await fetch(`${url}/api/items`)
  assert.equal(failed.status, 503)
  assert.equal(failed.headers.get('cache-control'), 'no-store')
  const body = await failed.text()
  assert.equal(body.includes('secret'), false)
  assert.equal(body.includes('private-host'), false)
  assert.equal(typeof JSON.parse(body).error, 'string')
  assert.equal((await fetch(`${url}/api/items`)).status, 200)
  assert.equal(starts, 2)
})

test('falha de inicialização registra causa acionável no log sem expor URI ou senha', async (t) => {
  const { uri, db } = await fixture(t)
  const logs = []
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')))
  const secretError = Object.assign(new Error('mongodb+srv://username:secret@private-host'), { name: 'MongoServerSelectionError' })
  const authError = Object.assign(new Error('bad auth secret'), { name: 'MongoServerError', code: 8000 })
  const failures = [
    secretError,
    authError,
    () => createRuntime({ MONGODB_URI: uri, MONGODB_DB: `${db.databaseName}-vazio`, APP_ORIGIN: 'https://example.test', VERCEL: '1' }),
    () => createRuntime({ MONGODB_URI: uri, MONGODB_DB: db.databaseName, VERCEL: '1' }),
  ]
  for (const failure of failures) {
    const url = await serve(t, createHandler(async () => { if (typeof failure === 'function') return failure(); throw failure }))
    assert.equal((await fetch(`${url}/api/items`)).status, 503)
  }
  const output = logs.join('\n')
  assert.match(output, /Network Access/)
  assert.match(output, /autenticação recusada/)
  assert.match(output, /Banco não inicializado.*MONGODB_DB/)
  assert.match(output, /APP_ORIGIN/)
  for (const leaked of ['secret', 'private-host', 'username', uri]) assert.equal(output.includes(leaked), false)
})

test('configuração exige MongoDB e origem HTTPS explícita na Vercel, sem expor URI nos erros', () => {
  assert.throws(() => databaseConfig({}), /MONGODB_URI/)
  assert.throws(() => databaseConfig({ MONGODB_URI: 'mongodb://private', MONGODB_DB: 'invalid/name' }), /MONGODB_DB/)
  assert.throws(() => paymentConfig({ VERCEL: '1' }), /APP_ORIGIN.*ausente/)
  assert.throws(() => paymentConfig({ VERCEL: '1', APP_ORIGIN: 'http://example.test' }), /https/)
  assert.throws(() => paymentConfig({ VERCEL: '1', APP_ORIGIN: 'example.test' }), /protocolo/)
  assert.throws(() => paymentConfig({ VERCEL: '1', APP_ORIGIN: '"https://example.test"' }), /aspas/)
  assert.throws(() => paymentConfig({ VERCEL: '1', APP_ORIGIN: 'https://example.test/lista' }), /sem caminho/)
  assert.throws(() => paymentConfig({ VERCEL: '1', APP_ORIGIN: 'https://user:pass@example.test' }), /credenciais/)
  assert.equal(paymentConfig({ VERCEL: '1', APP_ORIGIN: ' https://Example.test/ \n' }).origin, 'https://example.test')
  const pasted = paymentConfig({
    APP_ORIGIN: 'https://example.test', MERCADO_PAGO_ACCESS_TOKEN: ' "APP_USR-token"\n',
    MERCADO_PAGO_PUBLIC_KEY: "'APP_USR-public' ",
  })
  assert.equal(pasted.accessToken, 'APP_USR-token')
  assert.equal(pasted.publicKey, 'APP_USR-public')
})
