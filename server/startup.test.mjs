import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { fixture } from './test-helpers.mjs'

const execute = promisify(execFile)

test('sequência real de CLI inicializa uma vez e servidor publica a API com catálogo persistido', async (t) => {
  const { uri, db, catalog } = await fixture(t, { initialize: false })
  const env = {
    ...process.env, MONGODB_URI: uri, MONGODB_DB: db.databaseName,
    HOST: '127.0.0.1', PORT: '0', APP_ORIGIN: 'http://localhost:5173', VERCEL: '0',
    MERCADO_PAGO_PUBLIC_KEY: '', MERCADO_PAGO_ACCESS_TOKEN: '',
    MERCADO_PAGO_WEBHOOK_SECRET: '', MERCADO_PAGO_NOTIFICATION_URL: '', CRON_SECRET: '',
  }
  const args = ['--env-file-if-exists=.env', 'server/init-db.mjs']
  const initialized = await execute(process.execPath, args, { env })
  assert.match(initialized.stdout, /Banco inicializado/)
  await assert.rejects(execute(process.execPath, args, { env }), (error) =>
    error.code === 1 && /já contém dados/.test(error.stderr))

  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.mjs'], { env })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill()
      await once(child, 'exit')
    }
  })
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Servidor não iniciou em 20 segundos.')), 20000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Servidor encerrou antes da verificação: ${code}`)) })
    child.stdout.on('data', (data) => {
      const match = data.toString().match(/porta (\d+)/)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
  })
  const base = `http://127.0.0.1:${port}`
  const items = await (await fetch(`${base}/api/items`)).json()
  assert.equal(items.length, catalog.items.length)
  assert.equal(items[0].itemName, catalog.items[0].itemName)
  const config = await (await fetch(`${base}/api/config`)).json()
  assert.equal(config.paymentsEnabled, false)
  assert.equal((await fetch(`${base}/api/unknown`)).status, 404)
})
