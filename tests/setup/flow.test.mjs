/**
 * Installer flow tests: end-to-end runs against the fake DSH CLI with a
 * disposable DSH_HOME. Deterministic; zero network (downloads are stubbed;
 * local --tarball paths exercise real filesystem handling, including spaces
 * and Unicode).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DSH_PIN, runSetup,
} from '../../scripts/installer/setup-src.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const FAKE_DSH = path.join(here, 'fixtures', 'fake-dsh.mjs')
const FIXTURE_BIN = path.join(here, 'fixtures', 'bin')

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function makeRelease(version, { scoped = false } = {}) {
  const packageName = scoped ? '@liangdacheng/dsh-vision-bridge' : undefined
  const content = packageName === undefined
    ? `fake tarball v${version}\n`
    : `fake tarball v${version}\nidentity: ${packageName}\n`
  const sha256 = createHash('sha256').update(content).digest('hex').toUpperCase()
  const asset = `dsh-vision-bridge-${version}.tgz`
  return {
    version,
    content,
    sha256,
    asset,
    url: `https://example.invalid/releases/download/v${version}/${asset}`,
    packageName,
  }
}

function releaseMapFor(releases) {
  return Object.freeze(Object.fromEntries(releases.map((release) => [
    release.version,
    Object.freeze({
      asset: release.asset,
      url: release.url,
      sha256: release.sha256,
      ...(release.packageName === undefined ? {} : { packageName: release.packageName }),
    }),
  ])))
}

/**
 * Build a test environment: disposable home, fake pnpm/npm shims on PATH,
 * and a fake npx cache holding the pinned DSH (fake-dsh). The real PATH is
 * preserved so where.exe / node keep resolving.
 */
function makeEnv(root, { spacedTemp = false, noNpxCache = false } = {}) {
  const home = path.join(root, spacedTemp ? 'dsh home with spaces' : 'home')
  mkdirSync(home, { recursive: true })
  const localApp = path.join(home, 'localapp')
  mkdirSync(localApp, { recursive: true })
  const tempRoot = spacedTemp ? path.join(root, 'Temp with spaces') : path.join(root, 'plain-temp')
  mkdirSync(tempRoot, { recursive: true })
  const publicDir = path.join(root, 'Public Space')
  mkdirSync(publicDir, { recursive: true })

  // Note: SystemRoot is intentionally NOT overridden here. The installer
  // never alters it in production, and a fake SystemRoot breaks the child
  // node process itself (ncrypto CSPRNG startup assertion).
  const env = {
    ...process.env,
    PATH: [FIXTURE_BIN, process.env.PATH].join(path.delimiter),
    DSH_HOME: home,
    LOCALAPPDATA: localApp,
    TEMP: tempRoot,
    TMP: tempRoot,
    PUBLIC: publicDir,
  }
  delete env.DSH_TELEMETRY_DISABLED
  delete env.HTTP_PROXY
  delete env.HTTPS_PROXY
  delete env.ALL_PROXY
  delete env.http_proxy
  delete env.https_proxy
  delete env.all_proxy

  if (!noNpxCache) {
    const cacheEntry = path.join(localApp, 'npm-cache', '_npx', 'deadbeef0011', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(path.join(cacheEntry, 'lib'), { recursive: true })
    writeFileSync(path.join(cacheEntry, 'package.json'), `${JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_PIN, type: 'module' })}\n`)
    copyFileSync(FAKE_DSH, path.join(cacheEntry, 'lib', 'bin.js'))
  }
  return env
}

function writeTarball(dir, release) {
  const file = path.join(dir, release.asset)
  writeFileSync(file, release.content)
  return file
}

function makeLogs() {
  const lines = []
  return { lines, log: (line) => lines.push(String(line)) }
}

function baseArgs(profile = 'test-profile') {
  return [
    '--profile', profile,
    '--upstream-provider', 'provider-a',
    '--vision-provider', 'provider-b',
    '--vision-model', 'vision-model-a',
  ]
}

function snapshotTree(root) {
  const out = {}
  const walk = (dir, rel) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const abs = path.join(dir, name)
      const key = rel === '' ? name : `${rel}/${name}`
      const stat = lstatSync(abs)
      if (stat.isDirectory()) {
        out[key] = { dir: true }
        walk(abs, key)
      } else if (stat.isSymbolicLink()) {
        out[key] = { link: true }
      } else {
        out[key] = { size: stat.size, sha: createHash('sha256').update(readFileSync(abs)).digest('hex') }
      }
    }
  }
  walk(root, '')
  return out
}

function readFakeLog(env) {
  const file = env.FAKE_DSH_LOG
  if (file === undefined || !existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split(/\r?\n/).filter((line) => line.length > 0).map((line) => JSON.parse(line))
}

function withEnv(t, extra = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dg-flow-'))
  t.after(() => {
    try {
      for (const name of ['cordis.patch.yml', 'package.json']) { /* noop */ }
      rmSync(root, { recursive: true, force: true })
    } catch { /* best effort */ }
  })
  const env = makeEnv(root)
  Object.assign(env, extra)
  return { root, env }
}

/* ------------------------------------------------------------------ */
/* I5/I9/I2 — fresh install into a new profile                         */
/* ------------------------------------------------------------------ */

test('fresh install: plugin add, bundle reconcile, config write, dump verify (I5/I9/I2)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.1')
  const map = releaseMapFor([release])
  const tarball = writeTarball(root, release)
  env.FAKE_DSH_LOG = path.join(root, 'fake.log')

  const { lines, log } = makeLogs()
  const result = await runSetup({
    argv: [...baseArgs('work'), '--tarball', tarball, '--yes'],
    env, log, releaseMap: map,
  })
  assert.equal(result.exitCode, 0, lines.join('\n'))

  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  // package installed (I5)
  const installed = JSON.parse(readFileSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge', 'package.json'), 'utf8'))
  assert.equal(installed.version, '0.2.1')
  // bundle reconciled (I9)
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-vision-bridge'))
  // config written with all three keys
  const patch = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('upstreamProvider: provider-a'))
  assert.ok(patch.includes('visionProvider: provider-b'))
  assert.ok(patch.includes('visionModel: vision-model-a'))
  // dump verification ran (I2: the flow validated via dump-config)
  assert.ok(lines.some((line) => line.includes('composed configuration verified')), lines.join('\n'))
  // I36: cwd-relative ./ spec with the installer temp dir as cwd
  const events = readFakeLog(env)
  const addEvent = events.find((event) => event.cmd === 'add')
  assert.ok(addEvent, 'plugin add was invoked')
  assert.ok(addEvent.argv[4].startsWith('./'), `spec must be relative, got ${addEvent.argv[4]}`)
  assert.ok(path.isAbsolute(addEvent.argv[4]) === false)
  assert.ok(addEvent.cwd.includes('dsh-vision-bridge-setup-'), `cwd must be the private temp dir, got ${addEvent.cwd}`)
  // temp dirs cleaned
  const leftovers = readdirSync(path.join(root, 'plain-temp')).filter((name) => name.startsWith('dsh-vision-bridge-setup-'))
  assert.deepEqual(leftovers, [])
  // no secrets in output
  assert.ok(!lines.join('\n').toLowerCase().includes('password'))
})

/* ------------------------------------------------------------------ */
/* I3 — multiple profiles: only the target is touched                  */
/* ------------------------------------------------------------------ */

test('multiple profiles: non-interactive selection touches only the target (I3)', async (t) => {
  const { root, env } = withEnv(t)
  mkdirSync(path.join(env.DSH_HOME, 'profiles', 'one'), { recursive: true })
  writeFileSync(path.join(env.DSH_HOME, 'profiles', 'one', 'package.json'), JSON.stringify({ name: 'dsh-profile-one', dsh: { profile: { bundles: [] } } }))
  mkdirSync(path.join(env.DSH_HOME, 'profiles', 'two'), { recursive: true })
  writeFileSync(path.join(env.DSH_HOME, 'profiles', 'two', 'package.json'), JSON.stringify({ name: 'dsh-profile-two', dsh: { profile: { bundles: [] } } }))

  const release = makeRelease('0.2.1')
  const map = releaseMapFor([release])
  const tarball = writeTarball(root, release)
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('two'), '--tarball', tarball, '--yes'], env, log, releaseMap: map })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  assert.ok(existsSync(path.join(env.DSH_HOME, 'profiles', 'two', 'node_modules', 'dsh-vision-bridge', 'package.json')))
  assert.equal(existsSync(path.join(env.DSH_HOME, 'profiles', 'one', 'node_modules', 'dsh-vision-bridge', 'package.json')), false)
  assert.equal(existsSync(path.join(env.DSH_HOME, 'profiles', 'one', 'cordis.patch.yml')), false)
})

/* ------------------------------------------------------------------ */
/* I4 — nonexistent profile is created                                 */
/* ------------------------------------------------------------------ */

test('nonexistent profile is created by the plugin add flow (I4)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.1')
  const tarball = writeTarball(root, release)
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('brand-new'), '--tarball', tarball, '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const manifest = JSON.parse(readFileSync(path.join(env.DSH_HOME, 'profiles', 'brand-new', 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-profile-brand-new')
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-vision-bridge'))
})

/* ------------------------------------------------------------------ */
/* I6 — same version, no changes                                       */
/* ------------------------------------------------------------------ */

test('same version + valid bundle + complete config: No changes required, zero writes (I6/I56)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.1')
  const tarball = writeTarball(root, release)
  const { log } = makeLogs()
  const first = await runSetup({ argv: [...baseArgs('work'), '--tarball', tarball, '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(first.exitCode, 0)

  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  const before = snapshotTree(path.join(env.DSH_HOME, 'profiles'))
  const second = await runSetup({ argv: [...baseArgs('work'), '--tarball', tarball, '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(second.exitCode, 0)
  const after = snapshotTree(path.join(env.DSH_HOME, 'profiles'))
  assert.deepEqual(after, before, 'second run must not write anything')
  assert.equal(existsSync(path.join(profileDir, 'cordis.patch.yml.backup-')), false)
})

/* ------------------------------------------------------------------ */
/* I7/I29 — upgrade replaces the package and preserves config          */
/* ------------------------------------------------------------------ */

test('upgrade: older version replaced, config preserved with scripted keep (I7/I29)', async (t) => {
  const { root, env } = withEnv(t)
  const oldRelease = makeRelease('0.2.0')
  const newRelease = makeRelease('0.2.1')
  const oldTarball = writeTarball(root, oldRelease)
  const newTarball = writeTarball(root, newRelease)
  const map = releaseMapFor([oldRelease, newRelease])
  const { lines, log } = makeLogs()

  const first = await runSetup({ argv: [...baseArgs('work'), '--tarball', oldTarball, '--yes'], env, log, releaseMap: map })
  assert.equal(first.exitCode, 0, lines.join('\n'))

  // Interactive keep: user passes no provider args, answers 'keep'.
  const answers = ['keep']
  const asked = []
  const prompt = async (question) => {
    asked.push(question)
    return answers.shift() ?? ''
  }
  const second = await runSetup({ argv: ['--profile', 'work', '--tarball', newTarball, '--yes'], env, log, releaseMap: map, prompt })
  assert.equal(second.exitCode, 0, lines.join('\n'))
  assert.ok(asked.some((question) => question.includes('Keep it')))

  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  const installed = JSON.parse(readFileSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge', 'package.json'), 'utf8'))
  assert.equal(installed.version, '0.2.1')
  // Config preserved (values from the first run).
  const patch = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('upstreamProvider: provider-a'))
  assert.ok(patch.includes('visionProvider: provider-b'))
})

/* ------------------------------------------------------------------ */
/* I8 — downgrade refused                                              */
/* ------------------------------------------------------------------ */

test('downgrade is refused with zero writes (I8)', async (t) => {
  const { root, env } = withEnv(t)
  const oldRelease = makeRelease('0.2.0')
  const newRelease = makeRelease('0.2.1')
  const map = releaseMapFor([oldRelease, newRelease])
  const { lines, log } = makeLogs()
  const first = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, newRelease), '--yes'], env, log, releaseMap: map })
  assert.equal(first.exitCode, 0)

  const before = snapshotTree(path.join(env.DSH_HOME, 'profiles'))
  const downgrade = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, oldRelease), '--yes'], env, log, releaseMap: map })
  assert.equal(downgrade.exitCode, 1)
  assert.ok(lines.join('\n').includes('downgrade is not enabled in installer v1'))
  const after = snapshotTree(path.join(env.DSH_HOME, 'profiles'))
  assert.deepEqual(after, before)
})

/* ------------------------------------------------------------------ */
/* I10 — bundle fallback when DSH does not reconcile                   */
/* ------------------------------------------------------------------ */

test('bundle fallback: JSON-only idempotent fix with backup (I10)', async (t) => {
  const { root, env } = withEnv(t)
  env.FAKE_DSH_NO_RECONCILE = '1'
  const release = makeRelease('0.2.1')
  const tarball = writeTarball(root, release)
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', tarball, '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-vision-bridge'))
  const backups = readdirSync(profileDir).filter((name) => name.startsWith('package.json.backup-'))
  assert.equal(backups.length, 1, 'manifest backup created before the fallback write')
})

/* ------------------------------------------------------------------ */
/* I11/I12/I13 — config add, update, comments                          */
/* ------------------------------------------------------------------ */

test('config update: pre-seeded row updated in place, other rows and comments intact (I12/I13)', async (t) => {
  const { root, env } = withEnv(t)
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-work',
    dependencies: { 'dsh-vision-bridge': 'file:x' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-vision-bridge'] } },
  }))
  mkdirSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge'), { recursive: true })
  writeFileSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge', 'package.json'), JSON.stringify({ name: 'dsh-vision-bridge', version: '0.2.1' }))
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '# user comment A',
    '- id: user-row',
    '  config: { keep: true }',
    '- id: dsh-vision-bridge',
    '  config:',
    '    upstreamProvider: old-a',
    '    visionProvider: old-b',
    '    visionModel: old-m',
    '# user comment B',
    '',
  ].join('\n'))

  const release = makeRelease('0.2.1')
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const patch = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal((patch.match(/id: dsh-vision-bridge/g) ?? []).length, 1)
  assert.ok(patch.includes('# user comment A'))
  assert.ok(patch.includes('# user comment B'))
  assert.ok(patch.includes('config: { keep: true }'))
  assert.ok(patch.includes('upstreamProvider: provider-a'))
  assert.ok(!patch.includes('old-a'))
})

/* ------------------------------------------------------------------ */
/* I14/I25 — provider/model validation                                 */
/* ------------------------------------------------------------------ */

test('invalid provider ids are rejected before any write (I14/I25)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.1')
  const tarball = writeTarball(root, release)
  const { lines, log } = makeLogs()
  const result = await runSetup({
    argv: ['--profile', 'work', '--upstream-provider', 'bad id', '--vision-provider', 'b', '--vision-model', 'm', '--tarball', tarball, '--yes'],
    env, log, releaseMap: releaseMapFor([release]),
  })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('upstreamProvider "bad id" is not allowed'))
  assert.equal(existsSync(path.join(env.DSH_HOME, 'profiles', 'work')), false)
})

test('providerId recursion guards mirror the bridge (I25)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.1')
  const tarball = writeTarball(root, release)
  const { lines, log } = makeLogs()
  const result = await runSetup({
    argv: ['--profile', 'work', '--upstream-provider', 'p', '--vision-provider', 'q', '--vision-model', 'm', '--provider-id', 'p', '--tarball', tarball, '--yes'],
    env, log, releaseMap: releaseMapFor([release]),
  })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('must not equal upstreamProvider'))
})

/* ------------------------------------------------------------------ */
/* I18/I19 — download failure and checksum mismatch                    */
/* ------------------------------------------------------------------ */

test('download failure: clean abort, no profile writes (I18)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.4', { scoped: true })
  const { lines, log } = makeLogs()
  const fetchImpl = async () => { throw new Error('connection refused (stub)') }
  const result = await runSetup({ argv: [...baseArgs('work'), '--yes'], env, log, releaseMap: releaseMapFor([release]), fetchImpl })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('connection refused'))
  assert.equal(existsSync(path.join(env.DSH_HOME, 'profiles', 'work')), false)
  assert.deepEqual(readdirSync(path.join(root, 'plain-temp')).filter((name) => name.startsWith('dsh-vision-bridge-setup-')), [])
})

test('checksum mismatch: artifact deleted, nothing installed (I19)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.4', { scoped: true })
  // Stub fetch returns bytes whose SHA differs from the map entry.
  const fetchImpl = async () => {
    return new Response('tampered bytes', { status: 200 })
  }
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--yes'], env, log, releaseMap: releaseMapFor([release]), fetchImpl })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('SHA-256 mismatch'))
  assert.equal(existsSync(path.join(env.DSH_HOME, 'profiles', 'work')), false)
})

test('unmapped tarball sha is refused (I19/I31)', async (t) => {
  const { root, env } = withEnv(t)
  const tarball = path.join(root, 'unknown.tgz')
  writeFileSync(tarball, 'not a mapped release')
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', tarball, '--yes'], env, log, releaseMap: releaseMapFor([makeRelease('0.2.1')]) })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('matches no trusted release'))
})

/* ------------------------------------------------------------------ */
/* I20 — plugin install failure                                        */
/* ------------------------------------------------------------------ */

test('plugin install failure: profile left alone, Manual Installation hint (I20)', async (t) => {
  const { root, env } = withEnv(t)
  env.FAKE_DSH_ADD_FAIL = '1'
  const release = makeRelease('0.2.1')
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('DSH plugin install failed'))
  assert.ok(lines.join('\n').includes('Manual Installation'))
  // The installer wrote no config after the failed add. (DSH's own init may
  // have created the profile template — upstream behavior, not the installer.)
  const patchPath = path.join(env.DSH_HOME, 'profiles', 'work', 'cordis.patch.yml')
  const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  assert.equal(patchText.includes('upstreamProvider: provider-a'), false, 'installer config must not be written after a failed add')
})

/* ------------------------------------------------------------------ */
/* I21 — config write failure + Option B rollback                      */
/* ------------------------------------------------------------------ */

test('config write failure: package kept, config untouched, clear message (I21)', async (t) => {
  const { root, env } = withEnv(t)
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-work',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }))
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchFile, '# original\n- id: user-row\n  config: { keep: true }\n')
  // Windows: the read-only attribute makes the atomic replace fail after the
  // plugin add succeeded — exactly the Option B rollback scenario.
  if (process.platform === 'win32') chmodSync(patchFile, 0o444)
  t.after(() => {
    if (process.platform === 'win32') {
      try { chmodSync(patchFile, 0o666) } catch { /* best effort */ }
    }
  })

  const release = makeRelease('0.2.1')
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 1)
  const message = lines.join('\n')
  assert.ok(message.includes('configuration write failed'))
  assert.ok(message.includes('remains installed'))
  // package installed (plugin add succeeded before the config step)
  assert.equal(existsSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge', 'package.json')), true)
  // config untouched
  assert.equal(readFileSync(patchFile, 'utf8'), '# original\n- id: user-row\n  config: { keep: true }\n')
})

/* ------------------------------------------------------------------ */
/* I22 — dump-config failure + rollback                                */
/* ------------------------------------------------------------------ */

test('dump-config failure: config restored, package remains installed (I22)', async (t) => {
  const { root, env } = withEnv(t)
  env.FAKE_DSH_DUMP_FAIL = '1'
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-work',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }))
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '# pre-existing\n- id: user-row\n  config: { keep: true }\n')

  const release = makeRelease('0.2.1')
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 1)
  const message = lines.join('\n')
  assert.ok(message.includes('validation failed'))
  assert.ok(message.includes('package remains installed'))
  // config restored to the pre-existing content
  const patch = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch, '# pre-existing\n- id: user-row\n  config: { keep: true }\n')
  // package remains installed
  assert.equal(existsSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge', 'package.json')), true)
})

/* ------------------------------------------------------------------ */
/* I23/I24/I26/I37 — spaces, what-if, honeypot                         */
/* ------------------------------------------------------------------ */

test('DSH_HOME with spaces works end to end (I23/I37)', async (t) => {
  const { root, env } = withEnv(t)
  const spacedHome = path.join(root, 'dsh home with spaces')
  mkdirSync(spacedHome, { recursive: true })
  env.DSH_HOME = spacedHome
  const release = makeRelease('0.2.1')
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  assert.ok(existsSync(path.join(spacedHome, 'profiles', 'work', 'node_modules', 'dsh-vision-bridge', 'package.json')))
})

test('spaced TEMP falls back to a space-free candidate root (I23)', async (t) => {
  const { root, env } = withEnv(t)
  const spacedRoot = path.join(root, 'Temp with spaces')
  mkdirSync(spacedRoot, { recursive: true })
  env.TEMP = spacedRoot
  env.TMP = spacedRoot
  const release = makeRelease('0.2.1')
  const { lines, log } = makeLogs()
  env.FAKE_DSH_LOG = path.join(root, 'fake.log')
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const addEvent = readFakeLog(env).find((event) => event.cmd === 'add')
  assert.ok(addEvent, 'plugin add ran')
  assert.equal(addEvent.cwd.includes(' '), false, 'cwd must be space-free')
  if (process.platform === 'win32') {
    // Probe order: TEMP (spaced, skipped) -> %SystemRoot%\Temp (space-free).
    assert.ok(addEvent.cwd.startsWith(path.join(process.env.SystemRoot, 'Temp')), `fallback root used, got ${addEvent.cwd}`)
  }
})

test('--tarball from spaced and Unicode source paths (I34/I35)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.1')
  const spacedUnicodeDir = path.join(root, 'downloads with spaces')
  mkdirSync(spacedUnicodeDir, { recursive: true })
  const unicodeTarball = path.join(spacedUnicodeDir, 'bridge-图片.tgz')
  writeFileSync(unicodeTarball, release.content)
  env.FAKE_DSH_LOG = path.join(root, 'fake.log')
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', unicodeTarball, '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const addEvent = readFakeLog(env).find((event) => event.cmd === 'add')
  assert.ok(addEvent.argv[4].startsWith('./'), 'controlled relative name passed to DSH')
  assert.ok(!addEvent.argv[4].includes('图片'), 'unicode/source path never reaches DSH')
  assert.ok(!addEvent.cwd.includes('downloads with spaces'), 'installer temp stays space-free')
})

test('--what-if performs zero writes and no download (I26)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.1')
  const tarball = writeTarball(root, release)
  const beforeHome = snapshotTree(env.DSH_HOME)
  const beforeTemp = snapshotTree(path.join(root, 'plain-temp'))
  let fetchCalled = false
  const fetchImpl = async () => { fetchCalled = true; throw new Error('must not be called') }
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', tarball, '--what-if'], env, log, releaseMap: releaseMapFor([release]), fetchImpl })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  assert.equal(fetchCalled, false)
  assert.deepEqual(snapshotTree(env.DSH_HOME), beforeHome, 'DSH_HOME unchanged')
  assert.deepEqual(snapshotTree(path.join(root, 'plain-temp')), beforeTemp, 'temp root unchanged')
  const out = lines.join('\n')
  assert.ok(out.includes('--what-if: nothing was downloaded'))
  assert.ok(out.includes('upstreamProvider: provider-a'), 'YAML preview present')
  assert.ok(out.includes('exact YAML that would be written'))
  // no temp dirs created anywhere
  const leftover = readdirSync(path.join(root, 'plain-temp')).filter((name) => name.startsWith('dsh-vision-bridge-setup-'))
  assert.deepEqual(leftover, [])
})

test('credential honeypot is never read or logged (I27)', async (t) => {
  const { root, env } = withEnv(t)
  const honeypot = 'SECRET_HONEYPOT_9f3a2b7c_never_log_me'
  writeFileSync(path.join(env.DSH_HOME, '.credentials.yaml'), `apiKey: ${honeypot}\n`)
  writeFileSync(path.join(env.DSH_HOME, '.env'), `TOKEN=${honeypot}\n`)
  const release = makeRelease('0.2.1')
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  assert.ok(!lines.join('\n').includes(honeypot), 'honeypot value must never appear in output')
  assert.equal(readFileSync(path.join(env.DSH_HOME, '.credentials.yaml'), 'utf8').includes(honeypot), true, 'honeypot untouched')
})

test('profile name whitelist enforced end to end (I24)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.1')
  const { lines, log } = makeLogs()
  for (const bad of ['bad name', '..\\evil', 'node_modules', 'a/b']) {
    const result = await runSetup({ argv: ['--profile', bad, '--upstream-provider', 'a', '--vision-provider', 'b', '--vision-model', 'm', '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
    assert.equal(result.exitCode, 1, `profile ${bad} must be rejected`)
  }
  assert.ok(lines.join('\n').includes('intentionally restricts profile names'))
})

test('interactive profile menu selects by number and collects ids (I3)', async (t) => {
  const { root, env } = withEnv(t)
  for (const name of ['alpha', 'beta']) {
    mkdirSync(path.join(env.DSH_HOME, 'profiles', name), { recursive: true })
    writeFileSync(path.join(env.DSH_HOME, 'profiles', name, 'package.json'), JSON.stringify({ name: `dsh-profile-${name}`, dsh: { profile: { bundles: [] } } }))
  }
  const release = makeRelease('0.2.1')
  const answers = ['2', 'provider-a', 'provider-b', 'vision-model-a']
  const asked = []
  const prompt = async (question) => {
    asked.push(question)
    return answers.shift() ?? ''
  }
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: ['--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]), prompt })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  assert.ok(asked.some((question) => question.includes('Select profile')), 'profile menu asked')
  assert.ok(existsSync(path.join(env.DSH_HOME, 'profiles', 'beta', 'node_modules', 'dsh-vision-bridge', 'package.json')), 'selection [2] = beta installed')
  assert.equal(existsSync(path.join(env.DSH_HOME, 'profiles', 'alpha', 'node_modules', 'dsh-vision-bridge', 'package.json')), false, 'alpha untouched')
})

test('anomalous existing bridge row fails loudly with zero writes', async (t) => {
  const { root, env } = withEnv(t)
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-work', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), 'id: dsh-vision-bridge\nconfig: {}\n')
  const before = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  const release = makeRelease('0.2.1')
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('existing bridge configuration is unusable'))
  assert.equal(readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), before, 'file untouched')
})

/* ------------------------------------------------------------------ */
/* v0.2.4 scoped identity: fresh install, legacy migration, guards     */
/* ------------------------------------------------------------------ */

function seedLegacyProfile(env, name, { deadSpec = true, thirdParty = false } = {}) {
  const profileDir = path.join(env.DSH_HOME, 'profiles', name)
  const legacyDir = path.join(profileDir, 'node_modules', 'dsh-vision-bridge')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(path.join(legacyDir, 'package.json'), JSON.stringify(thirdParty
    ? { name: 'dsh-vision-bridge', version: '0.1.0' }
    : { name: 'dsh-vision-bridge', version: '0.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const depSpec = deadSpec
    ? 'file:C:/nowhere/dsh-vision-bridge-setup-deadbeef/dsh-vision-bridge-0.2.3.tgz'
    : 'file:C:/tmp/dsh-vision-bridge-0.2.3.tgz'
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: { 'dsh-vision-bridge': thirdParty ? '^0.1.0' : depSpec },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-vision-bridge'] } },
  }, null, 2))
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
    '- id: dsh-vision-bridge',
    '  config:',
    '    upstreamProvider: old-a',
    '    visionProvider: old-b',
    '    visionModel: old-m',
    '',
  ].join('\n'))
  return profileDir
}

test('fresh scoped install leaves exactly one scoped identity (T2)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.4', { scoped: true })
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.ok('@liangdacheng/dsh-vision-bridge' in manifest.dependencies, 'scoped dependency key present')
  assert.equal(manifest.dependencies['dsh-vision-bridge'], undefined, 'no legacy dependency key')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@liangdacheng/dsh-vision-bridge'])
  assert.ok(existsSync(path.join(profileDir, 'node_modules', '@liangdacheng', 'dsh-vision-bridge', 'package.json')))
  assert.equal(existsSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge', 'package.json')), false)
})

test('same-version scoped rerun is a zero-write no-op (T9)', async (t) => {
  const { root, env } = withEnv(t)
  const release = makeRelease('0.2.4', { scoped: true })
  const tarball = writeTarball(root, release)
  const { lines, log } = makeLogs()
  const first = await runSetup({ argv: [...baseArgs('work'), '--tarball', tarball, '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(first.exitCode, 0, lines.join('\n'))
  const before = snapshotTree(path.join(env.DSH_HOME, 'profiles'))
  const second = await runSetup({ argv: [...baseArgs('work'), '--tarball', tarball, '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(second.exitCode, 0, lines.join('\n'))
  assert.ok(lines.join('\n').includes('No changes required'))
  assert.deepEqual(snapshotTree(path.join(env.DSH_HOME, 'profiles')), before, 'second run must not write anything')
})

test('legacy dead-file upgrade migrates to the scoped identity (T5/T6/T7)', async (t) => {
  const { root, env } = withEnv(t)
  seedLegacyProfile(env, 'work')
  const release = makeRelease('0.2.4', { scoped: true })
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: ['--profile', 'work', '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['dsh-vision-bridge'], undefined, 'legacy dependency removed')
  assert.ok('@liangdacheng/dsh-vision-bridge' in manifest.dependencies, 'scoped dependency present')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@liangdacheng/dsh-vision-bridge'], 'exactly one bridge bundle')
  assert.equal(existsSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge')), false, 'legacy package files pruned')
  assert.ok(existsSync(path.join(profileDir, 'node_modules', '@liangdacheng', 'dsh-vision-bridge', 'package.json')))
  const patch = readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes('upstreamProvider: old-a'), 'bridge config preserved')
  assert.ok(patch.includes('visionProvider: old-b'))
  assert.ok(patch.includes('visionModel: old-m'))
  assert.ok(lines.join('\n').includes('composed configuration verified'), lines.join('\n'))
  assert.ok(lines.join('\n').includes('legacy dependency/bundle cleaned'), 'migration reported')
})

test('legacy healthy upgrade migrates the non-dead dependency too (T5b)', async (t) => {
  const { root, env } = withEnv(t)
  seedLegacyProfile(env, 'work', { deadSpec: false })
  const release = makeRelease('0.2.4', { scoped: true })
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: ['--profile', 'work', '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['dsh-vision-bridge'], undefined)
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@liangdacheng/dsh-vision-bridge'])
  assert.equal(existsSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge')), false)
})

test('migration failure restores the pre-upgrade manifest and leaves no half state (T8)', async (t) => {
  const { root, env } = withEnv(t)
  env.FAKE_DSH_ADD_FAIL = '1'
  seedLegacyProfile(env, 'work')
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  const manifestBefore = readFileSync(path.join(profileDir, 'package.json'), 'utf8')
  const release = makeRelease('0.2.4', { scoped: true })
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: ['--profile', 'work', '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('DSH plugin install failed'))
  assert.ok(lines.join('\n').includes('pre-upgrade profile manifest was restored'))
  assert.equal(readFileSync(path.join(profileDir, 'package.json'), 'utf8'), manifestBefore, 'manifest byte-identical to the pre-upgrade state')
  assert.equal(existsSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge', 'package.json')), true, 'legacy package files untouched on failure')
  assert.equal(existsSync(path.join(profileDir, 'node_modules', '@liangdacheng')), false, 'no scoped package after failure')
})

test('unowned unscoped dependency fails closed and is never modified (A16)', async (t) => {
  const { root, env } = withEnv(t)
  seedLegacyProfile(env, 'work', { thirdParty: true })
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  const manifestBefore = readFileSync(path.join(profileDir, 'package.json'), 'utf8')
  const release = makeRelease('0.2.4', { scoped: true })
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: ['--profile', 'work', '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('cannot positively identify'), lines.join('\n'))
  assert.equal(readFileSync(path.join(profileDir, 'package.json'), 'utf8'), manifestBefore)
  assert.equal(existsSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge', 'package.json')), true)
})

test('unowned unscoped dependency without a bundle entry is left untouched and install proceeds (A16b)', async (t) => {
  const { root, env } = withEnv(t)
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-work',
    private: true,
    dependencies: { 'dsh-vision-bridge': '^0.1.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))
  const release = makeRelease('0.2.4', { scoped: true })
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: [...baseArgs('work'), '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['dsh-vision-bridge'], '^0.1.0', 'foreign dependency untouched')
  assert.ok('@liangdacheng/dsh-vision-bridge' in manifest.dependencies, 'scoped bridge installed alongside')
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@liangdacheng/dsh-vision-bridge'])
})

test('duplicate identities are repaired to a single scoped identity (T6b)', async (t) => {
  const { root, env } = withEnv(t)
  seedLegacyProfile(env, 'work', { deadSpec: false })
  const profileDir = path.join(env.DSH_HOME, 'profiles', 'work')
  const scopedDir = path.join(profileDir, 'node_modules', '@liangdacheng', 'dsh-vision-bridge')
  mkdirSync(scopedDir, { recursive: true })
  writeFileSync(path.join(scopedDir, 'package.json'), JSON.stringify({ name: '@liangdacheng/dsh-vision-bridge', version: '0.2.4', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const manifestPath = path.join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies['@liangdacheng/dsh-vision-bridge'] = 'file:C:/tmp/dsh-vision-bridge-0.2.4.tgz'
  manifest.dsh.profile.bundles.push('@liangdacheng/dsh-vision-bridge')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const release = makeRelease('0.2.4', { scoped: true })
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: ['--profile', 'work', '--tarball', writeTarball(root, release), '--yes'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  const after = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(after.dependencies['dsh-vision-bridge'], undefined, 'legacy dependency removed')
  assert.ok('@liangdacheng/dsh-vision-bridge' in after.dependencies)
  assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@liangdacheng/dsh-vision-bridge'])
  assert.equal(existsSync(path.join(profileDir, 'node_modules', 'dsh-vision-bridge')), false)
})

test('--what-if with a legacy profile performs zero writes', async (t) => {
  const { root, env } = withEnv(t)
  seedLegacyProfile(env, 'work')
  const beforeHome = snapshotTree(env.DSH_HOME)
  const beforeTemp = snapshotTree(path.join(root, 'plain-temp'))
  const release = makeRelease('0.2.4', { scoped: true })
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: ['--profile', 'work', '--tarball', writeTarball(root, release), '--what-if'], env, log, releaseMap: releaseMapFor([release]) })
  assert.equal(result.exitCode, 0, lines.join('\n'))
  assert.deepEqual(snapshotTree(env.DSH_HOME), beforeHome, 'DSH_HOME unchanged')
  assert.deepEqual(snapshotTree(path.join(root, 'plain-temp')), beforeTemp, 'temp root unchanged')
})

test('non-interactive missing args produce a usage error', async (t) => {
  const { root, env } = withEnv(t)
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: ['--profile', 'work', '--yes'], env, log, releaseMap: releaseMapFor([makeRelease('0.2.4', { scoped: true })]) })
  assert.equal(result.exitCode, 1)
  assert.ok(lines.join('\n').includes('--upstream-provider, --vision-provider, and --vision-model are required together'))
})

test('help prints without touching anything', async (t) => {
  const { root, env } = withEnv(t)
  const { lines, log } = makeLogs()
  const result = await runSetup({ argv: ['--help'], env, log })
  assert.equal(result.exitCode, 0)
  assert.ok(lines.join('\n').includes('Usage:'))
})
