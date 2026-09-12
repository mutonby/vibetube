'use strict'

// Gestor de agentes headless (Claude stream-json / Codex exec JSONL).
// Genérico para montaje/iteración (key = carpeta del proyecto) y guiones
// (key = 'style' | 'script' | 'hooks').
//
// Robustez:
//  - timeout de INACTIVIDAD (sin eventos) y tope duro de duración → SIGTERM del
//    GRUPO de procesos (mata también ffmpeg/python hijos), escalando a SIGKILL.
//  - coste/turnos/duración del evento `result` → feed + callback para persistir.
//  - registro de procesos vivos en userData/agents.json: al arrancar la app se
//    matan los huérfanos de una ejecución anterior.
//  - stderr completo en `<logDir>/_agent.log` (el feed solo enseña el final).
//  - si `--resume <id>` falla porque la sesión ya no existe, se reintenta sin resume.

const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { app, BrowserWindow } = require('electron')
const { findBin, readJson, writeJson } = require('./util')
const settings = require('./settings')
const providers = require('./providers')

const IDLE_MS_DEFAULT = 15 * 60 * 1000   // 15 min sin eventos → cancelar
const HARD_MS_DEFAULT = 3 * 60 * 60 * 1000 // 3 h máximo por job
const KILL_ESCALATE_MS = 5000

// key -> { status: 'running'|'done'|'error'|'cancelled', log, events, child, error, result, sessionId, cost }
const agentJobs = new Map()

function claudePath() {
  return agentPath('claude')
}
function selectedProvider() { return providers.normalizeProvider(settings.get('agentProvider', 'claude')) }
function agentPath(provider = selectedProvider()) {
  provider = providers.normalizeProvider(provider)
  const home = app.getPath('home')
  return findBin(provider, [provider, path.join(home, '.local/bin', provider), `/opt/homebrew/bin/${provider}`, `/usr/local/bin/${provider}`])
}

// ---- eventos -----------------------------------------------------------------

// Evento stream-json → {kind:'cmd'|'tool'|'text'|'status'|'result', label, ...}
function progressFromEvent(ev, provider = 'claude') {
  if (provider === 'codex') return providers.codexProgress(ev)
  if (!ev || typeof ev !== 'object') return null
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_use') {
        const name = block.name || 'tool'
        if (name === 'Bash' && block.input && block.input.command) {
          return { kind: 'cmd', label: String(block.input.command).split('\n')[0].slice(0, 120) }
        }
        return { kind: 'tool', label: name }
      }
      if (block.type === 'text' && block.text && block.text.trim()) {
        return { kind: 'text', label: block.text.trim().replace(/\s+/g, ' ').slice(0, 400) }
      }
    }
  }
  if (ev.type === 'result') {
    const cost = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null
    const turns = typeof ev.num_turns === 'number' ? ev.num_turns : null
    const ms = typeof ev.duration_ms === 'number' ? ev.duration_ms : null
    const parts = []
    if (cost != null) parts.push(`$${cost.toFixed(2)}`)
    if (turns != null) parts.push(`${turns} turnos`)
    if (ms != null) parts.push(`${Math.round(ms / 60000)} min`)
    return {
      kind: 'result',
      label: (ev.is_error ? 'error en el agente' : 'agente terminado') + (parts.length ? ` · ${parts.join(' · ')}` : ''),
      cost, turns, durationMs: ms, isError: !!ev.is_error,
    }
  }
  return null
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload) } catch { /* gone */ }
  }
}

function evToMsg(ev) {
  if (ev.kind === 'cmd') return `$ ${ev.label}`
  if (ev.kind === 'tool') return `· ${ev.label}`
  return ev.label
}
function pushEvent(key, ev) {
  const msg = evToMsg(ev)
  const job = agentJobs.get(key)
  if (job) {
    job.log.push(msg); if (job.log.length > 600) job.log.shift()
    job.events.push(ev); if (job.events.length > 300) job.events.shift()
    if (job.logFile) { try { fs.appendFileSync(job.logFile, `[${new Date().toISOString()}] ${msg}\n`) } catch { /* ignore */ } }
  }
  broadcast('agent-progress', { key, msg, ev })
}
function pushLog(key, msg) { pushEvent(key, { kind: 'status', label: msg }) }

// ---- registro de procesos (huérfanos) -----------------------------------------

function registryFile() { return path.join(app.getPath('userData'), 'agents.json') }
function registryRead() { return readJson(registryFile(), []) || [] }
function registryWrite(list) { try { writeJson(registryFile(), list) } catch { /* ignore */ } }
function registryAdd(entry) { registryWrite([...registryRead().filter((e) => e.pid !== entry.pid), entry]) }
function registryRemove(pid) { registryWrite(registryRead().filter((e) => e.pid !== pid)) }

function killGroup(pid, signal = 'SIGTERM') {
  try { process.kill(-pid, signal); return true } catch { /* sin grupo */ }
  try { process.kill(pid, signal); return true } catch { return false }
}
function isAlive(pid) { try { process.kill(pid, 0); return true } catch { return false } }

// Al arrancar: mata agentes que quedaron vivos de una ejecución anterior de la app.
function cleanupOrphans() {
  const list = registryRead()
  let killed = 0
  for (const e of list) {
    if (e && e.pid && isAlive(e.pid)) { killGroup(e.pid, 'SIGTERM'); killed += 1; setTimeout(() => killGroup(e.pid, 'SIGKILL'), KILL_ESCALATE_MS) }
    if (e && e.stateFile) { try { fs.unlinkSync(e.stateFile) } catch { /* none */ } }
  }
  registryWrite([])
  if (killed) console.log(`[agent] ${killed} agente(s) huérfano(s) terminados`)
  return killed
}

// ---- entorno -------------------------------------------------------------------

// Variables de entorno para agentes y helpers (HeyGen, NVIDIA Studio Voice, etc.)
// Primero ~/.config/record-studio/.env (propio), si no avatar-muton o settings.json.
function serviceEnv() {
  const candidates = [
    path.join(app.getPath('home'), '.config', 'record-studio', '.env'),
    path.join(app.getPath('home'), 'Documents', 'avatar-muton', '.env'),
  ]
  const out = {}
  for (const envPath of candidates) {
    try {
      const txt = fs.readFileSync(envPath, 'utf8')
      for (const line of txt.split(/\r?\n/)) {
        const m = /^\s*(HEYGEN_API_KEY|HEYGEN_API_BASE|NVIDIA_API_KEY|NGC_API_KEY|GEMINI_API_KEY|ELEVENLABS_API_KEY)\s*=\s*(.*)$/.exec(line)
        if (m && !out[m[1]]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    } catch { /* siguiente */ }
  }
  const nvidiaFromSettings = settings.get('nvidiaApiKey')
  if (nvidiaFromSettings && !out.NVIDIA_API_KEY) {
    out.NVIDIA_API_KEY = String(nvidiaFromSettings).trim()
    if (!out.NGC_API_KEY) out.NGC_API_KEY = out.NVIDIA_API_KEY
  }
  return out
}
function heygenEnv() { return serviceEnv() }


// ---- ejecución -----------------------------------------------------------------

function finish(key, job, payload) {
  if (job.finished) return
  job.finished = true
  if (job.idleTimer) clearTimeout(job.idleTimer)
  if (job.hardTimer) clearTimeout(job.hardTimer)
  if (job.child && job.child.pid) registryRemove(job.child.pid)
  if (job.stateFile) { try { fs.unlinkSync(job.stateFile) } catch { /* none */ } }
  broadcast('agent-done', { key, ...payload })
}

// successCheck() devuelve el resultado en éxito o null. `extra`:
//   resumeId, onSession(id), onResult({cost,turns,durationMs}), logDir, idleMs, hardMs, maxTurns
function runAgentJob(key, cwd, prompt, successCheck, startMsg, extra = {}) {
  const existing = agentJobs.get(key)
  if (existing && existing.status === 'running') return { started: false, already: true }

  const provider = providers.normalizeProvider(extra.provider || selectedProvider())
  const binary = agentPath(provider)
  const logDir = extra.logDir || cwd
  const job = {
    status: 'running', log: [], events: [], child: null, error: null, result: null, sessionId: null,
    cost: null, started: Date.now(), logFile: null, stateFile: null, idleTimer: null, hardTimer: null,
    attempt: 0, provider,
  }
  agentJobs.set(key, job)

  const fail = (msg) => {
    job.status = 'error'; job.error = msg
    pushLog(key, 'Error: ' + msg)
    finish(key, job, { ok: false, error: msg })
    return { started: false, error: msg }
  }
  if (!binary) return fail(`no encuentro la CLI \`${provider}\` (${providers.providerLabel(provider)}) en el PATH. Instálala e inicia sesión en una terminal.`)

  try {
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(logDir, { recursive: true })
    job.logFile = path.join(logDir, '_agent.log')
    job.stateFile = path.join(logDir, '_agent.json')
    fs.appendFileSync(job.logFile, `\n===== ${new Date().toISOString()} · ${key} =====\n`)
  } catch (e) { return fail('no puedo escribir en ' + logDir + ': ' + e.message) }

  pushLog(key, `${providers.providerLabel(provider)} · ${startMsg || 'Iniciando…'}`)

  const idleMs = extra.idleMs || IDLE_MS_DEFAULT
  const hardMs = extra.hardMs || HARD_MS_DEFAULT

  const launch = (resumeId) => {
    job.attempt += 1
    const args = providers.headlessArgs(provider, { cwd, prompt, resumeId, maxTurns: extra.maxTurns })
    if (resumeId) pushLog(key, '↻ Continuando la conversación anterior…')

    let child
    try {
      child = spawn(binary, args, {
        cwd, env: { ...process.env, ...heygenEnv() }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      })
    } catch (err) { fail(err.message); return }
    job.child = child
    registryAdd({ pid: child.pid, key, cwd, provider, started: job.started, stateFile: job.stateFile })
    try { writeJson(job.stateFile, { pid: child.pid, key, started: job.started, sessionId: job.sessionId }) } catch { /* ignore */ }

    const touch = () => {
      if (job.status !== 'running') return
      if (job.idleTimer) clearTimeout(job.idleTimer)
      job.idleTimer = setTimeout(() => {
        if (job.status !== 'running') return
        job.status = 'error'; job.error = `sin actividad durante ${Math.round(idleMs / 60000)} min — agente cancelado`
        pushLog(key, '⏱ ' + job.error)
        killGroup(child.pid); setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_ESCALATE_MS)
      }, idleMs)
    }
    touch()
    if (!job.hardTimer) {
      job.hardTimer = setTimeout(() => {
        if (job.status !== 'running') return
        job.status = 'error'; job.error = `superado el tope de ${Math.round(hardMs / 3600000)} h — agente cancelado`
        pushLog(key, '⏱ ' + job.error)
        killGroup(job.child.pid); setTimeout(() => killGroup(job.child.pid, 'SIGKILL'), KILL_ESCALATE_MS)
      }, hardMs)
    }

    let buf = ''
    let lastErr = ''
    let eventError = null
    let streamError = ''
    child.stdout.setEncoding('utf8')
    const handleLine = (line) => {
      if (!line.trim() || job.finished) return
      let ev
      try { ev = JSON.parse(line) } catch { return }
      if (!ev || typeof ev !== 'object') return
      touch()
      if (provider === 'codex' && ev.type === 'error') streamError = String(ev.message || '')
      const sessionId = provider === 'codex' ? ev.thread_id : ev.session_id
      if (sessionId && sessionId !== job.sessionId) {
        job.sessionId = sessionId
        try { writeJson(job.stateFile, { pid: child.pid, key, started: job.started, sessionId: job.sessionId }) } catch { /* ignore */ }
        try { extra.onSession && extra.onSession(sessionId) } catch { /* ignore */ }
      }
      const m = progressFromEvent(ev, provider)
      if (!m) return
      if (m.kind === 'result') {
        if (m.isError) eventError = m.label
        job.cost = { cost: m.cost, turns: m.turns, durationMs: m.durationMs ?? Date.now() - job.started, ...(m.usage ? { usage: m.usage } : {}) }
        try { extra.onResult && extra.onResult(job.cost) } catch { /* ignore */ }
      }
      pushEvent(key, m)
    }
    child.stdout.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        handleLine(line)
      }
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      lastErr += s; if (lastErr.length > 4000) lastErr = lastErr.slice(-4000)
      try { fs.appendFileSync(job.logFile, s) } catch { /* ignore */ }
    })
    child.on('error', (err) => {
      if (job.status !== 'running') return
      job.status = 'error'; job.error = err.message
      pushLog(key, 'Error: ' + err.message)
      finish(key, job, { ok: false, error: err.message })
    })
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf)
      registryRemove(child.pid)
      if (job.status === 'error') {
        finish(key, job, { ok: false, error: job.error })
        return
      }
      if (job.status === 'cancelled') {
        pushLog(key, 'Cancelado.')
        finish(key, job, { ok: false, error: 'cancelado' })
        return
      }
      // La sesión a reanudar ya no existe → reintentar una vez sin --resume.
      if (resumeId && code !== 0 && job.attempt === 1 && /(?:conversation|session|thread).*(?:not found|does not exist|no longer exists)|no (?:conversation|session|thread) (?:found|with)/i.test(lastErr + ' ' + (eventError || streamError))) {
        pushLog(key, '⚠ no se pudo continuar la conversación anterior; empiezo una nueva')
        job.sessionId = null
        try { extra.onSession && extra.onSession(null) } catch { /* ignore */ }
        launch(null)
        return
      }
      let result = null
      if (code === 0 && !eventError) {
        try { result = successCheck() } catch { result = null }
      }
      if (result) {
        job.status = 'done'; job.result = result
        pushLog(key, 'Listo ✓' + (job.cost && job.cost.cost != null ? ` · $${job.cost.cost.toFixed(2)}` : ''))
        finish(key, job, { ok: true, result, cost: job.cost })
      } else {
        job.status = 'error'
        const tail = (lastErr || streamError).trim().split('\n').slice(-3).join(' ').slice(-300)
        job.error = `${eventError || `el agente terminó (código ${code}) sin el resultado esperado.`}${tail ? ' ' + tail : ''} (log completo: ${job.logFile})`
        pushLog(key, 'Error: sin resultado esperado')
        finish(key, job, { ok: false, error: job.error, logFile: job.logFile })
      }
    })
  }

  launch(extra.resumeId || null)
  return { started: true }
}

function cancel(key) {
  const job = agentJobs.get(key)
  if (job && job.child && job.status === 'running') {
    job.status = 'cancelled'
    killGroup(job.child.pid, 'SIGTERM')
    setTimeout(() => { if (job.child && isAlive(job.child.pid)) killGroup(job.child.pid, 'SIGKILL') }, KILL_ESCALATE_MS)
    return { ok: true }
  }
  return { ok: false }
}

function status(key) {
  const job = agentJobs.get(key)
  if (!job) return null
  return {
    status: job.status,
    provider: job.provider,
    log: job.log.slice(-200),
    events: job.events.slice(-200),
    error: job.error || null,
    result: job.result || null,
    cost: job.cost || null,
    started: job.started,
    logFile: job.logFile,
  }
}

function cancelAll() {
  for (const key of agentJobs.keys()) cancel(key)
}

module.exports = {
  agentJobs, runAgentJob, cancel, cancelAll, status, progressFromEvent, claudePath, heygenEnv, serviceEnv,
  cleanupOrphans, broadcast, pushLog,
  agentPath, selectedProvider,
}

