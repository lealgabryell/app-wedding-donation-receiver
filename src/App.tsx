import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, FormEvent } from 'react'
import { initMercadoPago, Payment, StatusScreen } from '@mercadopago/sdk-react'
import { z } from 'zod'
import './App.css'

const itemSchema = z.object({
  id: z.number(), itemName: z.string(), totalPrice: z.number(),
  donatedValue: z.number(), remainingValue: z.number(), availableValue: z.number(),
  description: z.string(), itemProvider: z.string(), pictureUrl: z.string(),
  category: z.enum(['Cerimônia', 'Festa']),
})
const configSchema = z.object({ publicKey: z.string(), paymentsEnabled: z.boolean() })
const donationSchema = z.object({
  id: z.uuid(), itemId: z.number(), amount: z.number(), status: z.string(),
  paymentId: z.string().optional(),
})
type Item = z.infer<typeof itemSchema>
type Config = z.infer<typeof configSchema>
type Donation = z.infer<typeof donationSchema>
type Notice = { kind: 'success' | 'error' | 'info'; text: string }
type Notify = (kind: Notice['kind'], text: string) => void
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const pendingKey = 'wedding-donation-id'
const terminal = new Set(['approved', 'rejected', 'cancelled', 'refunded', 'charged_back'])
const paymentCustomization: ComponentProps<typeof Payment>['customization'] = {
  paymentMethods: { creditCard: 'all', debitCard: 'all', bankTransfer: 'all', maxInstallments: 1 },
}

function readSavedAttempt() {
  try {
    const id = localStorage.getItem(pendingKey)
    if (id && !z.uuid().safeParse(id).success) {
      return { id: null, error: 'O identificador do último pagamento não é válido. Contate os organizadores antes de doar novamente.' }
    }
    return { id, error: '' }
  } catch {
    return { id: null, error: 'Não foi possível acessar o acompanhamento no navegador. Habilite o armazenamento do site antes de doar.' }
  }
}

class RequestError extends Error {
  donationRecorded: boolean | undefined
  constructor(text: string, donationRecorded?: boolean) {
    super(text)
    this.donationRecorded = donationRecorded
  }
}

async function request<T extends z.ZodType>(path: string, schema: T, options?: RequestInit): Promise<z.infer<T>> {
  let response: Response
  try {
    response = await fetch(path, { ...options, signal: AbortSignal.timeout(20000) })
  } catch {
    throw new Error('Não foi possível comunicar com o servidor. Verifique sua conexão e consulte o andamento antes de tentar pagar novamente.')
  }
  const body: unknown = await response.json()
  if (!response.ok) {
    const error = z.object({ error: z.string(), donationRecorded: z.boolean().optional() }).safeParse(body)
    throw new RequestError(error.success ? error.data.error : 'Não foi possível concluir a solicitação.', error.success ? error.data.donationRecorded : undefined)
  }
  return schema.parse(body)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Algo deu errado. Tente novamente em instantes.'
}

function Heart({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
  </svg>
}

function Toast({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  return <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
    <span aria-hidden="true">{notice.kind === 'success' ? '✓' : notice.kind === 'error' ? '!' : 'i'}</span><p>{notice.text}</p>
    <button className="icon-button" aria-label="Fechar notificação" onClick={onClose}>×</button></div>
}

function Botanical() {
  return <svg viewBox="0 0 280 340" fill="none" aria-hidden="true" className="botanical">
    <path d="M140 330C145 250 110 190 144 80M143 233C100 208 71 176 54 121M137 268C190 233 214 197 221 159" stroke="#718064" strokeWidth="2" />
    <g fill="#9ba98b">
      <ellipse cx="113" cy="210" rx="13" ry="33" transform="rotate(-48 113 210)" />
      <ellipse cx="137" cy="183" rx="12" ry="30" transform="rotate(25 137 183)" />
      <ellipse cx="83" cy="166" rx="11" ry="29" transform="rotate(-45 83 166)" />
      <ellipse cx="179" cy="233" rx="12" ry="31" transform="rotate(48 179 233)" />
      <ellipse cx="204" cy="194" rx="11" ry="27" transform="rotate(30 204 194)" />
      <ellipse cx="144" cy="133" rx="10" ry="25" transform="rotate(25 144 133)" />
    </g>
    <g fill="#f3e7d8" stroke="#cbb89c" strokeWidth="1">
      <ellipse cx="144" cy="64" rx="18" ry="33" />
      <ellipse cx="144" cy="64" rx="18" ry="33" transform="rotate(60 144 64)" />
      <ellipse cx="144" cy="64" rx="18" ry="33" transform="rotate(120 144 64)" />
      <ellipse cx="52" cy="105" rx="13" ry="24" transform="rotate(-25 52 105)" />
      <ellipse cx="52" cy="105" rx="13" ry="24" transform="rotate(35 52 105)" />
      <ellipse cx="52" cy="105" rx="13" ry="24" transform="rotate(95 52 105)" />
      <ellipse cx="222" cy="146" rx="12" ry="22" />
      <ellipse cx="222" cy="146" rx="12" ry="22" transform="rotate(60 222 146)" />
      <ellipse cx="222" cy="146" rx="12" ry="22" transform="rotate(120 222 146)" />
    </g>
    <g fill="#b39762"><circle cx="144" cy="64" r="9" /><circle cx="52" cy="105" r="6" /><circle cx="222" cy="146" r="6" /></g>
  </svg>
}

function DonationModal({ item, config, donation, onSubmit, onClose, notify, notice, dismissNotice }: {
  item: Item; config: Config | null; donation: Donation | null
  onSubmit: (amount: number, form: unknown) => Promise<void>
  onClose: () => void; notify: Notify; notice: Notice | null; dismissNotice: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [amount, setAmount] = useState(String(Math.min(50, item.availableValue)).replace('.', ','))
  const [checkoutAmount, setCheckoutAmount] = useState<number | null>(null)
  const [amountError, setAmountError] = useState('')
  const [busy, setBusy] = useState(false)
  const [brickError, setBrickError] = useState(false)
  const [brickReady, setBrickReady] = useState(false)
  const submitting = useRef(false)
  const initialization = useMemo(() => ({ amount: checkoutAmount ?? 1 }), [checkoutAmount])
  const statusInitialization = useMemo(() => ({ paymentId: donation?.paymentId ?? '' }), [donation?.paymentId])
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { element?.close(); document.body.style.overflow = previous }
  }, [])
  useEffect(() => {
    if (!checkoutAmount || donation || brickReady || brickError) return
    const timer = setTimeout(() => setBrickError(true), 20000)
    return () => clearTimeout(timer)
  }, [checkoutAmount, donation, brickReady, brickError])

  function chooseAmount(event: FormEvent) {
    event.preventDefault()
    const value = Number(amount.replace(',', '.'))
    if (!/^\d+([.,]\d{1,2})?$/.test(amount) || value < 1 || Math.round(value * 100) > Math.round(item.availableValue * 100)) {
      setAmountError(`Digite um valor entre R$ 1,00 e ${currency.format(item.availableValue)}, sem separador de milhar.`)
      return
    }
    setAmountError('')
    setCheckoutAmount(value)
  }

  const submit: ComponentProps<typeof Payment>['onSubmit'] = async ({ formData }) => {
    if (submitting.current || checkoutAmount === null) return
    submitting.current = true
    setBusy(true)
    try {
      await onSubmit(checkoutAmount, formData)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const statusText = donation?.status === 'approved' ? 'Doação confirmada. Muito obrigado!'
    : donation && terminal.has(donation.status) ? 'Este pagamento não foi concluído ou foi estornado.'
      : 'Aguardando a confirmação do pagamento'

  return <dialog ref={dialog} className="donation-dialog" aria-labelledby="donation-title" aria-describedby="donation-description"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="modal-top"><span className="eyebrow">UM GESTO DE CARINHO</span>
      <button className="icon-button" aria-label="Fechar pagamento" disabled={busy} onClick={onClose}>×</button></div>
    <h2 id="donation-title">{item.itemName}</h2>
    <p id="donation-description">Cada contribuição nos aproxima desse dia especial.</p>
    {!config?.paymentsEnabled ? <div className="callout">
      <strong>Estamos preparando tudo por aqui.</strong>
      <p>As doações ainda não estão habilitadas. Volte em breve para contribuir.</p>
    </div> : donation ? <>
      <div className={`callout ${donation.status === 'approved' ? 'confirmed' : ''}`} role="status">
        <strong>{statusText}</strong>
        <p>Sua contribuição: {currency.format(donation.amount)}.</p>
        {!terminal.has(donation.status) && <p>Se for Pix, use o código abaixo. Não faça outro pagamento enquanto aguardamos a confirmação.</p>}
        {donation.status === 'creating' && <p>Estamos verificando se o Mercado Pago recebeu a solicitação. Se a espera continuar, contate os organizadores com o identificador abaixo.</p>}
      </div>
      {donation.paymentId && <StatusScreen initialization={statusInitialization} locale="pt-BR"
        onError={() => { setBrickError(true); notify('error', 'Não foi possível exibir os detalhes do pagamento. Feche e reabra para tentar novamente.') }} />}
      {brickError && <p className="field-error" role="alert">Os detalhes do Mercado Pago não carregaram. Verifique sua conexão.</p>}
      <p className="reference">Identificador da doação: {donation.id}</p>
      <button className="primary full" disabled={busy} onClick={onClose}>Voltar para a lista</button>
    </> : checkoutAmount === null ? <form onSubmit={chooseAmount}>
      <label htmlFor="donation-amount">Com quanto você gostaria de contribuir?</label>
      <div className="amount-input"><span>R$</span><input id="donation-amount" autoFocus inputMode="decimal" value={amount}
        onChange={(event) => setAmount(event.target.value)} aria-invalid={Boolean(amountError)}
        aria-describedby={amountError ? 'amount-error amount-help' : 'amount-help'} required maxLength={12} /></div>
      <p id="amount-help" className="muted small">A partir de R$ 1,00. Disponível para doação: {currency.format(item.availableValue)}.</p>
      <div className="amount-options" aria-label="Valores sugeridos">{[25, 50, 100].filter((value) => value <= item.availableValue).map((value) =>
        <button type="button" className={Number(amount.replace(',', '.')) === value ? 'chosen' : ''} key={value} onClick={() => setAmount(String(value))}>{currency.format(value)}</button>)}</div>
      {amountError && <p id="amount-error" className="field-error" role="alert">{amountError}</p>}
      <button className="primary full" type="submit">Continuar para o pagamento <span aria-hidden="true">→</span></button>
      <p className="secure-note">Pagamento processado com segurança pelo Mercado Pago.</p>
    </form> : <>
      <div className="checkout-summary"><span>Sua contribuição</span><strong>{currency.format(checkoutAmount)}</strong></div>
      {!brickReady && !brickError && <p role="status">Carregando o pagamento seguro…</p>}
      {brickError ? <div className="callout" role="alert"><p>Não foi possível carregar o Mercado Pago. Verifique sua conexão e tente novamente.</p>
        <button className="secondary" onClick={() => { setCheckoutAmount(null); setBrickError(false); setBrickReady(false) }}>Voltar e tentar novamente</button></div>
        : <Payment initialization={initialization} customization={paymentCustomization} locale="pt-BR"
          onSubmit={submit} onReady={() => setBrickReady(true)}
          onError={() => { setBrickError(true); notify('error', 'O formulário de pagamento apresentou um erro. Verifique os dados ou tente novamente.') }} />}
      {busy && <p role="status">Enviando pagamento. Aguarde, por favor…</p>}
      {!busy && <button className="text-button" onClick={() => { setCheckoutAmount(null); setBrickReady(false); setBrickError(false) }}>Alterar valor</button>}
    </>}
    {notice && <Toast notice={notice} onClose={dismissNotice} />}
  </dialog>
}

function App() {
  const [savedAttempt] = useState(readSavedAttempt)
  const [items, setItems] = useState<Item[]>([])
  const [config, setConfig] = useState<Config | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState('Todos')
  const [selected, setSelected] = useState<Item | null>(null)
  const [notice, setNotice] = useState<Notice | null>(savedAttempt.error ? { kind: 'error', text: savedAttempt.error } : null)
  const [donation, setDonation] = useState<Donation | null>(null)
  const [trackingId, setTrackingId] = useState<string | null>(savedAttempt.id)
  const [syncError, setSyncError] = useState('')
  const lastStatus = useRef('')
  const notify = useCallback<Notify>((kind, text) => setNotice({ kind, text }), [])
  const refresh = useCallback(async () => {
    setItems(await request('/api/items', z.array(itemSchema)))
    setLoadError('')
  }, [])
  const load = useCallback(() =>
    Promise.all([
      request('/api/items', z.array(itemSchema)), request('/api/config', configSchema),
    ]).then(([catalog, settings]) => {
      if (settings.paymentsEnabled) initMercadoPago(settings.publicKey, { locale: 'pt-BR' })
      setItems(catalog)
      setConfig(settings)
      setLoadError('')
    }).catch((error: unknown) => {
      setLoadError(`Não foi possível carregar a lista. ${message(error)}`)
    }).finally(() => {
      setLoading(false)
    }), [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const timer = setInterval(() => { void refresh().catch((error) => setLoadError(`A lista não pôde ser atualizada. ${message(error)}`)) }, 20000)
    return () => clearInterval(timer)
  }, [refresh])
  const acceptDonation = useCallback((next: Donation) => {
    setDonation(next)
    setSyncError('')
    const key = `${next.id}:${next.status}`
    if (lastStatus.current !== key) {
      lastStatus.current = key
      if (next.status === 'approved') notify('success', 'Doação confirmada! Muito obrigado por fazer parte da nossa história.')
      else if (terminal.has(next.status)) notify('error', 'O pagamento não foi concluído ou foi estornado. Confira os detalhes da doação.')
      else notify('info', 'Pagamento aguardando confirmação. Sua doação será atualizada assim que for aprovada.')
    }
  }, [notify])
  useEffect(() => {
    if (!trackingId) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function check() {
      try {
        const next = await request(`/api/donations/${trackingId}`, donationSchema)
        if (!active) return
        acceptDonation(next)
        await refresh()
        if (!terminal.has(next.status)) timer = setTimeout(() => { void check() }, 5000)
      } catch (error) {
        if (!active) return
        setSyncError(`Não foi possível consultar a doação. ${message(error)} Não pague novamente enquanto verifica.`)
        timer = setTimeout(() => { void check() }, 15000)
      }
    }
    void check()
    return () => { active = false; clearTimeout(timer) }
  }, [trackingId, acceptDonation, refresh])

  async function submitDonation(amount: number, form: unknown) {
    if (!selected) return
    const id = crypto.randomUUID()
    try {
      // Remember the attempt before sending: refreshing must never generate a second charge.
      localStorage.setItem(pendingKey, id)
    } catch {
      const error = new Error('O navegador não conseguiu salvar o acompanhamento. Habilite o armazenamento do site antes de pagar.')
      notify('error', error.message)
      throw error
    }
    const attempt = { id, itemId: selected.id, amount, status: 'creating' }
    setDonation(attempt)
    let shouldTrack = true
    try {
      const next = await request('/api/donations', donationSchema, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, itemId: selected.id, amount, form }),
      })
      acceptDonation(next)
      await refresh()
    } catch (error) {
      if (error instanceof RequestError && error.donationRecorded === false) {
        shouldTrack = false
        setDonation(null)
        setTrackingId(null)
        try { localStorage.removeItem(pendingKey) }
        catch { notify('error', 'Não foi possível limpar o acompanhamento no navegador. Contate os organizadores.') }
      }
      notify('error', message(error))
      throw error
    } finally {
      if (shouldTrack) setTrackingId(id)
    }
  }

  const total = items.reduce((sum, item) => sum + Math.round(item.totalPrice * 100), 0) / 100
  const donated = items.reduce((sum, item) => sum + Math.round(item.donatedValue * 100), 0) / 100
  const percentage = total ? Math.round(donated / total * 100) : 0
  const visible = items.filter((item) => filter === 'Todos' || item.category === filter)
  const pending = Boolean((trackingId || donation) && (!donation || !terminal.has(donation.status)))

  function openDonation(item: Item) {
    if (!pending) {
      setDonation(null)
      setTrackingId(null)
      setSyncError('')
    }
    setSelected(item)
  }

  return <>
    <a className="skip-link" href="#presentes">Pular para a lista de presentes</a>
    <header className="site-header"><a className="brand" href="#" aria-label="Nosso sim, início"><Heart /><span>nosso sim<span className="brand-dot">.</span></span></a>
      <nav aria-label="Menu principal"><a href="#presentes">Lista de presentes</a><a href="#como-funciona">Como contribuir</a></nav>
      <span className="header-note">feito de amor, por muitas mãos</span>
    </header>
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy"><span className="eyebrow"><span className="little-line" /> NOSSO GRANDE DIA</span>
          <h1 id="hero-title">O nosso sonho.<br /><em>Um pouquinho de você.</em></h1>
          <p>Tem coisas que ficam ainda mais bonitas quando são compartilhadas. Ajude a construir a nossa celebração, com o valor que fizer sentido para você.</p>
          <a className="primary" href="#presentes">Quero fazer parte <span aria-hidden="true">↗</span></a>
          <span className="hero-footnote"><Heart /> Sua presença já é o nosso maior presente.</span>
        </div>
        <div className="hero-art"><div className="art-arch"><Botanical /><span>juntos, florescemos.</span></div>
          <span className="art-caption">CADA GESTO FAZ PARTE DA NOSSA HISTÓRIA</span>
          <span className="art-sparkle sparkle-one" aria-hidden="true">✧</span><span className="art-sparkle sparkle-two" aria-hidden="true">✧</span>
        </div>
      </section>
      <section className="how-it-works" id="como-funciona" aria-label="Como contribuir">
        <div><span className="step-number">01</span><p><strong>Escolha com carinho</strong><span>Encontre um item da nossa lista.</span></p></div>
        <div><span className="step-number">02</span><p><strong>Contribua do seu jeito</strong><span>Escolha o valor e pague com segurança.</span></p></div>
        <div><span className="step-number">03</span><p><strong>Faça parte desse dia</strong><span>Cada contribuição aproxima o nosso sim.</span></p></div>
      </section>

      <section className="catalog-section" id="presentes" aria-labelledby="catalog-title">
        <div className="section-heading"><div><span className="eyebrow">PEDACINHOS DO NOSSO SONHO</span><h2 id="catalog-title">Nossa lista de presentes</h2>
          <p>Não precisa presentear um item inteiro. Um pouquinho já significa muito.</p></div>
          {!loading && !loadError && <div className="overall"><span>Juntos, já realizamos <strong>{percentage}%</strong></span>
            <progress value={donated} max={total || 1} aria-label="Progresso total das doações" /><span>{currency.format(donated)} de {currency.format(total)}</span></div>}
        </div>
        {!loading && config && !config.paymentsEnabled && <div className="setup-notice" role="status"><span aria-hidden="true">♡</span> A lista já está no ar. Em breve, você poderá contribuir por aqui.</div>}
        {trackingId && <div className="tracking-banner">
          <div><strong>{pending ? 'Você tem uma doação em acompanhamento.' : 'Sua última doação'}</strong>
            <p>{syncError || (donation?.status === 'approved' ? 'Pagamento confirmado. Obrigado pelo carinho!' : 'Consulte os detalhes antes de fazer um novo pagamento.')}</p>
            {!donation && <p className="reference">Identificador: {trackingId}</p>}</div>
          <button className="secondary" disabled={!donation || !items.some((item) => item.id === donation.itemId)} onClick={() => {
            const item = items.find((entry) => entry.id === donation?.itemId)
            if (item) setSelected(item)
          }}>Ver doação</button>
        </div>}
        <div className="catalog-toolbar"><div className="filters" role="group" aria-label="Filtrar presentes">
          {['Todos', 'Cerimônia', 'Festa'].map((category) => <button key={category} aria-pressed={filter === category}
            className={filter === category ? 'active' : ''} onClick={() => setFilter(category)}>{category}</button>)}
        </div><span className="muted small" role="status">{visible.length} itens cheios de significado</span></div>
        {loading && <div className="empty-state" role="status">Preparando a nossa lista com carinho…</div>}
        {loadError && <div className="callout" role="alert"><p>{loadError}</p><button className="secondary" onClick={() => { setLoading(true); void load() }}>Tentar novamente</button></div>}
        {!loading && <div className="gift-grid">{visible.map((item) => {
          const progress = Math.round(item.donatedValue / item.totalPrice * 100)
          const complete = item.remainingValue === 0
          return <article className="gift-card" key={item.id}>
            <div className="gift-picture"><img src={item.pictureUrl} alt="" loading="lazy"
              onError={(event) => { event.currentTarget.hidden = true }} /><span className="category-tag">{item.category}</span>
              {complete && <span className="complete-tag">Presente completo ♡</span>}</div>
            <div className="gift-content"><h3>{item.itemName}</h3><p className="gift-description">{item.description}</p>
              <span className="provider">Fornecedor: {item.itemProvider}</span>
              <div className="progress-caption"><strong>{currency.format(item.donatedValue)} <span>recebidos</span></strong><span>{progress}%</span></div>
              <progress max={item.totalPrice} value={item.donatedValue} aria-label={`Doações para ${item.itemName}`} />
              <div className="gift-totals"><span>Meta: {currency.format(item.totalPrice)}</span><span>Faltam <strong>{currency.format(item.remainingValue)}</strong></span></div>
              {item.availableValue < item.remainingValue && <p className="reservation-note">Há pagamentos em andamento. Disponível: {currency.format(item.availableValue)}.</p>}
              <button className="donate-button" disabled={complete || item.availableValue < 1 || pending} onClick={() => openDonation(item)}
                aria-label={`Doar para ${item.itemName}`}><Heart /> {complete ? 'Realizado com carinho' : pending ? 'Doação em acompanhamento' : item.availableValue < 1 ? 'Aguardando pagamentos' : 'Doar'} {!complete && <span aria-hidden="true">→</span>}</button>
            </div>
          </article>
        })}</div>}
        {!loading && !loadError && visible.length === 0 && <p className="empty-state">Ainda não há presentes nesta categoria.</p>}
      </section>
      <section className="thank-you"><Heart /><span className="eyebrow">O MAIS IMPORTANTE NÃO CABE EM UMA LISTA</span>
        <h2>Ter você com a gente.</h2><p>Doando ou não, celebrar ao seu lado é o que torna tudo especial.<br />Obrigado por fazer parte da nossa história.</p><span className="signature">Com amor, os noivos</span></section>
    </main>
    <footer><a className="brand" href="#"><Heart /><span>nosso sim.</span></a><p>Uma celebração feita de pequenos gestos e muito amor.</p><span>Pagamentos via Mercado Pago</span></footer>
    {selected && <DonationModal key={selected.id} item={items.find((item) => item.id === selected.id) ?? selected} config={config}
      donation={donation?.itemId === selected.id ? donation : null} onSubmit={submitDonation}
      onClose={() => setSelected(null)} notify={notify} notice={notice} dismissNotice={() => setNotice(null)} />}
    {notice && !selected && <Toast notice={notice} onClose={() => setNotice(null)} />}
  </>
}

export default App
