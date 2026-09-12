'use strict'
require('./electron-stub')
const test = require('node:test')
const assert = require('node:assert/strict')
const { progressFromEvent } = require('../electron/agent')

test('progressFromEvent: comandos, herramientas, texto', () => {
  const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la\necho' } }] } }
  assert.deepEqual(progressFromEvent(bash), { kind: 'cmd', label: 'ls -la' })
  const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }
  assert.deepEqual(progressFromEvent(tool), { kind: 'tool', label: 'Read' })
  const txt = { type: 'assistant', message: { content: [{ type: 'text', text: '  hola\n  mundo ' }] } }
  assert.deepEqual(progressFromEvent(txt), { kind: 'text', label: 'hola mundo' })
  assert.equal(progressFromEvent(null), null)
  assert.equal(progressFromEvent({ type: 'system' }), null)
})

test('progressFromEvent: result con coste y turnos', () => {
  const r = progressFromEvent({ type: 'result', is_error: false, total_cost_usd: 1.234, num_turns: 42, duration_ms: 125000 })
  assert.equal(r.kind, 'result')
  assert.equal(r.cost, 1.234)
  assert.equal(r.turns, 42)
  assert.match(r.label, /\$1\.23 · 42 turnos · 2 min/)
  const e = progressFromEvent({ type: 'result', is_error: true })
  assert.match(e.label, /error/)
  assert.equal(e.cost, null)
})
