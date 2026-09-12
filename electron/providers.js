'use strict'

// CLI-specific contracts; no Electron dependency, so these can be tested directly.
const path = require('path')
const fs = require('fs')
const { writeFileAtomic } = require('./util')

function normalizeProvider(value) { return value === 'codex' ? 'codex' : 'claude' }
function providerLabel(value) { return normalizeProvider(value) === 'codex' ? 'Codex' : 'Claude Code' }
function instructionsFile(provider) { return provider === 'codex' ? 'AGENTS.md' : 'CLAUDE.md' }

function headlessArgs(provider, { cwd, prompt, resumeId, maxTurns }) {
  if (provider === 'codex') {
    // exec options precede resume: resume does not accept --sandbox itself.
    const args = ['exec', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"',
      '-c', 'sandbox_workspace_write.network_access=true', '-c', 'web_search="live"',
      '--json', '--skip-git-repo-check']
    if (resumeId) args.push('resume', resumeId)
    return [...args, '--', prompt]
  }
  const args = ['-p', prompt, '--add-dir', cwd, '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose']
  if (maxTurns) args.push('--max-turns', String(maxTurns))
  if (resumeId) args.push('--resume', resumeId)
  return args
}

function terminalArgs(provider, { resume, seed }) {
  if (provider === 'codex') {
    const args = ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--search',
      '-c', 'sandbox_workspace_write.network_access=true']
    return resume ? [...args, 'resume', '--last'] : [...args, '--', seed]
  }
  return resume ? ['--continue'] : [seed, '--permission-mode', 'plan']
}

function sessionFor(project, provider) {
  return project?.agentSessions?.[provider] || (provider === 'claude' ? project?.agentSession : null) || null
}
function setSession(project, provider, id) {
  project.agentSessions = { ...project.agentSessions, [provider]: id }
  if (provider === 'claude') project.agentSession = id // legacy projects remain compatible
}

function skillContext() {
  const skill = path.resolve(__dirname, '..', 'video-use', 'SKILL.md')
  return `Read the bundled video-use skill at ${JSON.stringify(skill)} before editing video. Resolve its helper and reference paths relative to ${JSON.stringify(path.dirname(skill))}. Write project outputs in the current project directory.`
}

// Refresh only our block, preserving any instructions the user already wrote.
function writeProjectInstructions(dir, provider, brief) {
  const file = path.join(dir, instructionsFile(provider))
  const start = '<!-- record-studio:begin -->'
  const end = '<!-- record-studio:end -->'
  const block = `${start}\n${brief}\n\n${skillContext()}\n${end}`
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const from = old.indexOf(start)
  const to = old.indexOf(end, from)
  const text = from >= 0 && to >= 0
    ? old.slice(0, from) + block + old.slice(to + end.length)
    : old + (old ? '\n\n' : '') + block + '\n'
  fs.mkdirSync(dir, { recursive: true })
  writeFileAtomic(file, text)
}

function codexProgress(ev) {
  if (!ev || typeof ev !== 'object') return null
  const item = ev.item
  if (item && ev.type === 'item.started') {
    if (item.type === 'command_execution') return { kind: 'cmd', label: String(item.command || '').split('\n')[0].slice(0, 120) }
    if (item.type === 'mcp_tool_call') return { kind: 'tool', label: `${item.server || 'MCP'} · ${item.tool || 'tool'}` }
    if (item.type === 'web_search') return { kind: 'tool', label: 'Buscar en la web' }
  }
  if (item && ev.type === 'item.completed') {
    if (item.type === 'agent_message') return { kind: 'text', label: String(item.text || '').trim().replace(/\s+/g, ' ').slice(0, 400) }
    if (item.type === 'file_change') return { kind: 'tool', label: 'Archivos: ' + (item.changes || []).map((c) => c.path).join(', ').slice(0, 200) }
  }
  if (ev.type === 'turn.completed') {
    const usage = ev.usage || null
    return { kind: 'result', label: 'agente terminado' + (usage ? ` · ${usage.input_tokens || 0} tokens entrada · ${usage.output_tokens || 0} salida` : ''),
      cost: null, turns: null, durationMs: null, usage, isError: false }
  }
  if (ev.type === 'turn.failed') {
    return { kind: 'result', label: 'error en el agente: ' + (ev.error?.message || 'turno fallido'),
      cost: null, turns: null, durationMs: null, isError: true }
  }
  // `error` can be a recoverable reconnect; turn.failed/exit code determine failure.
  if (ev.type === 'error') return { kind: 'status', label: ev.message || 'Error de Codex' }
  return null
}

module.exports = { normalizeProvider, providerLabel, instructionsFile, headlessArgs, terminalArgs,
  sessionFor, setSession, skillContext, writeProjectInstructions, codexProgress }
