'use strict'

// Cliente de Upload-Post: publica el vídeo final en YouTube y compañía.
//
// La API acepta el fichero directamente (multipart), así que no hace falta el
// rodeo de subir a una URL pública primero: la app y el vídeo están en la misma
// máquina. La subida es asíncrona — devuelve un request_id que se consulta hasta
// que el estado deja de ser "processing".

const fs = require('node:fs')
const path = require('node:path')

const API_BASE = process.env.UPLOAD_POST_API_BASE || 'https://api.upload-post.com'

// Plataformas que aceptan un vídeo y que tiene sentido ofrecer desde aquí, con
// la proporción que espera cada una. Reddit está caído en la API (error_code
// reddit_unavailable), así que no se ofrece.
const VIDEO_PLATFORMS = [
  { id: 'youtube', label: 'YouTube', aspect: '169' },
  { id: 'tiktok', label: 'TikTok', aspect: '916' },
  { id: 'instagram', label: 'Instagram', aspect: '916' },
  { id: 'facebook', label: 'Facebook', aspect: '916' },
  { id: 'linkedin', label: 'LinkedIn', aspect: '169' },
  { id: 'x', label: 'X', aspect: '169' },
  { id: 'threads', label: 'Threads', aspect: '916' },
  { id: 'pinterest', label: 'Pinterest', aspect: '916' },
  { id: 'bluesky', label: 'Bluesky', aspect: '169' },
  { id: 'telegram', label: 'Telegram', aspect: '169' },
  { id: 'discord', label: 'Discord', aspect: '169' },
]

// ---- helpers puros (testeados) --------------------------------------------------

// De la respuesta de /users a lo que necesita la interfaz: perfil + plataformas
// de vídeo realmente conectadas, en el orden en que las mostramos.
function profilesFromApi(json) {
  const list = (json && json.profiles) || []
  return list.map((p) => {
    const accounts = p.social_accounts || {}
    const connected = VIDEO_PLATFORMS
      .filter((pl) => {
        const v = accounts[pl.id]
        return !!v && !(typeof v === 'object' && Object.keys(v).length === 0)
      })
      .map((pl) => pl.id)
    return { username: p.username, platforms: connected }
  }).filter((p) => p.username)
}

// La proporción que le va mejor a cada plataforma, para preseleccionar el
// fichero. Si el montaje no generó ese aspecto, se cae al que exista.
function aspectFor(platformId, available) {
  const pl = VIDEO_PLATFORMS.find((p) => p.id === platformId)
  const want = pl ? pl.aspect : '169'
  if (available.includes(want)) return want
  return available[0] || null
}

// Estado legible a partir de la respuesta de /status. Devuelve siempre la misma
// forma para que la interfaz no tenga que adivinar.
function summarizeStatus(json) {
  const status = (json && json.status) || 'unknown'
  const results = (json && json.results) || []
  const done = status === 'completed' || status === 'success' || status === 'failed'
  return {
    done,
    status,
    completed: (json && json.completed) || 0,
    total: (json && json.total) || 0,
    results: results.map((r) => ({
      platform: r.platform,
      ok: !!r.success,
      url: r.post_url || null,
      error: r.error_message || r.error_code || null,
    })),
  }
}

// ---- capítulos de YouTube --------------------------------------------------------
//
// YouTube no muestra NINGÚN capítulo si la lista incumple alguna de sus reglas:
// el primero en 00:00, tres como mínimo, orden ascendente y al menos 10 s cada
// uno. El modelo cumple casi siempre, pero basta un capítulo de 8 s para que la
// función entera desaparezca en silencio, así que se corrige antes de publicar.
const MIN_CHAPTER_S = 10

function parseTime(t) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(t || '').trim())
  if (!m) return null
  return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3])
}
function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const mm = h ? String(m).padStart(2, '0') : String(m).padStart(2, '0')
  return (h ? `${h}:` : '') + `${mm}:${String(r).padStart(2, '0')}`
}

// Devuelve la lista saneada y qué se tocó, para poder avisar en la interfaz.
function normalizeChapters(chapters) {
  const parsed = (chapters || [])
    .map((c) => ({ sec: parseTime(c && (c.time || c.start)), label: String((c && c.label) || '').trim() }))
    .filter((c) => c.sec !== null && c.label)
    .sort((a, b) => a.sec - b.sec)
  const dropped = []
  const kept = []
  for (const c of parsed) {
    if (!kept.length) { kept.push({ ...c, sec: 0 }); continue } // el primero manda a 00:00
    if (c.sec - kept[kept.length - 1].sec < MIN_CHAPTER_S) { dropped.push(c.label); continue }
    kept.push(c)
  }
  const list = kept.map((c) => ({ time: fmtTime(c.sec), label: c.label }))
  return {
    chapters: list,
    dropped,
    // Con menos de tres, YouTube tampoco los pinta: mejor no ofrecerlos.
    usable: list.length >= 3,
  }
}

// Reescribe el bloque de capítulos dentro de la descripción con la lista
// saneada, respetando el resto del texto tal cual lo escribió el agente.
function applyChapters(description, chapters) {
  const lines = String(description || '').split('\n')
  const isChapter = (l) => /^\s*(?:\d+:)?\d{1,2}:\d{2}\s+\S/.test(l)
  const first = lines.findIndex(isChapter)
  if (first < 0) return description
  let last = first
  while (last + 1 < lines.length && (isChapter(lines[last + 1]) || !lines[last + 1].trim())) {
    if (isChapter(lines[last + 1])) last = last + 1
    else break
  }
  const block = chapters.map((c) => `${c.time} ${c.label}`)
  return [...lines.slice(0, first), ...block, ...lines.slice(last + 1)].join('\n')
}

// Campos del multipart. Aparte para poder comprobarlos sin tocar la red.
function publishFields(opts) {
  const fields = [
    ['user', opts.profile],
    ['title', opts.title || ''],
    ['async_upload', 'true'],
  ]
  for (const p of opts.platforms) fields.push(['platform[]', p])
  if (opts.description) fields.push(['description', opts.description])
  if (opts.platforms.includes('youtube')) {
    fields.push(['youtube_privacy_status', opts.youtubePrivacy || 'private'])
    if (opts.tags && opts.tags.length) fields.push(['youtube_tags', opts.tags.join(',')])
  }
  return fields
}

// ---- red ------------------------------------------------------------------------

function headers(apiKey) {
  return { Authorization: `Apikey ${apiKey}` }
}

async function listProfiles(apiKey) {
  const res = await fetch(`${API_BASE}/api/uploadposts/users`, { headers: headers(apiKey) })
  if (!res.ok) throw new Error(`Upload-Post ${res.status}: could not list profiles`)
  return profilesFromApi(await res.json())
}

async function validateKey(apiKey) {
  const res = await fetch(`${API_BASE}/api/uploadposts/me`, { headers: headers(apiKey) })
  if (!res.ok) throw new Error(`Upload-Post ${res.status}: invalid API key`)
  const j = await res.json()
  return { email: j.email || null, plan: j.plan || null }
}

// Sube el fichero. `fs.openAsBlob` lo transmite desde disco en vez de cargar
// cientos de MB en memoria, que es justo lo que pesa un final.mp4.
async function publish(apiKey, opts) {
  const stat = fs.statSync(opts.videoPath)
  if (!stat.isFile() || stat.size === 0) throw new Error('the video file is empty or missing')
  const form = new FormData()
  for (const [k, v] of publishFields(opts)) form.append(k, v)
  const blob = await fs.openAsBlob(opts.videoPath, { type: 'video/mp4' })
  form.append('video', blob, path.basename(opts.videoPath))
  const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', headers: headers(apiKey), body: form })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json.request_id) {
    throw new Error(json.message || json.error || `Upload-Post ${res.status}: upload rejected`)
  }
  return { requestId: json.request_id, jobId: json.job_id || null, total: json.total_platforms || opts.platforms.length }
}

async function status(apiKey, requestId) {
  const url = `${API_BASE}/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`
  const res = await fetch(url, { headers: headers(apiKey) })
  if (!res.ok) throw new Error(`Upload-Post ${res.status}: could not read status`)
  return summarizeStatus(await res.json())
}

module.exports = {
  API_BASE, VIDEO_PLATFORMS,
  profilesFromApi, aspectFor, summarizeStatus, publishFields,
  parseTime, fmtTime, normalizeChapters, applyChapters, MIN_CHAPTER_S,
  listProfiles, validateKey, publish, status,
}
