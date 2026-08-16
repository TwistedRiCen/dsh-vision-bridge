/**
 * Installer build tests: deterministic double build (byte-identical),
 * sidecar regeneration, release-map well-formedness (I38/I40/I43).
 * Deterministic; no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_MAP, SETUP_VERSION, DSH_PIN } from '../../scripts/installer/setup-src.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const BUILD = path.join(repoRoot, 'scripts', 'installer', 'build.mjs')

function runBuild(outDir) {
  const result = spawnSync(process.execPath, [BUILD], {
    cwd: repoRoot,
    env: { ...process.env, DSH_SETUP_OUTDIR: outDir },
    shell: false,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return outDir
}

test('I43: two builds are byte-identical and regenerate the same sidecar', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dg-build-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const a = runBuild(path.join(root, 'a'))
  const b = runBuild(path.join(root, 'b'))
  const bytesA = readFileSync(path.join(a, 'setup.mjs'))
  const bytesB = readFileSync(path.join(b, 'setup.mjs'))
  assert.equal(bytesA.length, bytesB.length)
  assert.deepEqual(bytesA, bytesB, 'build output must be byte-identical')
  assert.equal(readFileSync(path.join(a, 'setup.mjs.sha256'), 'utf8'), readFileSync(path.join(b, 'setup.mjs.sha256'), 'utf8'))
  const sidecar = readFileSync(path.join(a, 'setup.mjs.sha256'), 'utf8').trim()
  const actual = createHash('sha256').update(bytesA).digest('hex').toUpperCase()
  assert.equal(sidecar, `${actual}  setup.mjs`)
})

test('the built artifact is a self-contained ESM bundle with the frozen properties', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dg-build2-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = runBuild(root)
  const text = readFileSync(path.join(outDir, 'setup.mjs'), 'utf8')
  assert.ok(text.startsWith('/* dsh-vision-bridge installer'), 'attribution banner first')
  assert.ok(text.includes('createRequire'), 'require bridge present')
  assert.ok(!text.includes('import { parseDocument } from'), 'yaml must be inlined, not imported')
  assert.ok(!text.includes('from "undici"'), 'undici must be inlined')
})

test('I40: release map is well-formed and names deterministic assets', () => {
  for (const [version, entry] of Object.entries(RELEASE_MAP)) {
    assert.match(version, /^\d+\.\d+\.\d+$/)
    assert.match(entry.asset, new RegExp(`^dsh-vision-bridge-${version.replace(/\./g, '\\.')}\\.tgz$`))
    assert.ok(entry.url.startsWith('https://github.com/TwistedRiCen/dsh-vision-bridge/releases/download/'))
    assert.ok(entry.url.endsWith(entry.asset))
    assert.match(entry.sha256, /^[0-9A-F]{64}$/)
  }
})

test('frozen constants are internally consistent', () => {
  assert.match(SETUP_VERSION, /^0\.2\.3$/)
  assert.equal(DSH_PIN, '0.1.0-rc.6')
})
