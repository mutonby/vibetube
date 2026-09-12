'use strict'
// Real Chromium layout regression: narrow/short windows must keep the first
// line inside the visible panel, even after focusing the end of a long script.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs'), os = require('node:os')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'rs-tp-check-')))
const script = 'PRIMERA LÍNEA\n' + 'Una línea de prueba suficientemente larga para envolver el texto.\n'.repeat(80)
const timeout = setTimeout(() => app.exit(1), 30000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, frame: false, width: 1097, height: 171,
    webPreferences: { preload: path.resolve(__dirname, '../../electron/tp-preload.js'), backgroundThrottling: false } })
  await win.loadFile(path.resolve(__dirname, '../../src/teleprompter.html'))
  for (const [width, height] of [[1097, 171], [900, 250], [360, 240]]) {
    win.setSize(width, height)
    win.webContents.send('tp-init', { text: script })
    const result = await win.webContents.executeJavaScript(`(async()=>{
      await new Promise(r=>setTimeout(r,50));
      textEl.focus();textEl.setSelectionRange(textEl.value.length,textEl.value.length);textEl.scrollTop=textEl.scrollHeight;
      document.getElementById('play').click();document.getElementById('restart').click();
      await new Promise(r=>setTimeout(r,50));
      const t=textEl.getBoundingClientRect(),p=panel.getBoundingClientRect(),b=document.querySelector('.bar').getBoundingClientRect(),s=getComputedStyle(textEl);
      return {top:t.top,panelTop:p.top,barTop:b.top,bottom:t.bottom,panelBottom:p.bottom,scroll:textEl.scrollTop,panelScroll:panel.scrollTop,playing,firstLineFits:parseFloat(s.paddingTop)+parseFloat(s.lineHeight)<=textEl.clientHeight,value:textEl.value};
    })()`)
    assert.equal(result.value, script)
    assert.equal(result.scroll, 0); assert.equal(result.panelScroll, 0); assert.equal(result.playing, false)
    assert.ok(result.barTop >= result.panelTop && result.top >= result.barTop)
    assert.ok(result.bottom <= result.panelBottom && result.firstLineFits, JSON.stringify(result))
    console.log(`Layout/restart OK: ${width}x${height}`)
  }
  for (const [event, payload] of [['tp-init', { text: 'INICIO' }], ['tp-text', 'INICIO'], ['tp-loaded-window', { path: 'sample', text: 'INICIO' }]]) {
    await win.webContents.executeJavaScript(`textEl.scrollTop=textEl.scrollHeight;setPlaying(true)`)
    win.webContents.send(event, payload)
    const result = await win.webContents.executeJavaScript(`new Promise(r=>setTimeout(()=>r({value:textEl.value,scroll:textEl.scrollTop,playing}),50))`)
    assert.deepEqual(result, { value: 'INICIO', scroll: 0, playing: false })
  }
  console.log('All text-loading paths reset playback and scrolling.')
  clearTimeout(timeout); win.destroy(); app.quit()
}).catch(error => { console.error(error); app.exit(1) })
