'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const p = require('../electron/providers')
const prompts = require('../electron/prompts')

test('Codex exec fresh/resume isolate prompts and preserve workspace permissions', () => {
  const prompt = '--help\nTexto con "comillas", $HOME y `comandos`'
  for (const resumeId of [null, 'thread-123']) {
    const args = p.headlessArgs('codex', { cwd: '/tmp/project', prompt, resumeId, maxTurns: 400 })
    assert.deepEqual(args.slice(-2), ['--', prompt])
    assert.equal(args[0], 'exec')
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write')
    assert.ok(args.includes('--json'))
    assert.ok(args.includes('--skip-git-repo-check'))
    assert.ok(!args.includes('--max-turns'))
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'))
    if (resumeId) {
      assert.ok(args.indexOf('--sandbox') < args.indexOf('resume'))
      assert.equal(args[args.indexOf('resume') + 1], resumeId)
    } else assert.ok(!args.includes('resume'))
  }
  const claude = p.headlessArgs('claude', { cwd: '/tmp/project', prompt, resumeId: 'old', maxTurns: 400 })
  assert.ok(claude.includes('--resume'))
  assert.ok(claude.includes('--max-turns'))
  assert.equal(claude[1], prompt)
})

test('interactive CLI resumes in project and never fixes a model', () => {
  const codex = p.terminalArgs('codex', { resume: true })
  assert.deepEqual(codex.slice(-2), ['resume', '--last'])
  assert.ok(!codex.includes('--all'))
  for (const provider of ['claude', 'codex']) {
    const args = p.terminalArgs(provider, { seed: 'proponer plan' })
    assert.ok(args.includes('proponer plan'))
    assert.ok(!args.includes('--model'))
  }
})

test('legacy Claude sessions are not passed to Codex and each provider keeps its session', () => {
  const project = { agentSession: 'legacy' }
  assert.equal(p.sessionFor(project, 'claude'), 'legacy')
  assert.equal(p.sessionFor(project, 'codex'), null)
  p.setSession(project, 'codex', 'codex-thread')
  p.setSession(project, 'claude', 'new-claude')
  assert.equal(p.sessionFor(project, 'codex'), 'codex-thread')
  assert.equal(p.sessionFor(project, 'claude'), 'new-claude')
  assert.equal(project.agentSession, 'new-claude')
  p.setSession(project, 'codex', null)
  assert.equal(p.sessionFor(project, 'codex'), null)
  assert.equal(p.sessionFor(project, 'claude'), 'new-claude')
})

test('project instructions preserve user text, update options, and locate bundled skill', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-instructions-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'AGENTS.md')
  fs.writeFileSync(file, '# Mis instrucciones\nNo borrar clips.\n')
  p.writeProjectInstructions(dir, 'codex', 'Primera versión')
  fs.appendFileSync(file, '\nMás instrucciones del usuario.\n')
  p.writeProjectInstructions(dir, 'codex', 'Segunda versión')
  const result = fs.readFileSync(file, 'utf8')
  assert.match(result, /^# Mis instrucciones\nNo borrar clips\./)
  assert.match(result, /Más instrucciones del usuario/)
  assert.match(result, /Segunda versión/)
  assert.doesNotMatch(result, /Primera versión/)
  assert.equal(result.split('<!-- record-studio:begin -->').length, 2)
  assert.ok(result.includes(path.resolve(__dirname, '../video-use/SKILL.md')))
  assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.md')))
  const ctx = { skillContext: p.skillContext() }
  assert.ok(prompts.composePrompt({}, ctx).includes(ctx.skillContext))
  assert.ok(prompts.iteratePrompt('corta', {}, ctx).includes(ctx.skillContext))
})

test('Codex events expose commands, messages, usage and terminal failure', () => {
  assert.deepEqual(p.codexProgress({ type: 'item.started', item: { type: 'command_execution', command: 'ffmpeg -i webcam.webm\necho done' } }),
    { kind: 'cmd', label: 'ffmpeg -i webcam.webm' })
  assert.equal(p.codexProgress({ type: 'item.completed', item: { type: 'agent_message', text: ' Vídeo\n listo ' } }).label, 'Vídeo listo')
  assert.equal(p.codexProgress({ type: 'item.started', item: { type: 'web_search' } }).kind, 'tool')
  const usage = { input_tokens: 12, cached_input_tokens: 4, output_tokens: 8 }
  const result = p.codexProgress({ type: 'turn.completed', usage })
  assert.deepEqual(result.usage, usage)
  assert.equal(result.cost, null)
  assert.equal(result.isError, false)
  assert.equal(p.codexProgress({ type: 'turn.failed', error: { message: 'Auth failed' } }).isError, true)
  assert.equal(p.codexProgress({ type: 'error', message: 'Reconnecting' }).kind, 'status')
  assert.equal(p.codexProgress({ type: 'unknown' }), null)
})
