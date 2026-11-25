import express from 'express'
import { fileURLToPath } from 'node:url'
import { createRuntime } from './runtime.mjs'
import { errorHandler } from './app.mjs'

async function start() {
  const root = new URL('../dist/', import.meta.url)
  const runtime = await createRuntime()
  runtime.app.use(express.static(fileURLToPath(root)))
  runtime.app.get('/{*path}', (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', root))))
  runtime.app.use(errorHandler)

  let reconciling = false
  const timer = setInterval(async () => {
    if (reconciling || !runtime.config.accessToken) return
    reconciling = true
    try {
      await runtime.service.reconcileBatch()
    } catch (error) {
      console.error('Falha na reconciliação local:', error.name)
    } finally {
      reconciling = false
    }
  }, 60000)
  timer.unref()

  const server = runtime.app.listen(Number(process.env.PORT || 3001), process.env.HOST || '127.0.0.1', () => {
    console.log(`API disponível na porta ${server.address().port}. Pagamentos ${runtime.config.accessToken ? 'configurados' : 'desabilitados: configure o .env'}.`)
  })
  function shutdown() {
    clearInterval(timer)
    server.close(() => {
      void runtime.close().catch((error) => {
        console.error('Falha ao encerrar conexão:', error.name)
        process.exitCode = 1
      })
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

start().catch((error) => {
  console.error('Falha ao iniciar servidor:', error.name, 'Confira as variáveis de ambiente, o acesso ao MongoDB e npm run db:init.')
  process.exitCode = 1
})
