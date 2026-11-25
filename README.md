# Nosso sim — Lista de presentes

React + Vite + TypeScript com uma API Node.js/Express. Os convidados escolhem um
presente, informam o valor e pagam em um modal com o **Payment Brick oficial do
Mercado Pago** (Pix e cartões, conforme habilitados na conta). A tela de status
do Mercado Pago exibe o QR Code Pix e os detalhes da transação.

## Executar localmente

Requer Node.js 22.18+ e npm.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Abra `http://localhost:5173`. Vite encaminha `/api` para a API na porta 3001.
Sem credenciais, a lista funciona e o modal informa que as doações ainda não
estão habilitadas. **Não existe pagamento simulado na aplicação.**

## Configurar Mercado Pago

1. Crie uma aplicação para Checkout Bricks em
   [Suas integrações](https://www.mercadopago.com.br/developers/panel/app).
2. Preencha no `.env` a Public Key e o Access Token de **teste** da mesma conta.
   O Access Token fica exclusivamente no servidor; nunca use prefixo `VITE_`
   para credenciais privadas.
3. Configure uma URL **pública HTTPS**, acessível pelo Mercado Pago, para
   `/api/webhooks/mercadopago`. Em desenvolvimento, use um túnel HTTPS para a
   porta da API. Preencha `MERCADO_PAGO_NOTIFICATION_URL` com a URL completa.
4. No painel Webhooks, selecione o evento **Pagamentos (`payment`)**, configure
   essa mesma URL e preencha `MERCADO_PAGO_WEBHOOK_SECRET` com a assinatura
   secreta fornecida. O endpoint valida `x-signature` antes de consultar a API.
5. Mantenha `APP_ORIGIN` igual à origem do frontend (incluindo protocolo e porta)
   e reinicie `npm run dev`. Para acesso pelo túnel, atualize essa origem.
6. Valide aprovação, recusa e Pix pendente usando as
   [contas e os cartões de teste oficiais](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/integration-test).
   Não use cartões reais em testes. Para produção, substitua pelas credenciais
   produtivas e revise os eventos e a assinatura do webhook de produção.

O modal não pede dados de cartão diretamente: a coleta e a tokenização são
feitas pelo Brick. O servidor recebe o token temporário, não o número do cartão.
E-mail, documento do pagador e token não são gravados no JSON.

**Limite de validação:** os testes automatizados usam respostas controladas do
provedor, sem cobrar valores. Uma transação real e o carregamento do Brick
dependem de credenciais, conta habilitada e webhook público; precisam ser
homologados na conta Mercado Pago antes da publicação.

## Dados e personalização

- `data/seed.json`: catálogo inicial com exemplos, preços, descrições, fornecedor,
  categoria (`Cerimônia` ou `Festa`) e imagem. O exemplo de flores inclui R$ 100
  já recebidos apenas para ilustrar o progresso; ajuste os valores antes de usar.
- `data/wedding.json`: arquivo persistente criado automaticamente na primeira
  execução, com `{ "items": [...], "donations": [...] }`. Os itens preservam os
  campos do modelo solicitado. Este arquivo não é versionado.
- `public/images/`: ilustrações locais em SVG, sem depender de serviços de imagem.
- `src/App.tsx`: textos da página e assinatura dos noivos.

Após a primeira execução, editar o seed **não modifica** os dados persistidos.
Para mudar o catálogo em uso, pare o servidor, faça backup de `data/wedding.json`
e edite os itens nesse arquivo, preservando o histórico de doações.
`remainingValue` deve ser igual a `totalPrice - donatedValue`; os valores
monetários aceitam no máximo duas casas decimais. Um arquivo inválido impede a
inicialização em vez de apagar as doações existentes.

### Confirmação e consistência

- Somente o status `approved`, verificado pela API do Mercado Pago no backend,
  atualiza `donatedValue`, `remainingValue` e a barra de progresso.
- Pix pendente não é considerado sucesso. Ele reserva saldo para impedir que
  doações simultâneas excedam a meta. A API também fornece `availableValue`.
- Cada tentativa tem um UUID persistido **antes** da cobrança, usado como
  `X-Idempotency-Key` e `external_reference`. Notificações repetidas não duplicam
  valores; reembolsos, inclusive parciais, e chargebacks ajustam o total.
- Webhooks atualizam o arquivo mesmo sem o convidado conectado. A cada minuto,
  o servidor também reconcilia pagamentos, recuperando solicitações interrompidas.
  A página consulta a lista a cada 20 segundos e uma doação pendente a cada 5.
- O navegador guarda somente o identificador da última tentativa para retomar o
  acompanhamento após recarregar. Não armazena dados do pagador.
- Uma falha de rede **não significa recusa**: o saldo permanece reservado até a
  confirmação, sem disparar uma segunda cobrança. Se uma tentativa ficar em
  “verificando” indefinidamente, os organizadores devem conferir seu identificador
  no Mercado Pago. Não apague a reserva nem refaça o pagamento sem conferir se
  houve cobrança. Reservas ambíguas não expiram automaticamente.
- As escritas são serializadas e substituem o JSON por renomeação de um arquivo
  temporário. Use **um único processo/instância**, disco persistente e backups.
  Não execute dois servidores apontando para o mesmo arquivo.

## Verificação

```powershell
npm test
npm run lint
npm run build
```

Os testes usam arquivos temporários isolados e a API HTTP real do Express;
somente a fronteira com o Mercado Pago é substituída. Cobrem aprovação,
pendência, estorno, idempotência, concorrência, reinício, validação de origem,
assinatura e persistência. Nenhuma credencial é necessária.

## Publicação

```powershell
npm run build
npm start
```

O Node serve o frontend de `dist` e a API na mesma origem. Configure
`APP_ORIGIN=https://seu-dominio`, HTTPS no proxy e todas as variáveis do
Mercado Pago. `HOST` é `127.0.0.1` por padrão; em contêineres pode ser necessário
`HOST=0.0.0.0`. `PORT` é `3001` por padrão.

Configure `DATA_FILE` como caminho absoluto em volume persistente se necessário.
Hospedagem somente estática (como GitHub Pages) ou serverless com disco
descartável **não atende** à persistência deste projeto. Para múltiplas instâncias
ou maior volume, substitua o JSON por banco transacional.

Não habilite `trust proxy` indiscriminadamente: se houver proxy reverso, configure
explicitamente os proxies confiáveis antes de usar os limites por IP em produção.
Revise HTTPS, política de segurança de conteúdo compatível com os Bricks,
backups e termos de privacidade antes de receber pagamentos reais. Os valores
exibidos são contribuições brutas; tarifas do Mercado Pago não são descontadas
da barra de progresso.
