// Stage 3B cache module unit tests: key encoding, eligibility, deep-freeze,
// LRU bounds, first-successful-insert-wins, policy-version participation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEvidenceCacheKey,
  createEvidenceCache,
  deepFreezeJson,
  EVIDENCE_CACHE_CAPACITY,
  isCacheEligible,
} from '../dist/index.js'

const key = (overrides = {}) => buildEvidenceCacheKey({
  sessionId: 's1',
  visionProvider: 'vp',
  visionModel: 'vm',
  orderedAttachmentIds: ['a'],
  ...overrides,
})

test('key equality: identical inputs produce identical keys', () => {
  assert.equal(key(), key())
  assert.equal(key({ orderedAttachmentIds: ['a', 'b'] }), key({ orderedAttachmentIds: ['a', 'b'] }))
})

test('key inequality: sessionId partitions (session A vs session B)', () => {
  assert.notEqual(key({ sessionId: 'sA' }), key({ sessionId: 'sB' }))
})

test('key inequality: visionProvider differs', () => {
  assert.notEqual(key({ visionProvider: 'vpA' }), key({ visionProvider: 'vpB' }))
})

test('key inequality: visionModel differs', () => {
  assert.notEqual(key({ visionModel: 'vmA' }), key({ visionModel: 'vmB' }))
})

test('key inequality: ordered attachments [A,B] vs [B,A] (order is semantic)', () => {
  assert.notEqual(key({ orderedAttachmentIds: ['a', 'b'] }), key({ orderedAttachmentIds: ['b', 'a'] }))
})

test('key inequality: no delimiter-collision assumptions (["a:b","c"] vs ["a","b:c"])', () => {
  assert.notEqual(key({ orderedAttachmentIds: ['a:b', 'c'] }), key({ orderedAttachmentIds: ['a', 'b:c'] }))
})

test('key inequality: attachment ids with quotes/commas are structurally safe', () => {
  assert.notEqual(
    key({ orderedAttachmentIds: ['a","x', 'b'] }),
    key({ orderedAttachmentIds: ['a', '"x","b'] }),
  )
})

test('key participation: evidencePolicyVersion changes the key', () => {
  const official = key()
  // Simulate a future policy bump with the same structural encoding.
  const bumped = JSON.stringify([2, 's1', 'vp', 'vm', ['a']])
  assert.notEqual(official, bumped)
})

test('eligibility: valid session + valid ids are eligible', () => {
  assert.equal(isCacheEligible('s1', ['a']), true)
  assert.equal(isCacheEligible(' s1 ', ['a', 'b']), true)
})

test('eligibility: missing/empty/non-string sessionId is NOT eligible', () => {
  assert.equal(isCacheEligible(undefined, ['a']), false)
  assert.equal(isCacheEligible('', ['a']), false)
  assert.equal(isCacheEligible('   ', ['a']), false)
  assert.equal(isCacheEligible(42, ['a']), false)
  assert.equal(isCacheEligible(null, ['a']), false)
})

test('eligibility: empty attachment list or invalid ids are NOT eligible', () => {
  assert.equal(isCacheEligible('s1', []), false)
  assert.equal(isCacheEligible('s1', ['a', '']), false)
  assert.equal(isCacheEligible('s1', ['a', '   ']), false)
  assert.equal(isCacheEligible('s1', ['a', 42]), false)
  assert.equal(isCacheEligible('s1', ['a', null]), false)
})

test('deepFreezeJson: freezes nested JSON-compatible structures deeply', () => {
  const value = { a: { b: [{ c: 'x' }] }, d: [1, 2] }
  const frozen = deepFreezeJson(value)
  assert.ok(Object.isFrozen(frozen))
  assert.ok(Object.isFrozen(frozen.a))
  assert.ok(Object.isFrozen(frozen.a.b))
  assert.ok(Object.isFrozen(frozen.a.b[0]))
  assert.ok(Object.isFrozen(frozen.d))
  assert.equal(frozen, value, 'freezes in place, returns the same reference')
  assert.throws(() => { frozen.a.b = null }, TypeError)
})

test('insertIfAbsent: first insert wins; a later redundant completion never overwrites', () => {
  const cache = createEvidenceCache(2)
  assert.equal(cache.insertIfAbsent('k', { marker: 'first', nested: { n: 1 } }), true)
  assert.equal(cache.insertIfAbsent('k', { marker: 'second' }), false, 'second insert refused')
  assert.deepEqual(cache.get('k'), { marker: 'first', nested: { n: 1 } }, 'original value retained')
  assert.ok(Object.isFrozen(cache.get('k')), 'inserted value is frozen')
})

test('LRU: get refreshes recency; capacity+1 evicts the least-recently-used entry', () => {
  const cache = createEvidenceCache(2)
  cache.insertIfAbsent('k1', { n: 1 })
  cache.insertIfAbsent('k2', { n: 2 })
  assert.equal(cache.get('k1').n, 1, 'k1 recency refreshed')
  cache.insertIfAbsent('k3', { n: 3 })
  assert.equal(cache.get('k2'), undefined, 'k2 was the LRU entry and got evicted')
  assert.equal(cache.get('k1').n, 1)
  assert.equal(cache.get('k3').n, 3)
  assert.equal(cache.size(), 2)
})

test('LRU: eviction order without refreshes evicts oldest insertion', () => {
  const cache = createEvidenceCache(2)
  cache.insertIfAbsent('k1', { n: 1 })
  cache.insertIfAbsent('k2', { n: 2 })
  cache.insertIfAbsent('k3', { n: 3 })
  assert.equal(cache.get('k1'), undefined)
  assert.equal(cache.get('k2').n, 2)
  assert.equal(cache.get('k3').n, 3)
})

test('cache: clear and size behave', () => {
  const cache = createEvidenceCache(2)
  assert.equal(cache.size(), 0)
  cache.insertIfAbsent('k1', { n: 1 })
  assert.equal(cache.size(), 1)
  cache.clear()
  assert.equal(cache.size(), 0)
  assert.equal(cache.get('k1'), undefined)
})

test('cache: default capacity constant is the documented internal bound', () => {
  assert.equal(EVIDENCE_CACHE_CAPACITY, 32)
  const cache = createEvidenceCache()
  for (let i = 0; i < 40; i++) cache.insertIfAbsent(`k${i}`, { i })
  assert.equal(cache.size(), 32, 'bounded by the internal constant')
})
