'use strict'

// A small copy of the already processed camera feeds the floating bar. Never
// open another camera or run another segmentation model while recording.
window.installFloatPreview = function (api, getSource) {
  const canvas = new OffscreenCanvas(320, 180)
  let busy = false
  api.onPreviewRequest(async () => {
    if (busy) return
    busy = true
    try {
      const { source, rect } = getSource()
      const width = source?.videoWidth || source?.width
      const height = source?.videoHeight || source?.height
      if (!width || !height) return
      const r = rect || { x: 0, y: 0, w: 1, h: 1 }
      const outHeight = Math.max(2, Math.min(480, Math.round(320 * height * r.h / (width * r.w))))
      if (canvas.height !== outHeight) canvas.height = outHeight
      canvas.getContext('2d').drawImage(source, r.x * width, r.y * height, r.w * width, r.h * height, 0, 0, 320, outHeight)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
      api.sendPreview(await blob.arrayBuffer())
    } catch (error) { console.warn('[float-preview]', error.message) }
    finally { busy = false }
  })
}
