/**
 * Security and boundary scans: forbidden literals must never appear in the
 * installer sources or the built artifact (machine paths, internal test
 * profile names, ports, provider secrets, credentials files). Deterministic.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

/**
 * Forbidden strings per the frozen public/private boundary. The DSH package
 * scope (@deepseek-ai/dsh) is intentionally NOT on this list: it is the
 * documented pinned dependency, not a leak. Patterns use lookahead so
 * legitimate identifiers like `localeCompare` do not false-positive.
 */
const FORBIDDEN_PATTERNS = [
  /D:\\Codex/,
  /C:\\Users/,
  /(?<![\w.])3080(?!\d)/,
  /(?<![\w.])3090(?!\d)/,
  /webtest/,
  /\.local(?![A-Za-z0-9_$])/,
  /egz-vision-gateway/,
  /\.credentials\.yaml/,
  /SECRET_HONEYPOT/,
]

/** Additional patterns that apply to installer-authored sources only (bundled undici legitimately ships HTTP auth machinery). */
const SOURCE_ONLY_PATTERNS = [
  /API_KEY/,
  /apiKey/,
  /Bearer\s/,
]

const SOURCE_FILES = [
  'scripts/installer/setup-src.mjs',
  'scripts/installer/build.mjs',
  'scripts/installer/banner.txt',
  'scripts/setup.ps1',
]

function scan(file, patterns) {
  const text = readFileSync(file, 'utf8')
  const hits = []
  for (const pattern of patterns) {
    if (pattern.test(text)) hits.push(pattern.source)
  }
  return hits
}

test('installer sources are free of machine paths, ports, credentials, and secrets', () => {
  for (const rel of SOURCE_FILES) {
    const file = path.join(repoRoot, rel)
    assert.ok(existsSync(file), `missing ${rel}`)
    const hits = scan(file, [...FORBIDDEN_PATTERNS, ...SOURCE_ONLY_PATTERNS])
    assert.deepEqual(hits, [], `${rel} contains forbidden literals: ${hits.join(', ')}`)
  }
})

test('built installer artifact is free of machine paths, ports, and internal test identities', (t) => {
  const artifact = path.join(repoRoot, 'dist-installer', 'setup.mjs')
  if (!existsSync(artifact)) {
    t.skip('dist-installer/setup.mjs not built yet (run: node scripts/installer/build.mjs)')
    return
  }
  // The artifact bundles yaml + undici code; machine-path/port/test-identity
  // tokens must still never appear, while HTTP auth machinery may.
  const hits = scan(artifact, FORBIDDEN_PATTERNS)
  assert.deepEqual(hits, [], `dist-installer/setup.mjs contains forbidden literals: ${hits.join(', ')}`)
})

test('bundle carries the third-party attribution banner', (t) => {
  const artifact = path.join(repoRoot, 'dist-installer', 'setup.mjs')
  if (!existsSync(artifact)) {
    t.skip('dist-installer/setup.mjs not built yet')
    return
  }
  const head = readFileSync(artifact, 'utf8').slice(0, 4096)
  assert.ok(head.includes('yaml v2.9.0'), 'yaml attribution present')
  assert.ok(head.includes('undici'), 'undici attribution present')
  assert.ok(head.includes('createRequire'), 'createRequire bridge present')
})

test('package.json keeps the bridge zero-runtime-dependency contract', () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies, undefined, 'no runtime dependencies allowed')
  assert.ok(manifest.devDependencies.esbuild, 'esbuild devDependency pinned')
  assert.ok(manifest.devDependencies.yaml === '2.9.0', 'yaml pinned at 2.9.0')
  assert.ok(manifest.devDependencies.undici === '7.29.0', 'undici pinned at 7.29.0')
  // The runtime files whitelist must not grow the installer into the tgz.
  assert.deepEqual(manifest.files, ['dist', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
})
