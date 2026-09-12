'use strict'

const panel = document.getElementById('tp')
const textEl = document.getElementById('text')
const playBtn = document.getElementById('play')
const loadSel = document.getElementById('loadSel')
const savedEl = document.getElementById('saved')

let playing = false
let speed = 1.0
let fontSize = 30
let currentPath = '' // loaded script file, '' = none (saves only to project prompter)
let saveTimer = null

function setScripts(scripts, selected) {
  loadSel.innerHTML = '<option value="">— guion —</option>'
  for (const s of scripts || []) {
    const o = document.createElement('option')
    o.value = s.path
    o.textContent = s.title
    loadSel.appendChild(o)
  }
  loadSel.value = selected || ''
}

window.tp.onInit((p) => {
  if (p && typeof p.text === 'string') loadText(p.text)
  currentPath = (p && p.currentPath) || ''
  setScripts((p && p.scripts) || [], currentPath)
})
window.tp.onText((text) => { if (typeof text === 'string') loadText(text) })
window.tp.onLoaded((p) => { // a script was loaded by us
  if (p && typeof p.text === 'string') loadText(p.text)
  currentPath = (p && p.path) || ''
  loadSel.value = currentPath
  flashSaved('cargado')
})

function restart() {
  setPlaying(false)
  textEl.setSelectionRange(0, 0)
  textEl.scrollTop = 0
  panel.scrollTop = 0
}
function loadText(text) {
  textEl.value = text
  restart()
}

function tick() {
  if (!playing) return
  textEl.scrollTop += speed
  if (textEl.scrollTop + textEl.clientHeight >= textEl.scrollHeight - 1) setPlaying(false)
}
function setPlaying(on) {
  playing = on
  playBtn.textContent = on ? '⏸' : '▶'
  playBtn.classList.toggle('play', !on)
}
function flashSaved(msg) {
  savedEl.textContent = msg || '✓ guardado'
  clearTimeout(flashSaved._t)
  flashSaved._t = setTimeout(() => { savedEl.textContent = '' }, 1600)
}
function save() {
  window.tp.save({ text: textEl.value, path: currentPath })
  flashSaved('✓ guardado')
}
function autoSave() {
  clearTimeout(saveTimer)
  savedEl.textContent = '…'
  saveTimer = setTimeout(save, 800)
}

playBtn.addEventListener('click', () => setPlaying(!playing))
document.getElementById('slower').addEventListener('click', () => { speed = Math.max(0.2, speed - 0.3) })
document.getElementById('faster').addEventListener('click', () => { speed += 0.3 })
document.getElementById('smaller').addEventListener('click', () => { fontSize = Math.max(16, fontSize - 3); textEl.style.fontSize = fontSize + 'px' })
document.getElementById('bigger').addEventListener('click', () => { fontSize += 3; textEl.style.fontSize = fontSize + 'px' })
document.getElementById('restart').addEventListener('click', restart)
document.getElementById('close').addEventListener('click', () => window.tp.close())
document.getElementById('save').addEventListener('click', save)
loadSel.addEventListener('change', (e) => { if (e.target.value) window.tp.load(e.target.value) })

document.getElementById('opacity').addEventListener('input', (e) => {
  const a = Math.max(0.08, Math.min(1, e.target.value / 100))
  panel.style.background = `rgba(8,8,12,${a.toFixed(2)})`
})

// Editing pauses auto-scroll and auto-saves (debounced).
textEl.addEventListener('input', () => { if (playing) setPlaying(false); autoSave() })

setInterval(tick, 16)
