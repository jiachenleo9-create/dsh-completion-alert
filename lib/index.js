/**
 * dsh-completion-alert · host half.
 *
 * Detects "the agent finished a task" on the host, decides whether the user is
 * actually looking at the DeepSeek Harness window (reported by the client half
 * over a local HTTP route), and — when they are not — plays a synthesized
 * "ding" and raises an always-on-top card in the bottom-right corner of the
 * primary screen. Clicking that card restores the Harness window through the
 * application's own `dsh://open` single-instance entry point and hands the
 * finished session back to the browser half so it can select that task.
 *
 * Everything here is plain ESM: no build step, no runtime dependencies.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'completion-alert'

const HERE = dirname(fileURLToPath(import.meta.url))
const NOTIFY_SCRIPT = join(HERE, '..', 'assets', 'notify.ps1')
const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000

const DATA_DIR = join(tmpdir(), 'dsh-completion-alert')
const DING_PATH = join(DATA_DIR, 'ding.wav')
const PAYLOAD_PATH = join(DATA_DIR, 'payload.json')
const CLAIM_PATH = join(DATA_DIR, 'claim.json')

/** Route prefix claimed on the web server; the browser half talks to it. */
const PREFIX = '/completion-alert'
/** A focus report older than this no longer proves the window is in front. */
const FOCUS_STALE_MS = 120_000
/** Upper bound for one request body; focus reports are tiny. */
const MAX_BODY_BYTES = 64 * 1024

const HEADINGS = {
  completed: '任务已完成',
  error: '任务执行出错',
  blocked: '任务被阻断',
  'max-tokens': '任务已达输出上限',
  aborted: '任务已中断',
  approval: '需要你审批',
  question: '需要你回答',
}

const DEFAULTS = {
  /** Master switch for the whole plugin. */
  enabled: true,
  /** Alert only while the Harness window is not in front (the requested behavior). */
  onlyWhenUnfocused: true,
  /** Play the synthesized "ding". */
  sound: true,
  /** Raise the always-on-top thumbnail card. */
  popup: true,
  /** Seconds before the card closes itself. */
  popupSeconds: 9,
  /** Card corner: br | bl | tr | tl. */
  corner: 'br',
  /** Also alert when the user stopped the turn themselves. */
  notifyOnAbort: false,
  /** Alert when a tool call is waiting for the user's approval. */
  approvalAlerts: true,
  /** Longer lifetime for approval cards: the user may be away from the machine. */
  approvalSeconds: 20,
  /** Alert when the agent asks the user a question and is blocked on the answer. */
  questionAlerts: true,
  /** Longer lifetime for question cards. */
  questionSeconds: 20,
  /** Minimum gap between two cards. */
  minGapMs: 5000,
  /** Settle time after the agent stops, so trailing events can land first. */
  debounceMs: 1200,
}

/** Argument fields that best describe what a pending tool call is about to do. */
const PREVIEW_KEYS = ['command', 'commandLine', 'script', 'cmd', 'path', 'file_path', 'filePath', 'query', 'url', 'prompt', 'content']
/** Longest detail line the card can show before it starts ellipsizing. */
const PREVIEW_CHARS = 96

/**
 * Resolve the Windows PowerShell executable without trusting PATH, which the
 * Harness may have trimmed.
 * @returns Absolute executable path, or the bare name as a last resort.
 */
function powershellPath() {
  if (process.platform !== 'win32') return 'powershell.exe'
  const root = process.env.SystemRoot ?? process.env.windir
  const absolute = root === undefined ? undefined : join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return absolute !== undefined && existsSync(absolute) ? absolute : 'powershell.exe'
}

/**
 * Write the notification chime once: three decaying sine partials over a soft
 * attack — a clean two-note "ding" that needs no asset and no network.
 * @returns Absolute path of the WAV file, or undefined when it cannot be written.
 */
function ensureDing() {
  if (existsSync(DING_PATH)) return DING_PATH
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const rate = 44_100
    const seconds = 1.2
    const frames = Math.floor(rate * seconds)
    const samples = Buffer.alloc(frames * 2)
    const partials = [
      { frequency: 1046.5, gain: 0.62, decay: 3.1 },
      { frequency: 2093, gain: 0.16, decay: 5.6 },
      { frequency: 1568, gain: 0.22, decay: 4.3 },
    ]
    for (let index = 0; index < frames; index++) {
      const time = index / rate
      let value = 0
      for (const partial of partials) {
        value += partial.gain * Math.exp(-partial.decay * time) * Math.sin(2 * Math.PI * partial.frequency * time)
      }
      const attack = Math.min(1, time / 0.004)
      const clamped = Math.max(-1, Math.min(1, value * 0.55 * attack))
      samples.writeInt16LE(Math.round(clamped * 32_767), index * 2)
    }
    const header = Buffer.alloc(44)
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + samples.length, 4)
    header.write('WAVE', 8)
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(1, 22)
    header.writeUInt32LE(rate, 24)
    header.writeUInt32LE(rate * 2, 28)
    header.writeUInt16LE(2, 32)
    header.writeUInt16LE(16, 34)
    header.write('data', 36)
    header.writeUInt32LE(samples.length, 40)
    writeFileSync(DING_PATH, Buffer.concat([header, samples]))
    return DING_PATH
  } catch {
    return undefined
  }
}

/**
 * Merge caller configuration over the defaults.
 * @param config - plugin config row from the profile patch layer.
 * @returns Effective settings.
 */
function normalize(config) {
  const settings = { ...DEFAULTS }
  if (config !== null && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (config[key] !== undefined) settings[key] = config[key]
    }
  }
  settings.popupSeconds = Math.max(3, Math.min(120, Number(settings.popupSeconds) || DEFAULTS.popupSeconds))
  settings.minGapMs = Math.max(0, Number(settings.minGapMs) || 0)
  settings.debounceMs = Math.max(0, Number(settings.debounceMs) || 0)
  if (!['br', 'bl', 'tr', 'tl'].includes(settings.corner)) settings.corner = DEFAULTS.corner
  return settings
}

/**
 * Install the completion alert on the host context.
 * @param ctx - Profile scope; the web server is injected optionally so the
 *   plugin still loads in compositions that serve no browser.
 * @param config - Plugin configuration from the profile patch layer.
 */
export function apply(ctx, config) {
  const settings = normalize(config)
  const dingPath = ensureDing()

  const log = (level, message) => {
    try {
      ctx.logger?.('completion-alert')?.[level]?.(message)
    } catch {
      /* logging must never break the notification path */
    }
  }

  /** Latest focus report from the browser half; `focused: undefined` means "unknown". */
  let focus = { focused: undefined, at: 0, mode: 'desktop', url: '', title: '', session: undefined }
  /** Last observed run state per agent id, seeded from the live roster. */
  const running = new Map()
  /** Pending debounce timers keyed by session id. */
  const pending = new Map()
  let lastNotifyAt = 0
  let popupChild
  let disposed = false

  const isUnfocused = () => {
    if (focus.focused === undefined) return true
    if (Date.now() - focus.at > FOCUS_STALE_MS) return true
    return focus.focused !== true
  }

  /** Scan a live session's durable events backwards for the newest match. */
  const lastEvent = (sessionId, type) => {
    try {
      const session = ctx.get('sessions')?.get?.(sessionId)
      const events = session?.snapshotEvents?.() ?? []
      for (let index = events.length - 1; index >= 0; index--) {
        if (events[index]?.type === type) return events[index]
      }
    } catch {
      /* a vanished session simply has no title */
    }
    return undefined
  }

  const titleOf = (sessionId) => {
    const event = lastEvent(sessionId, 'session/title')
    const title = event?.data?.title
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
  }

  const reasonOf = (sessionId) => lastEvent(sessionId, 'turn/end')?.data?.reason

  /** Collapse whitespace and clip a one-line detail for the card. */
  const clip = (text) => {
    const flat = String(text).replace(/\s+/gu, ' ').trim()
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat
  }

  /**
   * Describe what a pending tool call is about to do, from the durable
   * `tool/call` arguments the model produced.
   * @param sessionId - Session holding the call.
   * @param callId - Call identity named by the approval audit event.
   * @returns A short human-readable preview, or undefined.
   */
  const callPreview = (sessionId, callId) => {
    try {
      const events = ctx.get('sessions')?.get?.(sessionId)?.snapshotEvents?.() ?? []
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]
        if (event?.type !== 'tool/call') continue
        if (callId !== undefined && event.data?.callId !== callId) continue
        const raw = event.data?.arguments
        if (typeof raw !== 'string' || raw.trim() === '') return undefined
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          return clip(raw)
        }
        if (parsed === null || typeof parsed !== 'object') return clip(String(parsed))
        for (const key of PREVIEW_KEYS) {
          if (typeof parsed[key] === 'string' && parsed[key].trim() !== '') return clip(parsed[key])
        }
        return clip(JSON.stringify(parsed))
      }
    } catch {
      /* the call may already be gone; the tool name alone still informs */
    }
    return undefined
  }

  /**
   * Apply the shared alert policy: focus gate plus a minimum gap between cards.
   * @returns true when the caller may raise a card now.
   */
  const mayAlert = () => {
    if (settings.enabled !== true) return false
    if (settings.onlyWhenUnfocused !== false && !isUnfocused()) return false
    const now = Date.now()
    if (now - lastNotifyAt < settings.minGapMs) return false
    lastNotifyAt = now
    return true
  }

  /**
   * Read and clear the click claim written by the popup card.
   * @returns The claimed session id, or undefined when nothing was clicked.
   */
  const takeClaim = () => {
    try {
      if (!existsSync(CLAIM_PATH)) return undefined
      const raw = readFileSync(CLAIM_PATH, 'utf8')
      rmSync(CLAIM_PATH, { force: true })
      const parsed = JSON.parse(raw)
      return typeof parsed?.sessionId === 'string' && parsed.sessionId !== '' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Raise the always-on-top card (and the chime) for one event.
   * @param descriptor - Session, reason, card text, and optional overrides.
   */
  const alert = (descriptor) => {
    if (disposed) return
    const reason = typeof descriptor.reason === 'string' ? descriptor.reason : 'completed'
    if (reason === 'aborted' && settings.notifyOnAbort !== true) return
    const heading = descriptor.heading ?? HEADINGS[reason] ?? HEADINGS.completed
    const seconds = Number.isFinite(descriptor.seconds) ? descriptor.seconds : settings.popupSeconds
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const payload = {
      heading,
      reason,
      title: descriptor.title ?? '未命名会话',
      hint: `${time} · 点击卡片回到主界面 · ${seconds} 秒后自动关闭`,
      sessionId: descriptor.sessionId,
      time,
      mode: focus.mode === 'browser' ? 'browser' : 'desktop',
      url: focus.url,
      matchTitle: focus.title,
      seconds,
      corner: settings.corner,
      sound: settings.sound === true && dingPath !== undefined,
      popup: settings.popup === true,
      dingPath: dingPath ?? '',
      claimPath: CLAIM_PATH,
      logPath: join(DATA_DIR, 'card.log'),
    }
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(PAYLOAD_PATH, JSON.stringify(payload), 'utf8')
    } catch (error) {
      log('warn', `could not write the notification payload: ${String(error)}`)
      return
    }
    if (!payload.sound && !payload.popup) return
    if (process.platform !== 'win32') {
      log('warn', 'the desktop card is implemented for Windows only; skipping')
      return
    }
    try {
      popupChild?.kill()
      popupChild = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', NOTIFY_SCRIPT, '-Payload', PAYLOAD_PATH],
        { windowsHide: true, stdio: 'ignore' },
      )
      popupChild.on('error', (error) => log('warn', `notification card failed to start: ${error.message}`))
      popupChild.on('exit', () => {
        popupChild = undefined
      })
      // Never let a stray card outlive the host.
      const timer = setTimeout(() => popupChild?.kill(), SCRIPT_TIMEOUT_MS)
      timer.unref?.()
      log('info', `task finished (${reason}); alert raised`)
    } catch (error) {
      log('warn', `notification card failed: ${String(error)}`)
    }
  }

  /**
   * Decide what a stopped agent means, then alert if the window is not in front.
   * @param sessionId - Session whose agent stopped.
   */
  const settle = (sessionId) => {
    if (disposed) return
    if (ctx.get('agents')?.get?.(sessionId)?.status === 'running') return
    if (!mayAlert()) return
    alert({ sessionId, reason: reasonOf(sessionId), title: titleOf(sessionId) })
  }

  /**
   * A tool call is blocked on the user's decision. Card text names the tool and
   * quotes what it is about to do, so the user can judge without switching back.
   * @param sessionId - Session that raised the request.
   * @param data - `approval/asked` payload: id, toolName, callId, reason.
   */
  const alertApproval = (sessionId, data) => {
    if (disposed || settings.approvalAlerts !== true) return
    if (!mayAlert()) return
    const preview = data?.callId === undefined ? undefined : callPreview(sessionId, data.callId)
    const detail = [data?.toolName, preview ?? data?.reason].filter((part) => typeof part === 'string' && part !== '')
    alert({
      sessionId,
      reason: 'approval',
      heading: HEADINGS.approval,
      title: detail.length > 0 ? clip(detail.join(' · ')) : '有一个操作在等你批准',
      seconds: settings.approvalSeconds,
    })
  }

  /**
   * The agent asked a question and is blocked until it is answered.
   * @param request - `user-questions/request` payload.
   */
  const alertQuestion = (request) => {
    if (disposed || settings.questionAlerts !== true) return
    const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
    const text = first?.question ?? first?.header ?? first?.id
    if (!mayAlert()) return
    alert({
      sessionId: typeof request?.agent?.id === 'string' ? request.agent.id : focus.session?.id,
      reason: 'question',
      heading: HEADINGS.question,
      title: typeof text === 'string' && text.trim() !== '' ? clip(text) : '有一个问题在等你回答',
      seconds: settings.questionSeconds,
    })
  }

  const schedule = (sessionId) => {
    const timer = pending.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    pending.set(sessionId, setTimeout(() => {
      pending.delete(sessionId)
      settle(sessionId)
    }, settings.debounceMs))
  }

  const seedRunning = () => {
    try {
      for (const agent of ctx.get('agents')?.list?.() ?? []) running.set(agent.id, agent.status === 'running')
    } catch {
      /* the roster is advisory; transitions still arrive as events */
    }
  }

  seedRunning()

  ctx.effect(() => {
    const onStatus = (payload) => {
      const agent = payload?.agent
      if (agent === undefined || agent === null) return
      const was = running.get(agent.id)
      const nowRunning = payload.status === 'running'
      running.set(agent.id, nowRunning)
      if (nowRunning || was !== true) return
      const header = agent.session?.header
      // Subagents finish constantly while their parent is still working.
      if (header?.origin === 'subagent' || header?.parentSession !== undefined) return
      schedule(agent.id)
    }
    ctx.on('agent/status', onStatus)

    // A blocked approval is the case where a backgrounded Harness would
    // otherwise sit unanswered: the durable audit event names the tool, and the
    // matching tool/call arguments say what it is about to do.
    const onSessionEvent = (session, event) => {
      try {
        if (event?.type !== 'approval/asked') return
        const sessionId = session?.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        alertApproval(sessionId, event.data)
      } catch (error) {
        log('warn', `approval alert failed: ${String(error)}`)
      }
    }
    ctx.on('session/event', onSessionEvent)

    // Pass-through observer: the answer still belongs to the composed answerer,
    // so the listener must forward the waterfall untouched.
    const onQuestion = (request, next) => {
      try {
        alertQuestion(request)
      } catch (error) {
        log('warn', `question alert failed: ${String(error)}`)
      }
      return typeof next === 'function' ? next() : undefined
    }
    ctx.on('user-questions/request', onQuestion)

    return () => {
      disposed = true
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      popupChild?.kill()
      popupChild = undefined
    }
  }, 'completion-alert: agent status watch')

  ctx.inject(['webServer'], (webCtx) => {
    const respond = (res, status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
    }
    const readBody = (req) => new Promise((resolve) => {
      let text = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        text += chunk
        if (text.length > MAX_BODY_BYTES) {
          req.destroy()
          resolve(undefined)
        }
      })
      req.on('end', () => {
        try {
          resolve(text === '' ? {} : JSON.parse(text))
        } catch {
          resolve(undefined)
        }
      })
      req.on('error', () => resolve(undefined))
    })

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'POST' && url.pathname === `${PREFIX}/focus`) {
        const body = await readBody(req)
        if (body === undefined) {
          respond(res, 400, { error: 'bad-request' })
          return
        }
        focus = {
          focused: body.focused === true,
          at: Date.now(),
          mode: body.mode === 'browser' ? 'browser' : 'desktop',
          url: typeof body.url === 'string' ? body.url : '',
          title: typeof body.documentTitle === 'string' ? body.documentTitle : '',
          session: body.session !== null && typeof body.session === 'object'
            ? { id: String(body.session.id ?? ''), title: typeof body.session.title === 'string' ? body.session.title : undefined }
            : undefined,
        }
        respond(res, 200, { ok: true })
        return
      }
      // Self-check: raise the card and the chime regardless of focus, so the
      // whole desktop path can be verified without waiting for a real task.
      // `?kind=approval` / `?kind=question` preview the other card styles.
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname === `${PREFIX}/test`) {
        lastNotifyAt = 0
        const kind = url.searchParams.get('kind')
        const sessionId = focus.session?.id !== undefined && focus.session.id !== '' ? focus.session.id : 'completion-alert-test'
        if (kind === 'approval') {
          alert({
            sessionId,
            reason: 'approval',
            heading: HEADINGS.approval,
            title: 'pwsh · npm install --global dsh-completion-alert',
            seconds: settings.approvalSeconds,
          })
        } else if (kind === 'question') {
          alert({
            sessionId,
            reason: 'question',
            heading: HEADINGS.question,
            title: '要我把这张卡片也做成可点击重试吗？',
            seconds: settings.questionSeconds,
          })
        } else {
          alert({ sessionId, reason: 'completed', title: focus.session?.title ?? '自检提醒：插件已就绪' })
        }
        respond(res, 200, { ok: true, alerted: true, kind: kind ?? 'completed' })
        return
      }
      if (req.method === 'GET' && url.pathname === `${PREFIX}/state`) {
        const claim = takeClaim()
        respond(res, 200, {
          focused: focus.focused === true,
          fresh: Date.now() - focus.at <= FOCUS_STALE_MS,
          pending: claim ?? null,
        })
        return
      }
      if (req.method === 'GET' && url.pathname === `${PREFIX}/ping`) {
        respond(res, 200, {
          ok: true,
          plugin: 'dsh-completion-alert',
          version: '0.1.0',
          platform: process.platform,
          sound: settings.sound === true && dingPath !== undefined,
          popup: settings.popup === true,
          onlyWhenUnfocused: settings.onlyWhenUnfocused !== false,
          focused: focus.focused === true && Date.now() - focus.at <= FOCUS_STALE_MS,
          hasClientReport: focus.at > 0,
        })
        return
      }
      respond(res, 404, { error: 'not-found' })
    }

    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: PREFIX, handler }),
      'completion-alert: http routes',
    )
    log('info', `routes ready at ${PREFIX}`)
  })
}
