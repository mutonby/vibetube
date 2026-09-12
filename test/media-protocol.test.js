'use strict'
require('./electron-stub')
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const media = require('../electron/media-protocol')

test('rsmedia solo sirve dentro de las raíces permitidas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'))
  media.allowRoot(root)
  assert.equal(media.isAllowed(path.join(root, 'p', 'a.mp4')), true)
  assert.equal(media.isAllowed('/etc/passwd'), false)
  assert.equal(media.isAllowed(path.join(root, '..', 'x.mp4')), false)
})
