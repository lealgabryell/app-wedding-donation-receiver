# Nosso sim — Lista de presentes

React + Vite + TypeScript, API Express e MongoDB. O convidado escolhe um presente,
informa o valor e paga pelo **Payment Brick oficial do Mercado Pago** (Pix e
cartões, conforme habilitados na conta). Não há login nem pagamento simulado.

### Uso em dispositivos móveis

A página e o modal usam fontes e espaçamentos fluidos. O campo de valor mantém
teclado decimal e área de toque de pelo menos 44 px; o modal permite rolagem
interna em telas baixas. O viewport solicita redimensionamento ao abrir o teclado
virtual nos navegadores que suportam `interactive-widget=resizes-content`,
sem bloquear o zoom do usuário. Os campos do Mercado Pago usam a personalização
oficial do Brick, com fontes de 16 px e o espaçamento interno padrão do formulário.
Os avisos de erro não ficam sobre os campos na etapa de pagamento, e erros
recuperáveis não fecham o formulário.

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
- `server/payments.mjs`: domínio de reservas, idempotência, confirmação e estornos,
  independente do provedor (trabalha com um `PaymentSnapshot` interno).
- `server/mercadopago.mjs`: camada anticorrupção da **Orders API** do Mercado Pago
  (criação/consulta/busca de pedidos, tradução de status, Pix, assinatura do webhook
  e diagnóstico de erros). Trocar de provedor ou de API afeta somente este arquivo.
- `server/errors.mjs`: `AppError`, erro HTTP compartilhado.
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
| `APP_ORIGIN` | Somente protocolo e domínio do frontend, sem aspas ou caminho. Espaços e uma barra final são ignorados. Local: `http://localhost:5173`. Produção: `https://weddinglist-malu-e-gabryell.vercel.app` ou seu domínio próprio. Na Vercel exige HTTPS. |
| `MERCADO_PAGO_PUBLIC_KEY` | Public Key da aplicação Mercado Pago (Checkout Transparente/Bricks com Orders API). Única credencial de pagamento exposta pela API pública. |
| `MERCADO_PAGO_ACCESS_TOKEN` | Access Token privado, da mesma aplicação/conta da Public Key. A Orders API só aceita credenciais `APP_USR-` (inclusive em testes). |
| `MERCADO_PAGO_WEBHOOK_SECRET` | Segredo da assinatura configurada no painel Webhooks (evento **Order**). |
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

1. Logado como o **usuário vendedor de teste** (Suas integrações → Contas de teste),
   crie uma aplicação de **Checkout Transparente / Checkout Bricks** escolhendo a
   **API de Orders** em [Suas integrações](https://www.mercadopago.com.br/developers/panel/app).
   Aplicações de Checkout Pro não servem para este fluxo.
2. Copie as credenciais **de produção** (`APP_USR-...`) dessa aplicação. A Orders API
   recusa credenciais `TEST-` (`invalid_credentials`); como a conta é de teste, as
   cobranças continuam fictícias. Public Key e Access Token devem ser da mesma aplicação.
3. Em **Webhooks**, configure o evento **Order (Mercado Pago)** com a URL pública
   `https://<seu-domínio>/api/webhooks/mercadopago` (modo de teste e de produção) e
   copie o segredo da assinatura para `MERCADO_PAGO_WEBHOOK_SECRET`. A Orders API não
   aceita URL de notificação por pedido: o webhook é configurado somente no painel.
4. Em desenvolvimento, use túnel HTTPS para a API e ajuste `APP_ORIGIN` para a
   origem que o navegador efetivamente utiliza.
5. Homologue aprovação (titular `APRO`), recusa (titular `OTHE`) e Pix pendente com as
   [contas e cartões de teste oficiais](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/integration-test).
   Use como comprador o e-mail de outro usuário de teste. Não use cartões reais em testes.
6. Para produção real, repita os passos com a conta verdadeira do casal e revise
   a assinatura e os eventos. Não use o mesmo banco em previews e produção.

O Brick coleta/tokeniza os dados de cartão. O servidor recebe o token temporário,
não o número do cartão, e cria um pedido (`POST /v1/orders`) com o meio escolhido.
Para Pix, o QR code e o código copia e cola retornados pelo pedido são exibidos no
modal enquanto o pagamento estiver pendente e descartados quando ele é concluído.
E-mail, documento do pagador e token não são persistidos.
Transações reais e carregamento do Brick dependem da conta/credenciais e devem
ser homologados separadamente; testes automatizados não comprovam essa etapa.
Detalhes da migração: [docs/migracao-orders.md](docs/migracao-orders.md).

## 6. Publicar na Vercel

1. Importe este repositório na Vercel, com **Root Directory na raiz** do projeto.
2. Em **Settings → Environment Variables**, copie os valores do `.env` para
   as chaves de servidor listadas acima. Use o escopo **Production** para o banco
   e credenciais produtivos; para **Preview**, use outro banco e credenciais de teste.
   A Vercel não recebe automaticamente seu `.env` local ignorado pelo Git.
3. Configure `APP_ORIGIN` com o domínio canônico acessado pelos convidados e
   cadastre no painel do Mercado Pago a URL do webhook desse mesmo deploy público. Redirecione domínios alternativos
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
| POST | `/api/donations` | UUID, `itemId`, valor, `paymentType` (`credit_card`, `debit_card`, `prepaid_card` ou `bank_transfer`; as variantes camelCase também são aceitas) e `form` tokenizado do Brick; exige `Origin` igual a `APP_ORIGIN`. Retorna `{ id, itemId, amount, status, pix? }`. Limite: 10/minuto por IP. |
| GET | `/api/donations/:id` | Consulta/reconcilia uma tentativa por UUID; limite: 90/minuto por IP. |
| POST | `/api/webhooks/mercadopago` | Aceita somente `type: "order"`; valida `x-signature`, `x-request-id` e `data.id` (ID do pedido), consulta o pedido e aplica o resultado. |
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
  `X-Idempotency-Key` e `external_reference` do pedido. Uma repetição não cobra
  novamente; se a resposta se perder, o pedido é recuperado pela busca por
  `external_reference` numa janela de até 30 dias a partir da criação.
- Doações antigas criadas pela Payments API (com `paymentId`) são preservadas,
  mas não são reconsultadas pela Orders API.
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
| API retorna 503 na primeira chamada | Abra **Vercel → Logs** e procure `Falha ao iniciar API:`. A linha indica a causa sem expor credenciais: variável ausente/inválida (`MONGODB_URI`, `MONGODB_DB`, `APP_ORIGIN`), cluster inacessível (libere a Vercel em **Atlas → Network Access**), autenticação recusada (usuário/senha da URI) ou banco não inicializado (`MONGODB_DB` diferente do usado no `db:init`). Corrija e faça **redeploy**. |
| Transação não suportada | O MongoDB deve estar em replica set; use Atlas ou configure seu ambiente local. |
| HTTP 403 ao doar | O `Origin` do navegador deve coincidir exatamente com `APP_ORIGIN`; faça redeploy após corrigir a variável. |
| Pagamentos desabilitados | Configure as três variáveis Mercado Pago (Public Key, Access Token e segredo do webhook) e faça redeploy. |
| Log mostra `invalid_credentials` ou orienta usar `APP_USR-` | A Orders API não aceita credenciais `TEST-`. Use as credenciais de produção da aplicação criada pelo usuário vendedor de teste. |
| Log mostra `forbidden` ou HTTP 403 | A aplicação provavelmente não é de Checkout Transparente com Orders API (por exemplo, foi criada para Checkout Pro). Crie a aplicação correta e troque as duas credenciais. |
| Pagamento aprovado no Mercado Pago, mas o site continua pendente | Confira se o webhook está cadastrado com o evento **Order** (não somente `payment`), a URL do domínio canônico e o mesmo segredo de `MERCADO_PAGO_WEBHOOK_SECRET`. A consulta periódica do navegador e o cron também reconciliam o pedido. |
| Doação retorna 502 e o log mostra `Mercado Pago respondeu com HTTP 401` ou `403` | Consulte `error`, `codes`, `diagnosis` e, quando fornecido em formato UUID, `requestId` na mesma linha. O HTTP sozinho não prova que o Access Token esteja errado: pode haver restrição de uso das credenciais, permissões da aplicação ou política da conta. Confira `MERCADO_PAGO_ACCESS_TOKEN` e `MERCADO_PAGO_PUBLIC_KEY` da mesma aplicação e ambiente, no escopo **Production** da Vercel, e faça redeploy após alterações. |
| Diagnóstico menciona que uma das partes é de teste (`Unauthorized use of live credentials`) | Credenciais, e-mail do comprador e cartão estão em ambientes diferentes. Em teste com a Orders API, use as credenciais `APP_USR-` da aplicação do **usuário vendedor de teste**, cartão de teste e, no campo de e-mail do formulário, o e-mail de outro **usuário comprador de teste** (Suas integrações → Contas de teste), nunca um e-mail real. Em produção, use credenciais de produção, cartão e e-mail reais. No 401, o log também informa `tokenValid` (o Access Token foi aceito em `/users/me`), `testUser` (a conta do token é de teste), `accountSite` (país da conta, ex.: `MLB`) e `payerIsSeller` (o e-mail do pagador é o da própria conta vendedora — use outro usuário de teste como comprador). Se esses campos estiverem corretos e o erro persistir, restam duas hipóteses: a `MERCADO_PAGO_PUBLIC_KEY` é de outra conta (Public Key e Access Token devem ser da mesma aplicação do mesmo usuário vendedor de teste) ou a aplicação não tem permissão para processar pagamentos. Confira ambas no painel da aplicação e, se persistir, envie o `requestId` ao suporte do Mercado Pago. |
| Resposta de erro contém `donationRecorded: true` | A tentativa foi persistida no banco; isso não significa pagamento criado ou aprovado. Uma recusa definitiva libera a reserva e registra a tentativa como `rejected`; falhas ambíguas mantêm acompanhamento para evitar cobranças duplicadas. |
| Cron retorna 401/503 | Confira segredo Bearer, Access Token, proteção do deploy e falhas do provedor/banco nos logs. |
| Alterei o JSON e nada mudou | Após a migração o MongoDB é a fonte de verdade; seed/JSON não sobrescrevem dados automaticamente. |

O diagnóstico do provedor registra somente códigos numéricos curtos ou nomes de
erro reconhecidos e orientações fixas. Mensagens e descrições arbitrárias, o
payload e as credenciais não são registrados. Respostas sem JSON são informadas
explicitamente sem alterar a classificação da falha.

Referência: [Orders API — Mercado Pago](https://www.mercadopago.com.br/developers/pt/reference/orders/online-payments/create/post).
