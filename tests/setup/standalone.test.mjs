/**
 * Standalone distribution tests (I31/I32/I33): the built setup.mjs must run
 * from a fresh directory with no sibling files — including directories whose
 * path contains spaces. Spawns the real artifact; zero network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_PIN } from '../../scripts/installer/setup-src.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const ARTIFACT = path.join(repoRoot, 'dist-installer', 'setup.mjs')
const FIXTURE_BIN = path.join(here, 'fixtures', 'bin')
const FAKE_DSH = path.join(here, 'fixtures', 'fake-dsh.mjs')

function guardedArtifact() {
  assert.ok(existsSync(ARTIFACT), 'dist-installer/setup.mjs is missing; run node scripts/installer/build.mjs first')
  return ARTIFACT
}

function fakeEnv(root) {
  const home = path.join(root, 'home')
  const localApp = path.join(root, 'localapp')
  const temp = path.join(root, 'plain-temp')
  mkdirSync(home, { recursive: true })
  mkdirSync(localApp, { recursive: true })
  mkdirSync(temp, { recursive: true })
  const cacheEntry = path.join(localApp, 'npm-cache', '_npx', 'standalone01', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(path.join(cacheEntry, 'lib'), { recursive: true })
  writeFileSync(path.join(cacheEntry, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_PIN, type: 'module' })}\n`)
  copyFileSync(FAKE_DSH, path.join(cacheEntry, 'lib', 'bin.js'))
  // SystemRoot is intentionally untouched (a fake value breaks child node startup).
  const env = {
    ...process.env,
    PATH: [FIXTURE_BIN, process.env.PATH].join(path.delimiter),
    DSH_HOME: home,
    LOCALAPPDATA: localApp,
    TEMP: temp,
    TMP: temp,
    PUBLIC: path.join(root, 'Public'),
  }
  delete env.HTTP_PROXY
  delete env.HTTPS_PROXY
  delete env.ALL_PROXY
  delete env.http_proxy
  delete env.https_proxy
  delete env.all_proxy
  return env
}

function runArtifact(artifactDir, args, env) {
  return spawnSync(process.execPath, [path.join(artifactDir, 'setup.mjs'), ...args], {
    cwd: artifactDir,
    env,
    shell: false,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
}

test('I31/I32: the artifact runs from a fresh directory with no sibling files', (t) => {
  const artifact = guardedArtifact()
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dg-standalone-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  copyFileSync(artifact, path.join(dir, 'setup.mjs'))
  assert.deepEqual(readdirSync(dir), ['setup.mjs'], 'only setup.mjs present')

  const help = runArtifact(dir, ['--help'], { ...process.env })
  assert.equal(help.status, 0, help.stderr)
  assert.ok(help.stdout.includes('Usage:'), help.stdout)

  const env = fakeEnv(mkdtempSync(path.join(os.tmpdir(), 'dg-sa-env-')))
  t.after(() => rmSync(path.dirname(env.LOCALAPPDATA), { recursive: true, force: true }))
  const whatIf = runArtifact(dir, [
    '--what-if', '--profile', 'work',
    '--upstream-provider', 'provider-a',
    '--vision-provider', 'provider-b',
    '--vision-model', 'vision-model-a',
  ], env)
  assert.equal(whatIf.status, 0, `${whatIf.stdout}\n${whatIf.stderr}`)
  assert.ok(whatIf.stdout.includes('--what-if: nothing was downloaded'), whatIf.stdout)
  assert.ok(whatIf.stdout.includes('upstreamProvider: provider-a'), 'YAML preview present')
  // No files were created anywhere in the fake env roots.
  assert.equal(existsSync(path.join(env.DSH_HOME, 'profiles')), false)
  const tempLeftovers = readdirSync(env.TEMP).filter((name) => name.startsWith('dsh-vision-bridge-setup-'))
  assert.deepEqual(tempLeftovers, [])
})

test('I33: the artifact runs from a directory whose path contains spaces', (t) => {
  const artifact = guardedArtifact()
  const base = mkdtempSync(path.join(os.tmpdir(), 'dg-spaced-'))
  const dir = path.join(base, 'installer dir with spaces')
  mkdirSync(dir, { recursive: true })
  t.after(() => rmSync(base, { recursive: true, force: true }))
  copyFileSync(artifact, path.join(dir, 'setup.mjs'))

  const env = fakeEnv(mkdtempSync(path.join(os.tmpdir(), 'dg-sa2-env-')))
  t.after(() => rmSync(path.dirname(env.LOCALAPPDATA), { recursive: true, force: true }))
  const result = runArtifact(dir, [
    '--what-if', '--profile', 'work',
    '--upstream-provider', 'provider-a',
    '--vision-provider', 'provider-b',
    '--vision-model', 'vision-model-a',
  ], env)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.ok(result.stdout.includes('upstreamProvider: provider-a'))
})

test('I38: the sha256 sidecar matches the artifact bytes', () => {
  const artifact = guardedArtifact()
  const sidecar = path.join(repoRoot, 'dist-installer', 'setup.mjs.sha256')
  assert.ok(existsSync(sidecar), 'setup.mjs.sha256 missing')
  const expected = createHash('sha256').update(readFileSync(artifact)).digest('hex').toUpperCase()
  const content = readFileSync(sidecar, 'utf8').trim()
  assert.equal(content, `${expected}  setup.mjs`)
})
