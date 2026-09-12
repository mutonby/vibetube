'use strict'
require('./electron-stub')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const cp = require('child_process')

// Simulate both CLIs at the process boundary: no login, paid calls or real agents.
let children = []
cp.spawnSync = () => ({ status: 0 })
cp.spawn = (binary, args, options) => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  children.push({ child, binary, args, options })
  return child
}
const agent = require('../electron/agent')

function setup(t, extra = {}, check = () => ({ file: 'final.mp4' })) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-agent-run-'))
  t.after(() => {
    const job = agent.agentJobs.get(cwd)
    clearTimeout(job?.idleTimer); clearTimeout(job?.hardTimer)
    agent.agentJobs.delete(cwd)
    fs.rmSync(cwd, { recursive: true, force: true })
  })
  children = []
  const result = agent.runAgentJob(cwd, cwd, 'Escribe un guion', check, 'Probando', { provider: 'codex', ...extra })
  assert.equal(result.started, true)
  return { cwd, child: children[0].child }
}

test('Codex job handles fragmented UTF-8, last JSON line without newline and session/usage callbacks', (t) => {
  const sessions = [], costs = []
  const { cwd, child } = setup(t, { onSession: (s) => sessions.push(s), onResult: (c) => costs.push(c) })
  const payload = Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 'codex-1' }) + '\n' +
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Vídeo listo' } }) + '\n' +
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }))
  const split = payload.indexOf(Buffer.from('í')) + 1
  child.stdout.write(payload.subarray(0, split))
  child.stdout.write(payload.subarray(split))
  child.emit('close', 0)
  assert.deepEqual(sessions, ['codex-1'])
  assert.equal(costs[0].usage.output_tokens, 3)
  assert.equal(agent.status(cwd).status, 'done')
  assert.ok(agent.status(cwd).log.includes('Vídeo listo'))
})

test('failed turn or nonzero exit cannot succeed because an old output exists', (t) => {
  for (const code of [0, 1]) {
    const { cwd, child } = setup(t)
    if (code === 0) child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'Authentication failed' } }) + '\n')
    child.emit('close', code)
    assert.equal(agent.status(cwd).status, 'error')
  }
})

test('missing saved thread retries once as a fresh Codex job', (t) => {
  const sessions = []
  const { cwd, child } = setup(t, { resumeId: 'gone', onSession: (s) => sessions.push(s) })
  child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'Session not found' } }) + '\n')
  child.emit('close', 1)
  assert.equal(children.length, 2)
  assert.ok(children[0].args.includes('resume'))
  assert.ok(!children[1].args.includes('resume'))
  children[1].child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'new' }) + '\n')
  children[1].child.emit('close', 0)
  assert.deepEqual(sessions, [null, 'new'])
  assert.equal(agent.status(cwd).status, 'done')
})

test('authentication error during resume does not retry and spawn errors stay failures', (t) => {
  const first = setup(t, { resumeId: 'valid' })
  first.child.stderr.write('Authentication failed for session valid')
  first.child.emit('close', 1)
  assert.equal(children.length, 1)
  assert.equal(agent.status(first.cwd).status, 'error')
  const second = setup(t)
  second.child.emit('error', new Error('ENOENT'))
  second.child.emit('close', -2)
  assert.equal(agent.status(second.cwd).status, 'error')
})

test('Codex error events are reported on failure but reconnects can recover', (t) => {
  const first = setup(t)
  first.child.stdout.write(JSON.stringify({ type: 'error', message: 'Login required' }) + '\n')
  first.child.emit('close', 1)
  assert.match(agent.status(first.cwd).error, /Login required/)
  const second = setup(t)
  second.child.stdout.write(JSON.stringify({ type: 'error', message: 'Reconnecting' }) + '\n')
  second.child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n')
  second.child.emit('close', 0)
  assert.equal(agent.status(second.cwd).status, 'done')
})

test('Claude headless remains compatible with result events and resume', (t) => {
  const sessions = []
  const { cwd, child } = setup(t, { provider: 'claude', resumeId: 'legacy', onSession: (s) => sessions.push(s) })
  assert.ok(children[0].args.includes('--resume'))
  child.stdout.write(JSON.stringify({ type: 'result', session_id: 'legacy', total_cost_usd: 0.1, num_turns: 2, duration_ms: 100 }) + '\n')
  child.emit('close', 0)
  assert.deepEqual(sessions, ['legacy'])
  assert.equal(agent.status(cwd).cost.cost, 0.1)
  assert.equal(agent.status(cwd).status, 'done')
})
