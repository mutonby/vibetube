'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { AwakeLock } = require('../electron/awake')

function fakeBlocker() {
  const started = new Set()
  return {
    calls: [], started,
    start(type) { this.calls.push(type); const id = this.calls.length; started.add(id); return id },
    stop(id) { started.delete(id) },
    isStarted(id) { return started.has(id) },
  }
}

test('la toma mantiene la pantalla despierta y la suelta al terminar', () => {
  const blocker = fakeBlocker(), lock = new AwakeLock(blocker)
  assert.equal(lock.active, false)
  const id = lock.acquire()
  assert.deepEqual(blocker.calls, ['prevent-display-sleep'])
  assert.equal(lock.active, true)
  assert.equal(blocker.isStarted(id), true)
  lock.release()
  assert.equal(lock.active, false)
  assert.equal(blocker.isStarted(id), false)
})

test('varias tomas seguidas comparten un único bloqueo', () => {
  const blocker = fakeBlocker(), lock = new AwakeLock(blocker)
  assert.equal(lock.acquire(), lock.acquire())
  assert.equal(blocker.calls.length, 1)
  lock.release()
  assert.equal(blocker.started.size, 0)
})

test('soltar sin haber pedido, o dos veces, no toca el sistema', () => {
  const blocker = fakeBlocker(), lock = new AwakeLock(blocker)
  lock.release()
  lock.acquire(); lock.release(); lock.release()
  assert.equal(blocker.calls.length, 1)
  assert.equal(blocker.started.size, 0)
})

test('si el sistema soltó el bloqueo, la siguiente toma lo vuelve a pedir', () => {
  const blocker = fakeBlocker(), lock = new AwakeLock(blocker)
  const id = lock.acquire()
  blocker.stop(id) // macOS lo retira por su cuenta
  assert.equal(lock.active, false)
  assert.notEqual(lock.acquire(), id)
  assert.equal(blocker.calls.length, 2)
  assert.equal(lock.active, true)
})
