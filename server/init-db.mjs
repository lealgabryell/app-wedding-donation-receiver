import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { connectDatabase } from './config.mjs'
import { initializeDatabase } from './store.mjs'

async function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--file')) {
    throw new Error('Uso: npm run db:init -- [--file caminho-do-json]')
  }
  const file = args.length ? resolve(args[1]) : new URL('../data/seed.json', import.meta.url)
  const input = JSON.parse(await readFile(file, 'utf8'))
  const { client, db } = await connectDatabase()
  try {
    await initializeDatabase(client, db, input)
    console.log('Banco inicializado. Novos deploys não sobrescreverão os dados.')
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  // Driver messages may contain connection details. Never print the URI or raw driver errors.
  console.error('Falha ao inicializar o banco:', ['MongoServerError', 'MongoServerSelectionError', 'MongoParseError'].includes(error.name)
    ? `${error.name}. Confira conexão, permissões e dados existentes.`
    : error.name === 'Error' ? error.message : error.name)
  process.exitCode = 1
})
