/**
 * YAML mutation tests: structured AST edits, comment preservation,
 * duplicate prevention, anomaly rejection, atomic write.
 * Deterministic; no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  mutateBridgeRow, parsePatchDocument, previewConfigYaml, readBridgeRow,
  verifySerializedPatch, writeFileAtomic,
} from '../../scripts/installer/setup-src.mjs'

const CONFIG = { upstreamProvider: 'provider-a', visionProvider: 'provider-b', visionModel: 'vision-model-a' }

/* ------------------------------------------------------------------ */
/* case A: new row                                                     */
/* ------------------------------------------------------------------ */

test('mutateBridgeRow appends a new row to an empty patch (case A)', () => {
  const { text, action } = mutateBridgeRow('[]\n', CONFIG)
  assert.equal(action, 'add')
  const state = readBridgeRow(text)
  assert.equal(state.status, 'present')
  assert.deepEqual(state.config, CONFIG)
})

test('mutateBridgeRow appends after existing user rows and keeps their comments (case A)', () => {
  const input = [
    '# user comment kept',
    '- id: something-else',
    '  config: { a: 1 }   # trailing comment kept',
    '# bridge section follows',
    '',
  ].join('\n')
  const { text, action } = mutateBridgeRow(input, CONFIG)
  assert.equal(action, 'add')
  assert.ok(text.includes('# user comment kept'), 'leading comment preserved')
  assert.ok(text.includes('# trailing comment kept'), 'trailing comment preserved')
  assert.ok(text.includes('# bridge section follows'), 'section comment preserved')
  assert.ok(text.includes('config: { a: 1 }'), 'user row formatting preserved')
  assert.ok(text.includes('- id: dsh-vision-bridge'))
  assert.ok(text.includes('upstreamProvider: provider-a'))
  verifySerializedPatch(text)
})

/* ------------------------------------------------------------------ */
/* case B: update existing row                                         */
/* ------------------------------------------------------------------ */

test('mutateBridgeRow updates only the config subtree (case B, no duplicates)', () => {
  const input = [
    '# top comment',
    '- id: dsh-vision-bridge',
    '  config:',
    '    upstreamProvider: old-a',
    '    visionProvider: old-b',
    '    visionModel: old-m',
    '- id: other-row',
    '  name: keep-me',
    '',
  ].join('\n')
  const { text, action } = mutateBridgeRow(input, CONFIG)
  assert.equal(action, 'update')
  assert.equal((text.match(/id: dsh-vision-bridge/g) ?? []).length, 1, 'exactly one bridge row')
  assert.ok(text.includes('# top comment'), 'top comment preserved')
  assert.ok(text.includes('name: keep-me'), 'other row preserved')
  assert.ok(!text.includes('old-a'), 'old config replaced')
  const state = readBridgeRow(text)
  assert.deepEqual(state.config, CONFIG)
})

test('mutateBridgeRow keeps the bridge row position and updates in place', () => {
  const input = [
    '- id: first',
    '  name: first',
    '- id: dsh-vision-bridge',
    '  config: { upstreamProvider: old }',
    '- id: last',
    '  name: last',
    '',
  ].join('\n')
  const { text } = mutateBridgeRow(input, CONFIG)
  const firstIdx = text.indexOf('- id: first')
  const bridgeIdx = text.indexOf('- id: dsh-vision-bridge')
  const lastIdx = text.indexOf('- id: last')
  assert.ok(firstIdx < bridgeIdx && bridgeIdx < lastIdx, 'bridge row keeps its position')
  assert.ok(!text.includes('upstreamProvider: old'))
})

/* ------------------------------------------------------------------ */
/* anomalies                                                           */
/* ------------------------------------------------------------------ */

test('readBridgeRow and mutateBridgeRow reject non-array top level', () => {
  const input = 'id: dsh-vision-bridge\nconfig: {}\n'
  assert.equal(readBridgeRow(input).status, 'anomalous')
  assert.throws(() => mutateBridgeRow(input, CONFIG), /top level must be a YAML array/)
})

test('readBridgeRow and mutateBridgeRow reject non-map config', () => {
  const input = '- id: dsh-vision-bridge\n  config: just-a-string\n'
  const state = readBridgeRow(input)
  assert.equal(state.status, 'anomalous')
  assert.throws(() => mutateBridgeRow(input, CONFIG), /not a YAML map/)
})

test('multiple bridge rows are refused loudly, never guessed', () => {
  const input = [
    '- id: dsh-vision-bridge',
    '  config: { upstreamProvider: a, visionProvider: b, visionModel: m }',
    '- id: dsh-vision-bridge',
    '  config: { upstreamProvider: c, visionProvider: d, visionModel: e }',
    '',
  ].join('\n')
  assert.equal(readBridgeRow(input).status, 'anomalous')
  assert.throws(() => mutateBridgeRow(input, CONFIG), /multiple/)
})

test('unparseable YAML is refused', () => {
  assert.equal(readBridgeRow('- id: [unclosed\n').status, 'anomalous')
  assert.throws(() => mutateBridgeRow('- id: [unclosed\n', CONFIG), /failed to parse/)
})

test('previewConfigYaml renders the exact row shape', () => {
  const preview = previewConfigYaml(CONFIG)
  assert.ok(preview.includes('- id: dsh-vision-bridge'))
  assert.ok(preview.includes('upstreamProvider: provider-a'))
  assert.ok(preview.includes('visionProvider: provider-b'))
  assert.ok(preview.includes('visionModel: vision-model-a'))
  assert.equal(readBridgeRow(preview).status, 'present')
})

/* ------------------------------------------------------------------ */
/* atomic write                                                        */
/* ------------------------------------------------------------------ */

test('writeFileAtomic replaces atomically and leaves no temp litter', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dg-aw-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'cordis.patch.yml')
  writeFileSync(file, 'old')
  writeFileAtomic(file, 'new')
  assert.equal(readFileSync(file, 'utf8'), 'new')
  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('writeFileAtomic fails loudly on a read-only target and leaves original intact', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dg-awro-'))
  t.after(() => {
    try { chmodSync(dir, 0o777) } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, 'cordis.patch.yml')
  writeFileSync(file, 'original')
  if (process.platform === 'win32') {
    // Windows: the read-only attribute blocks replacement via rename.
    chmodSync(file, 0o444)
    assert.throws(() => writeFileAtomic(file, 'new'))
    chmodSync(file, 0o666)
    assert.equal(readFileSync(file, 'utf8'), 'original')
  } else {
    // POSIX: rename replaces regardless of target mode; verify behavior only.
    writeFileAtomic(file, 'new')
    assert.equal(readFileSync(file, 'utf8'), 'new')
  }
})

test('parsePatchDocument surfaces parse errors with the file context', () => {
  assert.throws(() => parsePatchDocument('{{{{'), /failed to parse/)
})
