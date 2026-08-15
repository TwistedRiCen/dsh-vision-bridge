// Stage 3A multi-image Evidence validator + renderer tests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MULTI_EVIDENCE_BOUNDARY, renderMultiEvidence, validateMultiEvidence } from '../dist/index.js'

const entry = (index, marker) => ({
  index,
  summary: `${marker} summary`,
  ocr: { full_text: `${marker}-OCR`, lines: [{ text: `${marker}-OCR` }] },
  layout: { regions: [{ type: 'paragraph', reading_order: 1, text: marker }] },
  semantics: { scene: 'scene', entities: [{ name: marker, type: 'fixture' }] },
  visual: { dominant_colors: ['#111111'], style: 'solid', notes: ['note'] },
  uncertainty: [`uncertain-${marker}`],
})

const validMulti = (n = 2) => ({
  images: Array.from({ length: n }, (_, i) => entry(i + 1, `M${i + 1}`)),
  relations: [{ imageIndexes: Array.from({ length: n }, (_, i) => i + 1), description: `relation across ${n}` }],
})

test('valid multi evidence passes, normalizes, and preserves indexes/relations', () => {
  const check = validateMultiEvidence(validMulti(3), 3)
  assert.equal(check.ok, true)
  assert.equal(check.value.images.length, 3)
  assert.deepEqual(check.value.images.map((i) => i.index), [1, 2, 3])
  assert.equal(check.value.relations[0].description, 'relation across 3')
})

test('relations may be empty', () => {
  const raw = { images: [entry(1, 'M1')], relations: [] }
  const check = validateMultiEvidence(raw, 1)
  assert.equal(check.ok, true)
  assert.deepEqual(check.value.relations, [])
})

test('unknown extra fields are tolerated by the parser (existing policy)', () => {
  const raw = validMulti(2)
  raw.extra = 'tolerated'
  raw.images[0].someUnknown = { deep: true }
  const check = validateMultiEvidence(raw, 2)
  assert.equal(check.ok, true)
})

test('images not an array fails', () => {
  const check = validateMultiEvidence({ images: 'nope', relations: [] }, 1)
  assert.equal(check.ok, false)
  assert.ok(check.violations.some((v) => v.includes('images')))
})

test('images length too short fails', () => {
  const check = validateMultiEvidence(validMulti(1), 2)
  assert.ok(!check.ok)
  assert.ok(check.violations.some((v) => v.includes('images.length')))
})

test('images length too long fails', () => {
  const check = validateMultiEvidence(validMulti(3), 2)
  assert.ok(!check.ok)
  assert.ok(check.violations.some((v) => v.includes('images.length')))
})

test('index starting at 0 fails', () => {
  const raw = { images: [entry(0, 'M1')], relations: [] }
  const check = validateMultiEvidence(raw, 1)
  assert.ok(!check.ok)
  assert.ok(check.violations.some((v) => v.includes('images[0].index')))
})

test('duplicate index fails', () => {
  const raw = { images: [entry(1, 'M1'), entry(1, 'M2')], relations: [] }
  const check = validateMultiEvidence(raw, 2)
  assert.ok(!check.ok)
  assert.ok(check.violations.some((v) => v.includes('images[1].index')))
})

test('skipped index fails', () => {
  const raw = { images: [entry(1, 'M1'), entry(3, 'M2')], relations: [] }
  const check = validateMultiEvidence(raw, 2)
  assert.ok(!check.ok)
  assert.ok(check.violations.some((v) => v.includes('images[1].index')))
})

test('non-integer index fails', () => {
  const raw = { images: [{ ...entry(1, 'M1'), index: 1.5 }], relations: [] }
  const check = validateMultiEvidence(raw, 1)
  assert.ok(!check.ok)
})

test('entry missing a required single-image field fails with the entry path', () => {
  const raw = { images: [{ index: 1, summary: 'only summary' }], relations: [] }
  const check = validateMultiEvidence(raw, 1)
  assert.ok(!check.ok)
  assert.ok(check.violations.some((v) => v.includes('images[0].ocr')))
})

test('relations not an array fails', () => {
  const check = validateMultiEvidence({ images: [entry(1, 'M1'), entry(2, 'M2')], relations: 'nope' }, 2)
  assert.ok(!check.ok)
  assert.ok(check.violations.some((v) => v.includes('relations')))
})

test('relation with one index fails', () => {
  const raw = { images: [entry(1, 'M1'), entry(2, 'M2')], relations: [{ imageIndexes: [1], description: 'solo' }] }
  const check = validateMultiEvidence(raw, 2)
  assert.ok(!check.ok)
  assert.ok(check.violations.some((v) => v.includes('relations[0].imageIndexes')))
})

test('relation with duplicate indexes fails', () => {
  const raw = { images: [entry(1, 'M1'), entry(2, 'M2')], relations: [{ imageIndexes: [1, 1], description: 'dup' }] }
  const check = validateMultiEvidence(raw, 2)
  assert.ok(!check.ok)
})

test('relation with an out-of-range index fails', () => {
  const raw = { images: [entry(1, 'M1'), entry(2, 'M2')], relations: [{ imageIndexes: [1, 3], description: 'bad' }] }
  const check = validateMultiEvidence(raw, 2)
  assert.ok(!check.ok)
})

test('relation with a non-integer index fails', () => {
  const raw = { images: [entry(1, 'M1'), entry(2, 'M2')], relations: [{ imageIndexes: [1, 'two'], description: 'bad' }] }
  const check = validateMultiEvidence(raw, 2)
  assert.ok(!check.ok)
})

test('relation with an empty description fails', () => {
  const raw = { images: [entry(1, 'M1'), entry(2, 'M2')], relations: [{ imageIndexes: [1, 2], description: '   ' }] }
  const check = validateMultiEvidence(raw, 2)
  assert.ok(!check.ok)
  assert.ok(check.violations.some((v) => v.includes('relations[0].description')))
})

test('renderer: whitelist projection — boundary, per-image fields, relations; no layout/semantics/visual/unknown', () => {
  const check = validateMultiEvidence(validMulti(2), 2)
  const text = renderMultiEvidence(check.value)
  assert.ok(text.includes(MULTI_EVIDENCE_BOUNDARY), 'pluralized trust boundary retained')
  assert.ok(text.includes('untrusted observed data'), 'sealed security meaning retained')
  assert.ok(text.includes('Image 1:'))
  assert.ok(text.includes('Image 2:'))
  assert.ok(text.includes('Summary: M1 summary'))
  assert.ok(text.includes('Transcription:'))
  assert.ok(text.includes('M2-OCR'))
  assert.ok(text.includes('Uncertain: uncertain-M1'))
  assert.ok(text.includes('Cross-image relations:'))
  assert.ok(text.includes('- Images 1,2: relation across 2'))
  assert.ok(!text.includes('layout'), 'layout never rendered')
  assert.ok(!text.includes('semantics'), 'semantics never rendered')
  assert.ok(!text.includes('#111111'), 'visual never rendered')
  assert.ok(!text.includes('tolerated'), 'unknown fields never rendered')
})

test('renderer: empty relations omit the relations section', () => {
  const check = validateMultiEvidence({ images: [entry(1, 'M1')], relations: [] }, 1)
  const text = renderMultiEvidence(check.value)
  assert.ok(!text.includes('Cross-image relations'))
})

test('renderer: OCR transcription respects the 4000-char cap', () => {
  const check = validateMultiEvidence({
    images: [{ ...entry(1, 'M1'), ocr: { full_text: 'x'.repeat(5000), lines: [] } }],
    relations: [],
  }, 1)
  const text = renderMultiEvidence(check.value)
  assert.ok(text.includes(`${'x'.repeat(4000)}…`))
  assert.ok(!text.includes('x'.repeat(4001)))
})
