'use strict'
const test = require('node:test')
const assert = require('node:assert')
const up = require('../electron/uploadpost')

// Forma real devuelta por GET /api/uploadposts/users (recortada de una respuesta
// de la cuenta de pruebas): las cuentas conectadas vienen como objeto, y las no
// conectadas pueden faltar o venir vacías.
const USERS = {
  success: true,
  profiles: [
    { username: 'automated-tests', social_accounts: { youtube: { id: 'x' }, tiktok: { id: 'y' }, reddit: { id: 'z' }, instagram: {} } },
    { username: 'solo-linkedin', social_accounts: { linkedin: { id: 'l' } } },
    { username: 'vacio', social_accounts: {} },
    { social_accounts: { youtube: { id: 'n' } } },
  ],
}

test('profilesFromApi: solo plataformas de vídeo realmente conectadas', () => {
  const p = up.profilesFromApi(USERS)
  assert.deepEqual(p.map((x) => x.username), ['automated-tests', 'solo-linkedin', 'vacio'])
  // reddit está caído en la API y no se ofrece; instagram viene vacío, no cuenta
  assert.deepEqual(p[0].platforms, ['youtube', 'tiktok'])
  assert.deepEqual(p[1].platforms, ['linkedin'])
  assert.deepEqual(p[2].platforms, [])
})

test('profilesFromApi: tolera respuestas vacías o rotas', () => {
  assert.deepEqual(up.profilesFromApi(null), [])
  assert.deepEqual(up.profilesFromApi({}), [])
  assert.deepEqual(up.profilesFromApi({ profiles: [] }), [])
})

test('aspectFor: cada plataforma pide su proporción, con caída al que exista', () => {
  assert.equal(up.aspectFor('youtube', ['169', '916']), '169')
  assert.equal(up.aspectFor('tiktok', ['169', '916']), '916')
  // si el montaje no generó el vertical, YouTube sigue funcionando y TikTok cae al 16:9
  assert.equal(up.aspectFor('tiktok', ['169']), '169')
  assert.equal(up.aspectFor('youtube', ['916']), '916')
  assert.equal(up.aspectFor('youtube', []), null)
})

test('publishFields: multipart mínimo y overrides de YouTube', () => {
  const f = up.publishFields({ profile: 'p', platforms: ['youtube', 'tiktok'], title: 'T', description: 'D', youtubePrivacy: 'unlisted', tags: ['a', 'b'] })
  const get = (k) => f.filter(([n]) => n === k).map(([, v]) => v)
  assert.deepEqual(get('user'), ['p'])
  assert.deepEqual(get('platform[]'), ['youtube', 'tiktok'])
  assert.deepEqual(get('title'), ['T'])
  assert.deepEqual(get('description'), ['D'])
  assert.deepEqual(get('async_upload'), ['true'])
  assert.deepEqual(get('youtube_privacy_status'), ['unlisted'])
  assert.deepEqual(get('youtube_tags'), ['a,b'])
})

test('publishFields: sin YouTube no se cuelan campos de YouTube', () => {
  const f = up.publishFields({ profile: 'p', platforms: ['tiktok'], title: 'T' })
  assert.equal(f.some(([n]) => n.startsWith('youtube_')), false)
})

test('publishFields: privacidad por defecto privada', () => {
  const f = up.publishFields({ profile: 'p', platforms: ['youtube'], title: 'T' })
  assert.deepEqual(f.filter(([n]) => n === 'youtube_privacy_status').map(([, v]) => v), ['private'])
})

// Respuesta real de GET /api/uploadposts/status (recortada).
test('summarizeStatus: éxito con URL del post', () => {
  const s = up.summarizeStatus({
    status: 'completed', completed: 1, total: 1,
    results: [{ platform: 'youtube', success: true, post_url: 'https://www.youtube.com/watch?v=abc', error_message: null }],
  })
  assert.equal(s.done, true)
  assert.deepEqual(s.results, [{ platform: 'youtube', ok: true, url: 'https://www.youtube.com/watch?v=abc', error: null }])
})

test('summarizeStatus: fallo por plataforma con su motivo', () => {
  const s = up.summarizeStatus({
    status: 'completed', completed: 2, total: 2,
    results: [
      { platform: 'youtube', success: true, post_url: 'https://y/1' },
      { platform: 'tiktok', success: false, error_message: 'quota exceeded' },
    ],
  })
  assert.equal(s.results[1].ok, false)
  assert.equal(s.results[1].error, 'quota exceeded')
})

test('summarizeStatus: en proceso no se da por terminado', () => {
  const s = up.summarizeStatus({ status: 'processing', completed: 0, total: 2, results: [] })
  assert.equal(s.done, false)
  assert.equal(s.total, 2)
})

test('summarizeStatus: respuesta vacía no revienta', () => {
  const s = up.summarizeStatus(null)
  assert.equal(s.done, false)
  assert.deepEqual(s.results, [])
})

// ---- capítulos de YouTube --------------------------------------------------------

test('parseTime / fmtTime: mm:ss y h:mm:ss', () => {
  assert.equal(up.parseTime('00:00'), 0)
  assert.equal(up.parseTime('04:09'), 249)
  assert.equal(up.parseTime('1:02:03'), 3723)
  assert.equal(up.parseTime('basura'), null)
  assert.equal(up.parseTime(null), null)
  assert.equal(up.fmtTime(0), '00:00')
  assert.equal(up.fmtTime(249), '04:09')
  assert.equal(up.fmtTime(3723), '1:02:03')
})

test('normalizeChapters: descarta los que duran menos de 10 s', () => {
  // Caso real: el agente puso 04:09 y 04:17 (8 s), y YouTube se traga la lista entera.
  const n = up.normalizeChapters([
    { time: '00:00', label: 'Intro' },
    { time: '04:09', label: 'A' },
    { time: '04:17', label: 'B' },
    { time: '05:16', label: 'C' },
  ])
  assert.deepEqual(n.chapters.map((c) => c.time), ['00:00', '04:09', '05:16'])
  assert.deepEqual(n.dropped, ['B'])
  assert.equal(n.usable, true)
})

test('normalizeChapters: el primero se fuerza a 00:00 y se ordena', () => {
  const n = up.normalizeChapters([
    { time: '02:00', label: 'B' },
    { time: '00:30', label: 'A' },
    { time: '04:00', label: 'C' },
  ])
  assert.deepEqual(n.chapters, [
    { time: '00:00', label: 'A' }, { time: '02:00', label: 'B' }, { time: '04:00', label: 'C' },
  ])
})

test('normalizeChapters: menos de tres no es usable', () => {
  assert.equal(up.normalizeChapters([{ time: '00:00', label: 'A' }, { time: '01:00', label: 'B' }]).usable, false)
  assert.equal(up.normalizeChapters([]).usable, false)
  assert.equal(up.normalizeChapters(null).usable, false)
})

test('normalizeChapters: descarta entradas rotas sin reventar', () => {
  const n = up.normalizeChapters([
    { time: '00:00', label: 'A' }, { time: 'x', label: 'malo' }, { label: 'sin hora' },
    { time: '01:00' }, { time: '02:00', label: 'B' }, { time: '03:00', label: 'C' },
  ])
  assert.deepEqual(n.chapters.map((c) => c.label), ['A', 'B', 'C'])
})

test('applyChapters: reescribe el bloque y respeta el resto del texto', () => {
  const desc = ['Primera línea.', '', 'Párrafo.', '', '00:00 Viejo', '04:09 Otro', '04:17 Corto', '', 'Links: x.com'].join('\n')
  const out = up.applyChapters(desc, [{ time: '00:00', label: 'Nuevo' }, { time: '04:09', label: 'Otro' }])
  assert.match(out, /^Primera línea\./)
  assert.match(out, /Links: x\.com$/)
  assert.match(out, /00:00 Nuevo/)
  assert.doesNotMatch(out, /04:17/)     // el capítulo corto desaparece del texto
  assert.doesNotMatch(out, /00:00 Viejo/)
})

test('applyChapters: sin bloque de capítulos deja la descripción intacta', () => {
  const d = 'Solo texto, sin timestamps.'
  assert.equal(up.applyChapters(d, [{ time: '00:00', label: 'X' }]), d)
})
