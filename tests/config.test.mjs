// Stage 1 config validation + recursion guard tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../dist/index.js'

test('valid config passes and derives the default providerId', () => {
  const c = validateConfig({ upstreamProvider: 'deepseek-official', visionProvider: 'vision-route', visionModel: 'vision-1' })
  assert.deepEqual(c, {
    upstreamProvider: 'deepseek-official',
    visionProvider: 'vision-route',
    visionModel: 'vision-1',
    providerId: 'deepseek-official-vision-bridge',
  })
})

test('explicit providerId is honored', () => {
  const c = validateConfig({ upstreamProvider: 'u', visionProvider: 'v', visionModel: 'm', providerId: 'my-bridge' })
  assert.equal(c.providerId, 'my-bridge')
})

for (const key of ['upstreamProvider', 'visionProvider', 'visionModel']) {
  test(`missing "${key}" throws`, () => {
    const cfg = { upstreamProvider: 'u', visionProvider: 'v', visionModel: 'm' }
    delete cfg[key]
    assert.throws(() => validateConfig(cfg), new RegExp(key))
  })
  test(`empty "${key}" throws`, () => {
    const cfg = { upstreamProvider: 'u', visionProvider: 'v', visionModel: 'm' }
    cfg[key] = '  '
    assert.throws(() => validateConfig(cfg), new RegExp(key))
  })
  test(`non-string "${key}" throws`, () => {
    const cfg = { upstreamProvider: 'u', visionProvider: 'v', visionModel: 'm' }
    cfg[key] = 42
    assert.throws(() => validateConfig(cfg), new RegExp(key))
  })
}

test('recursion guard: providerId === upstreamProvider rejected', () => {
  assert.throws(
    () => validateConfig({ upstreamProvider: 'u', visionProvider: 'v', visionModel: 'm', providerId: 'u' }),
    /must not equal upstreamProvider/,
  )
})

test('recursion guard: providerId === visionProvider rejected', () => {
  assert.throws(
    () => validateConfig({ upstreamProvider: 'u', visionProvider: 'v', visionModel: 'm', providerId: 'v' }),
    /must not equal visionProvider/,
  )
})

test('upstreamProvider === visionProvider is ALLOWED (same route, different models)', () => {
  const c = validateConfig({ upstreamProvider: 'dual-route', visionProvider: 'dual-route', visionModel: 'vision-model' })
  assert.equal(c.upstreamProvider, 'dual-route')
  assert.equal(c.visionProvider, 'dual-route')
  assert.equal(c.providerId, 'dual-route-vision-bridge')
})
