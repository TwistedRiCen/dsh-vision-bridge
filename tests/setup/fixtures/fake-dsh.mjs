/**
 * Fake DSH CLI for installer tests (deterministic, zero network, zero
 * provider calls). Emulates exactly the surface the installer drives:
 *
 *   --version                              prints the pinned version
 *   plugin --profile <name> add ./x.tgz    init + install + bundle reconcile
 *   plugin --profile <name> install        init + reconcile
 *   plugin --profile <name> remove <pkg>   remove dependency + reconcile
 *   --profile <name> --dump-config         prints the profile patch file
 *
 * Behavior switches (environment):
 *   FAKE_DSH_LOG=<file>        append JSON events {argv, cwd, profile, cmd}
 *   FAKE_DSH_NO_RECONCILE=1    skip the bundle reconciliation (I10 fallback)
 *   FAKE_DSH_ADD_FAIL=1        'add' exits 1 after profile init (I20)
 *   FAKE_DSH_DUMP_FAIL=1       dump-config exits 1 (I22)
 *
 * Tarballs are plain marker files whose content embeds `v<version>`; the
 * "install" step writes node_modules/dsh-vision-bridge/package.json with
 * that version, mirroring the real plugin install outcome.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const PIN = '0.1.0-rc.6'
const HOME = process.env.DSH_HOME
const LOG = process.env.FAKE_DSH_LOG
const NO_RECONCILE = process.env.FAKE_DSH_NO_RECONCILE === '1'
const ADD_FAIL = process.env.FAKE_DSH_ADD_FAIL === '1'
const DUMP_FAIL = process.env.FAKE_DSH_DUMP_FAIL === '1'

function logEvent(extra) {
  if (LOG === undefined) return
  try {
    appendFileSync(LOG, `${JSON.stringify({ argv, cwd: process.cwd(), ...extra })}\n`)
  } catch {
    // diagnostics only
  }
}

function profileDir(name) {
  return path.join(HOME, 'profiles', name)
}

function initProfile(dir) {
  mkdirSync(dir, { recursive: true })
  const manifest = path.join(dir, 'package.json')
  if (!existsSync(manifest)) {
    writeFileSync(manifest, `${JSON.stringify({
      name: `dsh-profile-${path.basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2)}\n`)
  }
  if (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  }
  if (!existsSync(path.join(dir, 'cordis.patch.yml'))) {
    writeFileSync(path.join(dir, 'cordis.patch.yml'), '# your patch layer\n[]\n')
  }
}

function readManifest(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
}

function writeManifest(dir, parsed) {
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(parsed, null, 2)}\n`)
}

function reconcile(dir) {
  if (NO_RECONCILE) return
  const parsed = readManifest(dir)
  const bundles = parsed?.dsh?.profile?.bundles ?? []
  const installed = existsSync(path.join(dir, 'node_modules', 'dsh-vision-bridge', 'package.json'))
  if (installed && !bundles.includes('dsh-vision-bridge')) {
    parsed.dsh.profile.bundles = [...bundles, 'dsh-vision-bridge']
    writeManifest(dir, parsed)
  }
  if (!installed && bundles.includes('dsh-vision-bridge')) {
    parsed.dsh.profile.bundles = bundles.filter((name) => name !== 'dsh-vision-bridge')
    writeManifest(dir, parsed)
  }
}

// --version
if (argv.includes('--version') && !argv.includes('--dump-config')) {
  console.log(PIN)
  process.exit(0)
}

// plugin <...>
if (argv[0] === 'plugin') {
  const name = argv[argv.indexOf('--profile') + 1]
  if (name === undefined || name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name === 'node_modules') {
    console.error(`dsh: invalid profile name ${JSON.stringify(name)}`)
    process.exit(1)
  }
  const dir = profileDir(name)
  initProfile(dir)
  // Launcher shape: plugin --profile <name> <pnpm-command> <args...>
  const cmd = argv[3]
  if (cmd === 'add') {
    if (ADD_FAIL) {
      console.error('fake dsh: add failed by test request')
      process.exit(1)
    }
    const spec = argv[4]
    const relative = spec.replace(/^\.\//, '').replace(/^\.\\/, '')
    const tarball = path.join(process.cwd(), relative)
    if (!existsSync(tarball)) {
      console.error(`[ENOENT] ENOENT: no such file or directory, open '${tarball}'`)
      process.exit(1)
    }
    const version = /v(\d+\.\d+\.\d+)/.exec(readFileSync(tarball, 'utf8'))?.[1] ?? null
    if (version === null) {
      console.error('fake dsh: no version marker in tarball')
      process.exit(1)
    }
    mkdirSync(path.join(dir, 'node_modules', 'dsh-vision-bridge'), { recursive: true })
    writeFileSync(path.join(dir, 'node_modules', 'dsh-vision-bridge', 'package.json'), `${JSON.stringify({ name: 'dsh-vision-bridge', version })}\n`)
    const parsed = readManifest(dir)
    parsed.dependencies = { ...(parsed.dependencies ?? {}), 'dsh-vision-bridge': `file:${tarball.replace(/\\/g, '/')}` }
    writeManifest(dir, parsed)
  } else if (cmd === 'remove') {
    const parsed = readManifest(dir)
    const dependencies = { ...(parsed.dependencies ?? {}) }
    delete dependencies['dsh-vision-bridge']
    parsed.dependencies = dependencies
    rmSync(path.join(dir, 'node_modules', 'dsh-vision-bridge'), { recursive: true, force: true })
    writeManifest(dir, parsed)
  }
  reconcile(dir)
  logEvent({ profile: name, cmd })
  process.exit(0)
}

// --dump-config
if (argv.includes('--dump-config')) {
  if (DUMP_FAIL) {
    console.error('fake dsh: dump-config failed by test request')
    process.exit(1)
  }
  const name = argv[argv.indexOf('--profile') + 1]
  const dir = profileDir(name)
  let patch = ''
  try {
    patch = readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
  } catch {
    // missing patch file
  }
  console.log(`# == fake dump for profile ${name}\n${patch}`)
  logEvent({ profile: name, cmd: 'dump-config' })
  process.exit(0)
}

console.error(`fake dsh: unhandled argv ${JSON.stringify(argv)}`)
process.exit(2)
