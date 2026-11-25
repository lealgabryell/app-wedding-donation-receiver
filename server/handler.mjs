import { createRuntime } from './runtime.mjs'
import { errorHandler } from './app.mjs'

export function createHandler(loadRuntime = createRuntime) {
  let pending
  return async function handler(req, res) {
    try {
      pending ??= loadRuntime().then(({ app }) => {
        app.use(errorHandler)
        return app
      }).catch((error) => {
        pending = undefined
        throw error
      })
      const app = await pending
      app(req, res)
    } catch (error) {
      console.error('Falha ao iniciar API:', error.name)
      res.setHeader('Cache-Control', 'no-store')
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'API indisponível. Verifique a configuração do servidor e do MongoDB.' }))
    }
  }
}

