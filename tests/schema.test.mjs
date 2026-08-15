// Stage 1 evidence schema validator tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateEvidence } from '../dist/index.js'

export const VALID = {
  summary: 'A deterministic test image: a blue rectangle labelled HELLO-42.',
  ocr: {
    full_text: 'HELLO-42\nFIXTURE-EVIDENCE-LINE-2',
    lines: [
      { text: 'HELLO-42', language: 'en' },
      { text: 'FIXTURE-EVIDENCE-LINE-2' },
    ],
  },
  layout: {
    regions: [
      { type: 'title', reading_order: 1, text: 'HELLO-42' },
      { type: 'paragraph', reading_order: 2, text: 'FIXTURE-EVIDENCE-LINE-2' },
    ],
  },
  semantics: { scene: 'test fixture', intent: 'stage1', entities: [{ name: 'HELLO-42', type: 'token', evidence: 'top region' }] },
  visual: { dominant_colors: ['blue'], style: 'flat', notes: ['deterministic'] },
  uncertainty: ['fixture-only image'],
}

test('full valid evidence passes and round-trips', () => {
  const check = validateEvidence(VALID)
  assert.equal(check.ok, true)
  assert.equal(check.value.summary, VALID.summary)
})

for (const field of ['summary', 'ocr', 'layout', 'semantics', 'visual', 'uncertainty']) {
  test(`missing required field "${field}" fails with the field path`, () => {
    const broken = { ...VALID }
    delete broken[field]
    const check = validateEvidence(broken)
    assert.equal(check.ok, false)
    assert.ok(check.violations.includes(field), `violations=${check.violations}`)
  })
}

test('nested required fields fail with dotted paths', () => {
  const broken = structuredClone(VALID)
  delete broken.ocr.full_text
  const check = validateEvidence(broken)
  assert.equal(check.ok, false)
  assert.ok(check.violations.includes('ocr.full_text'))
})

test('wrong type fails (summary as number)', () => {
  const broken = { ...VALID, summary: 42 }
  const check = validateEvidence(broken)
  assert.equal(check.ok, false)
  assert.ok(check.violations.includes('summary'))
})

test('wrong element type inside array fails (reading_order as string)', () => {
  const broken = structuredClone(VALID)
  broken.layout.regions[0].reading_order = 'first'
  const check = validateEvidence(broken)
  assert.equal(check.ok, false)
  assert.ok(check.violations.some((v) => v.startsWith('layout.regions[0].reading_order')))
})

test('null on optional fields is dropped, not rejected', () => {
  const withNulls = structuredClone(VALID)
  withNulls.semantics.intent = null
  withNulls.visual.style = null
  withNulls.ocr.lines[0].language = null
  const check = validateEvidence(withNulls)
  assert.equal(check.ok, true)
  assert.equal(check.value.semantics.intent, undefined)
  assert.equal(check.value.visual.style, undefined)
  assert.equal(check.value.ocr.lines[0].language, undefined)
})

test('null on a required field still fails', () => {
  const broken = { ...VALID, summary: null }
  const check = validateEvidence(broken)
  assert.equal(check.ok, false)
  assert.ok(check.violations.includes('summary'))
})

test('unknown extra fields are tolerated (forward compatible; bbox/confidence are NOT declared)', () => {
  const extra = { ...VALID, layout: { ...VALID.layout, bbox: [0, 0, 1, 1] }, confidence: 0.99 }
  const check = validateEvidence(extra)
  assert.equal(check.ok, true)
})

test('non-object input fails', () => {
  for (const bad of [null, 'x', 42, []]) {
    const check = validateEvidence(bad)
    assert.equal(check.ok, false)
    assert.ok(check.violations.includes('(root)'))
  }
})
