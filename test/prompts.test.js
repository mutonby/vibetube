'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const p = require('../electron/prompts')

test('normAspect / aspectGoal', () => {
  assert.equal(p.normAspect({ aspect: '16:9' }), '16:9')
  assert.equal(p.normAspect({ aspect: 'x' }), 'both')
  assert.equal(p.normAspect(null), 'both')
  assert.match(p.aspectGoal({ aspect: '9:16' }), /final_9x16/)
  assert.match(p.aspectGoal({}), /BOTH/)
})

test('optsLines respeta subtítulos, sfx y menubar', () => {
  const off = p.optsLines({ subtitles: false, sfx: false }).join('\n')
  assert.match(off, /SUBTITLES: OFF/)
  assert.doesNotMatch(off, /HeyGen/)
  const on = p.optsLines({ cropMenubar: true }).join('\n')
  assert.match(on, /screen_crop/)
  assert.match(on, /HeyGen/)
})

test('composePrompt incluye el contexto de guion solo si existe script.md', () => {
  assert.doesNotMatch(p.composePrompt({}), /SCRIPT AWARENESS/)
  assert.match(p.composePrompt({}, { hasScript: true }), /SCRIPT AWARENESS/)
  assert.match(p.iteratePrompt('más corto', {}, { hasScript: true }), /script\.md/)
})

test('durationMinutes y objetivo de palabras según ritmo real', () => {
  assert.equal(p.durationMinutes('30s'), 0.5)
  assert.equal(p.durationMinutes('3 min'), 3)
  assert.equal(p.durationMinutes(''), null)
  const l = p.scriptOptsLines({ duration: '5 min' }, { wpm: 160 }).join('\n')
  assert.match(l, /~800 words/)
  const auto = p.scriptOptsLines({}, { median_minutes: 12 }).join('\n')
  assert.match(auto, /~12 min/)
})

test('generatePrompt: brief, ganchos, fuentes y pares de feedback', () => {
  const s = p.generatePrompt('Tema X', { goal: 'tutorial', cta: 'repo', demo: 'yes', avoid: 'competidor' }, '/r/_scripts/drafts/g_1.md', { pace: { wpm: 150 }, feedbackPairs: ['g_0'] })
  assert.match(s, /Tema X/)
  assert.match(s, /g_1\.sources\.md/)
  assert.match(s, /THREE alternative hooks/)
  assert.match(s, /\[PANTALLA:/)
  assert.match(s, /competidor/)
  assert.match(s, /feedback\//)
  assert.match(s, /g_0/)
  assert.doesNotMatch(p.generatePrompt('t', {}, '/a.md', {}), /feedback\//)
})

test('analyzePrompt incremental no reconstruye de cero', () => {
  assert.match(p.analyzePrompt('https://youtube.com/@x', { incremental: true }), /INCREMENTAL UPDATE/)
  assert.match(p.analyzePrompt('https://youtube.com/@x'), /pace\.json/)
})
