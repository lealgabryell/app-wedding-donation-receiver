# Nosso sim — Lista de presentes

React + Vite + TypeScript, API Express e MongoDB. O convidado escolhe um presente,
informa o valor e paga pelo **Payment Brick oficial do Mercado Pago** (Pix e
cartões, conforme habilitados na conta). Não há login nem pagamento simulado.

## Arquitetura e ciclo de execução

```text
Navegador
  └── Mesmo domínio na Vercel
        ├── /                  → frontend estático em dist
        ├── /images/*          → imagens públicas
        └── /api/*             → api/index.js → Express
                                      ├── MongoDB Atlas
                                      └── Mercado Pago
Mercado Pago → POST /api/webhooks/mercadopago
Vercel Cron → GET /api/cron/reconcile (autenticado)
```

**Um repositório, um projeto Vercel e um banco Atlas.** Na Vercel não se executa
`npm start`: a plataforma inicia a função da API quando chega uma requisição,
incluindo webhooks e agendamentos. O frontend não precisa iniciar o backend.
A conexão MongoDB é reutilizada enquanto a instância estiver ativa; novas
instâncias têm seus próprios pools, limitados a cinco conexões cada.

- `api/index.js`: entrada serverless, sem `listen`, timer ou escrita em disco.
- `server/handler.mjs`: inicialização sob demanda compartilhada entre requisições;
  devolve JSON com HTTP 503 se a inicialização falhar e permite tentar novamente.
- `server/runtime.mjs`: monta conexão, persistência, pagamentos e rotas.
- `server/app.mjs`: contratos HTTP, validação, origem, assinatura e erros.
- `server/store.mjs`: transações MongoDB e importação inicial.
- `server/model.mjs`: validação do catálogo e histórico persistidos.
- `server/payments.mjs`: reservas, idempotência, confirmação e estornos.
- `server/index.mjs`: servidor local com frontend compilado e timer de recuperação.
- `vercel.json`: build Vite, função Node, encaminhamento de `/api/*` e cron.

## 1. Preparar o MongoDB Atlas

1. Crie um cluster no [MongoDB Atlas](https://www.mongodb.com/products/platform/atlas-database).
   Escolha uma região próxima à função da Vercel para reduzir latência.
2. Em **Database Access**, crie um usuário exclusivo da aplicação, com permissão
   `readWrite` somente no banco escolhido, por exemplo `wedding`. Não use a senha
   da sua conta Atlas como senha desse usuário.
3. Em **Network Access**, autorize a rede de desenvolvimento e a saída da Vercel.
   Prefira IPs de saída fixos quando disponíveis no plano. Permitir
   `0.0.0.0/0` facilita conexões serverless sem saída fixa, mas amplia a exposição:
   use TLS, senha forte exclusiva e privilégio mínimo; nunca permita usuário
   sem autenticação. Revise essa decisão antes de receber pagamentos.
4. Em **Connect → Drivers**, copie a URI `mongodb+srv://...`. Codifique caracteres
   especiais da senha conforme as instruções do Atlas; não publique essa URI.
5. Configure as variáveis abaixo e execute a carga inicial **uma única vez**.

**Transações são obrigatórias:** use Atlas ou MongoDB local configurado como
replica set. Um MongoDB standalone não é compatível. Não há fallback para JSON
ou banco em memória quando a conexão falha.

## 2. Variáveis de ambiente e credenciais

Requer **Node.js 24.x** e npm. Na primeira instalação:

```powershell
npm ci
Copy-Item .env.example .env
```

Se já existe `.env`, **não o sobrescreva**. Acrescente as chaves ausentes e
preserve suas credenciais. O arquivo real é ignorado pelo Git, assim como
`.env.*` e `.vercel`; somente `.env.example`, sem segredos, é versionado.

| Variável | Uso |
| --- | --- |
| `MONGODB_URI` | URI privada do Atlas. Obrigatória no servidor. |
| `MONGODB_DB` | Nome explícito do banco, por exemplo `wedding`. Obrigatório; aceita letras, números, `_` e `-`. |
| `APP_ORIGIN` | Origem exata do frontend, sem barra final. Local: `http://localhost:5173`. Produção: `https://weddinglist-malu-e-gabryell.vercel.app` ou seu domínio próprio. Na Vercel exige HTTPS. |
| `MERCADO_PAGO_PUBLIC_KEY` | Public Key da aplicação Mercado Pago. Única credencial de pagamento exposta pela API pública. |
| `MERCADO_PAGO_ACCESS_TOKEN` | Access Token privado, da mesma aplicação/conta da Public Key. |
| `MERCADO_PAGO_WEBHOOK_SECRET` | Segredo da assinatura configurada no painel Webhooks. |
| `MERCADO_PAGO_NOTIFICATION_URL` | URL pública HTTPS completa terminando em `/api/webhooks/mercadopago`. |
| `CRON_SECRET` | Segredo aleatório exclusivo, com pelo menos 32 caracteres, para autenticar o agendamento. |
| `HOST` / `PORT` | Somente servidor local/tradicional; padrões `127.0.0.1` e `3001`. A Vercel gerencia a escuta. |

Gere `CRON_SECRET` localmente, sem enviar o resultado ao repositório:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Nunca use prefixo `VITE_` para URI, token ou segredos. Variáveis com esse prefixo
podem ir para o JavaScript público. A aplicação lê somente `MONGODB_URI` e
`MONGODB_DB` para o banco; `DB_URL` e `DATA_FILE` não são utilizados.
Não compartilhe `.env`, capturas de tela com segredos ou URLs autenticadas.
Os testes não leem `.env` nem acessam seu Atlas.

## 3. Inicializar ou importar os dados

Preencha o `.env` com o banco de destino antes de executar **uma** destas opções.
Faça backup do JSON antigo e confira se está apontando para o banco correto.

### Novo catálogo

Revise `data/seed.json` (textos, preços, fornecedor, categoria e imagem):

```powershell
npm run db:init
```

O seed contém valores ilustrativos, inclusive uma contribuição já recebida no
primeiro item. Ajuste-os antes de publicar; nenhum valor é zerado automaticamente.
`remainingValue` deve ser igual a `totalPrice - donatedValue`, com no máximo
duas casas decimais.

### Migrar a aplicação existente preservando o histórico

Pare o servidor antigo para não receber escritas durante a transferência:

```powershell
npm run db:init -- --file .\data\wedding.json
```

O formato de entrada continua sendo `{ "items": [...], "donations": [...] }`.
A importação valida todos os dados e grava catálogo e histórico na mesma
transação. Um erro reverte os registros; o processo termina com código diferente
de zero. **Se já há catálogo ou doações no banco, o comando recusa a operação.**
Ele nunca limpa, mescla nem substitui dados existentes.

O comando cria estas coleções e índices:

- `items`: um documento por presente, com `_id` numérico e revisão interna.
- `donations`: um documento por tentativa, com `_id` igual ao UUID (índice único),
  índice por `itemId` e índice para seleção de reconciliações.
- `metadata`: marcador de versão/inicialização do catálogo.
- `rateLimits`: contadores compartilhados por rota/IP, com índice TTL em
  `expiresAt`; os limites reiniciam mesmo antes de o TTL remover o documento.

Não execute a importação durante `build`, cold start ou cada deploy.
Alterar o seed depois da importação não altera o MongoDB. Não existe
sincronização de volta para o JSON nem escrita automática no GitHub.
Para editar o catálogo em uso, faça backup e altere os documentos em `items`
com os mesmos invariantes, sem apagar doações. Prefira fazer isso sem pagamentos
em andamento. Não foi criado endpoint administrativo público de edição.

## 4. Executar e verificar localmente

Depois de configurar e inicializar o banco:

```powershell
npm run dev
```

Abra `http://localhost:5173`. Vite encaminha `/api` para Express na porta 3001.
Sem credenciais de pagamento, a lista funciona e o modal informa que as doações
ainda não estão habilitadas; MongoDB continua obrigatório.

Para executar o frontend compilado e a API juntos em Node:

```powershell
npm run build
npm start
```

Nesse caso abra `http://localhost:3001` e ajuste `APP_ORIGIN` para essa origem.
`npm run preview` serve apenas o frontend: não substitui o servidor da API.

### Testes

```powershell
npm run verify
npm audit
```

`verify` executa, em sequência, `npm test`, `npm run lint` e `npm run build`,
interrompendo no primeiro erro. Cada etapa também pode ser executada sozinha.

Os testes usam o runner nativo do Node, HTTP real e um **MongoDB real temporário
em replica set**, iniciado por `mongodb-memory-server-core`. Não exigem Atlas,
Docker ou credenciais. Na primeira execução dos testes, o pacote baixa o binário
MongoDB; o ambiente de CI precisa permitir esse download ou manter seu cache.
O pacote `core` não baixa o banco durante `npm ci` no deploy.
Cada teste recebe um banco isolado, removido ao final; os processos temporários
também são encerrados.

Apenas a fronteira com Mercado Pago é controlada nos testes de pagamento.
Há cobertura de importação e recusa de sobrescrita, rollback, reconexão,
clientes independentes, saldo concorrente, UUID repetido, webhooks duplicados,
estorno parcial, resposta antiga do provedor, reserva após timeout, origem,
assinatura, limite distribuído, cron autenticado e inicialização serverless.
O build valida TypeScript e compila o frontend.

## 5. Configurar Mercado Pago

1. Crie uma aplicação para Checkout Bricks em
   [Suas integrações](https://www.mercadopago.com.br/developers/panel/app).
2. Primeiro use Public Key e Access Token **de teste** da mesma conta.
3. Configure no painel Webhooks o evento **Pagamentos (`payment`)** e a URL
   pública `/api/webhooks/mercadopago`. Copie o segredo da assinatura para
   `MERCADO_PAGO_WEBHOOK_SECRET` e a URL completa para
   `MERCADO_PAGO_NOTIFICATION_URL`.
4. Em desenvolvimento, use túnel HTTPS para a API e ajuste `APP_ORIGIN` para a
   origem que o navegador efetivamente utiliza.
5. Homologue aprovação, recusa e Pix pendente com as
   [contas e cartões de teste oficiais](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/integration-test).
   Não use cartões reais em testes.
6. Para produção, substitua pelas credenciais produtivas e revise a assinatura
   e os eventos de produção. Não use o mesmo banco em previews e produção.

O Brick coleta/tokeniza os dados de cartão. O servidor recebe o token temporário,
não o número do cartão. E-mail, documento do pagador e token não são persistidos.
Transações reais e carregamento do Brick dependem da conta/credenciais e devem
ser homologados separadamente; testes automatizados não comprovam essa etapa.

## 6. Publicar na Vercel

1. Importe este repositório na Vercel, com **Root Directory na raiz** do projeto.
2. Em **Settings → Environment Variables**, copie os valores do `.env` para
   as chaves de servidor listadas acima. Use o escopo **Production** para o banco
   e credenciais produtivos; para **Preview**, use outro banco e credenciais de teste.
   A Vercel não recebe automaticamente seu `.env` local ignorado pelo Git.
3. Configure `APP_ORIGIN` com o domínio canônico acessado pelos convidados e
   a URL do webhook no mesmo deploy público. Redirecione domínios alternativos
   para o canônico; uma origem diferente não pode criar pagamentos.
4. Inicialize o banco de produção uma única vez, pelo comando local da seção 3,
   com as variáveis do destino correto. Não coloque `db:init` no build.
5. Faça o deploy. `vercel.json` define a sequência:
   **`npm ci` → `npm run build` → publicar `dist` e a função `api/index.js`**.
   Node.js é `24.x`. Não configure `npm start` como comando de build.
6. A primeira chamada a `/api/items` inicializa a API e abre a conexão com Atlas;
   as próximas reutilizam a instância quando possível. Os dados permanecem
   no Atlas mesmo com novos deploys, desligamento ou criação de instâncias.
7. Confira os endpoints abaixo e o painel **Functions/Logs**. Alterar variáveis
   na Vercel exige **novo deploy** para aplicá-las.
8. Configure alertas, acesso à rede, limites de conexão e backup no Atlas.
   Verifique as opções/custos de backup e restauração do seu plano.

Verificação depois do deploy:

```powershell
$base = 'https://weddinglist-malu-e-gabryell.vercel.app'
Invoke-RestMethod "$base/api/items"
Invoke-RestMethod "$base/api/config"
```

Esperado: catálogo com `availableValue` e configuração pública sem tokens.
Não considere a publicação homologada antes de validar também o pagamento
de teste e o webhook no domínio final.

### Endpoints

| Método | Caminho | Contrato |
| --- | --- | --- |
| GET | `/api/items` | Catálogo público com saldo disponível; HTTP 200. |
| GET | `/api/config` | Apenas `publicKey` e `paymentsEnabled`; HTTP 200. |
| POST | `/api/donations` | UUID, `itemId`, valor e dados tokenizados do Brick; exige `Origin` igual a `APP_ORIGIN`. Limite: 10/minuto por IP. |
| GET | `/api/donations/:id` | Consulta/reconcilia uma tentativa por UUID; limite: 90/minuto por IP. |
| POST | `/api/webhooks/mercadopago` | Valida `x-signature`, `x-request-id` e `data.id`, consulta o provedor e aplica o pagamento. |
| GET | `/api/cron/reconcile` | Exige `Authorization: Bearer <CRON_SECRET>`; retorna `{ checked, failed }`, HTTP 503 se houver falha no lote. |

Rotas `/api` desconhecidas retornam HTTP 404 em JSON. Erros de validação,
origem, assinatura, conflito e indisponibilidade usam 400/403/401/409/503.
Nenhum endpoint permite listar o histórico inteiro de doações.
O UUID é um identificador privado de acompanhamento: não o publique.
As respostas da API não são armazenadas em cache.

### Reconciliação e limites do agendamento

Webhooks são o mecanismo principal e funcionam sem convidado conectado.
A página atualiza o catálogo a cada 20 segundos e consulta a doação pendente a
cada 5 segundos. Cada consulta confirma o estado com o Mercado Pago.

Na Vercel não há timer residente. O cron configurado roda **diariamente às
06:00 UTC**, com a precisão permitida pelo plano, e autentica a chamada usando
`CRON_SECRET`. Essa frequência é compatível com Hobby; confirme os limites
vigentes do seu plano. Em servidor Node local há um timer de um minuto.

Cada execução consulta no máximo **cinco tentativas em paralelo**, priorizando
as nunca consultadas e depois as consultadas há mais tempo. Inclui aprovações
para identificar estornos perdidos; exclui recusas/cancelamentos/estornos finais.
Falhas são registradas e retornadas, sem criar novas cobranças nem liberar
reservas ambíguas.

**Limite operacional:** com mais de cinco tentativas elegíveis, são necessárias
várias execuções para percorrer todas. O cron diário é apenas recuperação;
não garante confirmação rápida se webhooks e navegador estiverem indisponíveis.
Para maior volume ou recuperação em minutos, use agendamento mais frequente
permitido pelo plano (por exemplo `*/5 * * * *` em plano compatível), ou um
agendador externo confiável com o mesmo segredo. Monitore falhas e idade das
pendências. Não exponha o segredo em URL nem desabilite sua validação.
Se o deploy tiver proteção de acesso, garanta que o Mercado Pago consiga chamar
o webhook e que o agendador autorizado consiga alcançar a função.

## Consistência, segurança e manutenção

- Toda tentativa é persistida **antes** da cobrança; o UUID é também
  `X-Idempotency-Key` e `external_reference`. Uma repetição não cobra novamente.
- Reservas e créditos são transacionais. A revisão do presente é atualizada
  mesmo numa reserva sem crédito: instâncias concorrentes disputam a mesma
  escrita e o MongoDB repete a transação com um saldo atualizado.
- Chamadas ao Mercado Pago ficam fora da transação, evitando cobrança duplicada
  quando o driver repete uma transação. Itens diferentes podem ser atualizados
  independentemente; doações ficam em documentos separados.
- Só `approved`, confirmado no backend, altera o progresso. Pix pendente reserva
  saldo. Estornos parciais/totais e chargebacks ajustam o crédito sem duplicação.
  A data de atualização do provedor impede que resposta antiga desfaça estado
  mais recente.
- Uma falha de rede **não significa recusa**: mantenha a reserva e consulte o
  andamento antes de pagar novamente. Reservas ambíguas não expiram sozinhas.
- O navegador guarda somente o UUID da última tentativa, para retomada.
  Respostas não JSON geram mensagem legível, sem tratar falha como sucesso.
- Limites por IP são compartilhados no MongoDB. Na Vercel, a API confia em um
  salto de proxy da plataforma; no Node local não confia em cabeçalhos de proxy.
  Não exponha esse modo de confiança por trás de proxies arbitrários.
- O catálogo público usa leitura transacional consistente de itens e reservas.
  Para o baixo volume previsto, prioriza simplicidade; se o histórico crescer
  muito, otimize consultas/agregações e monitore latência antes de ampliar tráfego.
- Não há login administrativo nem API de manutenção pública. Zod valida entrada
  e persistência; Helmet e limite de corpo protegem as rotas. A política CSP
  padrão está desabilitada para não bloquear scripts/frames do Brick: revise uma
  política específica compatível antes de endurecer os cabeçalhos.
- Mantenha backups e teste restauração. Não edite créditos/reservas manualmente
  para “destravar” pagamentos sem conferir o identificador no Mercado Pago.
- Valores exibidos são contribuições brutas; tarifas não são descontadas da barra.

## Diagnóstico rápido

| Sintoma | Verificação |
| --- | --- |
| `/api/items` retorna página 404 em texto | Confirme que o commit contém `api/index.js` e `vercel.json`, que a raiz do projeto está correta e que ocorreu um novo deploy, não somente upload de `dist`. |
| API retorna 503 na primeira chamada | Revise variáveis, usuário/senha, rede Atlas e execução prévia de `db:init`. Veja os logs da função; não publique credenciais para depurar. |
| Transação não suportada | O MongoDB deve estar em replica set; use Atlas ou configure seu ambiente local. |
| HTTP 403 ao doar | O `Origin` do navegador deve coincidir exatamente com `APP_ORIGIN`; faça redeploy após corrigir a variável. |
| Pagamentos desabilitados | Configure as quatro variáveis Mercado Pago e faça redeploy. |
| Cron retorna 401/503 | Confira segredo Bearer, Access Token, proteção do deploy e falhas do provedor/banco nos logs. |
| Alterei o JSON e nada mudou | Após a migração o MongoDB é a fonte de verdade; seed/JSON não sobrescrevem dados automaticamente. |
