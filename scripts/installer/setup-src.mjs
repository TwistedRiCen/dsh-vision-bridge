/**
 * dsh-vision-bridge installer — source module.
 *
 * This file is the single installer source. The release artifact is a
 * standalone bundle built from it by scripts/installer/build.mjs:
 *
 *   scripts/installer/setup-src.mjs  --esbuild-->  dist-installer/setup.mjs
 *
 * The bundle is self-contained (yaml and undici are inlined) and must run
 * from any directory with no sibling files. Everything here is written so
 * that no dangerous shell command string is ever constructed:
 *
 *   - every subprocess runs through Node with `shell: false` and an
 *     argument array (Windows .cmd shims are resolved to their JS entry);
 *   - the pinned DSH CLI is materialized and invoked as
 *     `node <dsh>/lib/bin.js ...`;
 *   - the tarball is always referenced as `./<controlled-name>.tgz` with
 *     the child process cwd set to an installer-owned space-free temp dir.
 *
 * Frozen decisions honored here: DSH pin @deepseek-ai/dsh@0.1.0-rc.6,
 * Node >= 22.19, no provider/model auto-discovery, no credentials access,
 * no port handling, no telemetry, no real LLM/Vision calls.
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, fsyncSync,
  lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { parseDocument, isMap, isSeq } from 'yaml'
import { fetch as undiciFetch, EnvHttpProxyAgent } from 'undici'

/* ------------------------------------------------------------------ */
/* Frozen constants                                                    */
/* ------------------------------------------------------------------ */

/** Installer identity. */
export const SETUP_VERSION = '0.2.4'

/** The one DSH CLI version this installer materializes and drives. */
export const DSH_PIN = '0.1.0-rc.6'
export const DSH_PACKAGE_SPEC = `@deepseek-ai/dsh@${DSH_PIN}`
export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
export const DSH_BIN_REL = 'lib/bin.js'

/** Minimum Node.js version required by the bridge runtime contract. */
export const NODE_MIN_VERSION = '22.19.0'

/**
 * Bridge identity. Since v0.2.4 the canonical npm/Node package identity is
 * the scoped name; v0.2.3 and earlier installed the legacy unscoped name.
 * The cordis ROW id stays 'dsh-vision-bridge' forever so existing profile
 * config rows keep addressing the bridge across the identity migration.
 */
export const BRIDGE_PACKAGE_NAME = '@liangdacheng/dsh-vision-bridge'
export const LEGACY_PACKAGE_NAME = 'dsh-vision-bridge'
export const BRIDGE_ROW_ID = 'dsh-vision-bridge'

/** Bridge versions that were released under the legacy unscoped identity. */
export const LEGACY_RELEASE_VERSIONS = Object.freeze(['0.2.1', '0.2.2', '0.2.3'])

/** The bridge release this installer installs by default. */
export const DEFAULT_BRIDGE_VERSION = '0.2.4'

/**
 * Trusted release map. The SHA-256 values here are the ONLY accepted
 * identities for downloaded or locally supplied tarballs. A version that is
 * not in this map is refused for automatic download, and a local tarball is
 * refused unless its SHA-256 matches a mapped entry.
 *
 * The 0.2.4 entry carries `packageName`: the scoped npm identity inside the
 * tarball. Entries without `packageName` are the legacy unscoped releases.
 */
export const RELEASE_MAP = Object.freeze({
  '0.2.4': Object.freeze({
    asset: 'dsh-vision-bridge-0.2.4.tgz',
    url: 'https://github.com/TwistedRiCen/dsh-vision-bridge/releases/download/v0.2.4/dsh-vision-bridge-0.2.4.tgz',
    sha256: 'D7B555371F7BCA46BD3E1DEB6437076DE31D12B6D7EE8D7932BFC1B13E8153B9',
    packageName: '@liangdacheng/dsh-vision-bridge',
  }),
  '0.2.3': Object.freeze({
    asset: 'dsh-vision-bridge-0.2.3.tgz',
    url: 'https://github.com/TwistedRiCen/dsh-vision-bridge/releases/download/v0.2.3/dsh-vision-bridge-0.2.3.tgz',
    sha256: 'D6D5D2A3FFECA2FD9213DA9A34A527E19321E8DB44CD0FCFCFCC168B42FE16C1',
  }),
  '0.2.2': Object.freeze({
    asset: 'dsh-vision-bridge-0.2.2.tgz',
    url: 'https://github.com/TwistedRiCen/dsh-vision-bridge/releases/download/v0.2.2/dsh-vision-bridge-0.2.2.tgz',
    sha256: 'D5EB402017756FC5DC54E0E6E01DFA77216DC8B81A1EF3418F01B2962181EA7F',
  }),
  '0.2.1': Object.freeze({
    asset: 'dsh-vision-bridge-0.2.1.tgz',
    url: 'https://github.com/TwistedRiCen/dsh-vision-bridge/releases/download/v0.2.1/dsh-vision-bridge-0.2.1.tgz',
    sha256: 'A3E02C67F629C0C30BA74114B77E721C4F48EE884C83E31608E00EE71030837C',
  }),
})

/**
 * Strict profile-name whitelist. DSH itself accepts a wider set of names,
 * but DSH forwards plugin arguments to pnpm through a shell on Windows
 * without quoting; restricting names to this safe subset keeps every token
 * in that chain free of spaces and shell metacharacters.
 */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Provider/model id whitelist (installer subset; the bridge accepts any non-empty string). */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.@/-]{1,128}$/

/** Download budget for one release asset. */
export const DOWNLOAD_TIMEOUT_MS = 120_000

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

/** Parse a semver-ish string into comparable parts; prerelease sorts before release. */
export function parseSemverParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version))
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? null : match[4].split('.'),
  }
}

/** Compare two semver-ish strings. Returns -1, 0, or 1; unparseable sorts lowest. */
export function compareSemver(left, right) {
  const a = parseSemverParts(left)
  const b = parseSemverParts(right)
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease === null && b.prerelease === null) return 0
  if (a.prerelease === null) return 1
  if (b.prerelease === null) return -1
  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const av = a.prerelease[i] ?? ''
    const bv = b.prerelease[i] ?? ''
    if (av === bv) continue
    const an = /^\d+$/.test(av) ? Number(av) : NaN
    const bn = /^\d+$/.test(bv) ? Number(bv) : NaN
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an < bn ? -1 : 1
    if (!Number.isNaN(an)) return -1
    if (!Number.isNaN(bn)) return 1
    return av < bv ? -1 : 1
  }
  return 0
}

/** Format a backup timestamp: YYYYMMDD-HHmmssZ (UTC, deterministic). */
export function formatBackupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

/** Backup path for a file: <file>.backup-<stamp>; collision-safe. */
export function backupPathFor(filePath, now = new Date()) {
  const base = `${filePath}.backup-${formatBackupStamp(now)}`
  if (!existsSync(base)) return base
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base}-${i}`
    if (!existsSync(candidate)) return candidate
  }
  return `${base}-${randomBytes(4).toString('hex')}`
}

/** Copy a file to its timestamped backup path; returns the backup path (null if absent). */
export function createBackup(filePath, now = new Date()) {
  if (!existsSync(filePath)) return null
  const backup = backupPathFor(filePath, now)
  copyFileSync(filePath, backup)
  return backup
}

/** Hex SHA-256 of a file's bytes (uppercase). */
export function sha256File(filePath) {
  const hash = createHash('sha256')
  const input = createReadStream(filePath)
  return new Promise((resolve, reject) => {
    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
}

/** Synchronous sibling-temp + fsync + rename atomic write. */
export function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  writeFileSync(tmp, content, 'utf8')
  let fd
  try {
    fd = openSync(tmp, 'r+')
    fsyncSync(fd)
  } catch {
    // fsync is best-effort on some filesystems.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
  try {
    renameSync(tmp, filePath)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* CLI arguments                                                       */
/* ------------------------------------------------------------------ */

/** Usage text shown by --help. */
export function usageText() {
  return `dsh-vision-bridge setup ${SETUP_VERSION} (implementation candidate)

Usage:
  node setup.mjs [options]

Options:
  --profile <name>           DSH profile to install into (created if missing)
  --upstream-provider <id>   text-only provider route to wrap
  --vision-provider <id>     provider route serving the vision model
  --vision-model <id>        image-capable model id on the vision route
  --provider-id <id>         optional custom wrapper provider id
  --version <release>        bridge release version to install (default ${DEFAULT_BRIDGE_VERSION})
  --tarball <path>           install from a local release tarball (SHA-256 verified)
  --yes                      skip the final confirmation (never skips security checks)
  --what-if                  print the plan without downloading or writing anything
  --help                     show this help`
}

/**
 * Parse installer arguments. Returns { options, errors }. Unknown flags and
 * missing values are collected into errors, never guessed.
 */
export function parseArgs(argv) {
  const options = { yes: false, whatIf: false, help: false }
  const errors = []
  const seen = new Set()
  const valueFlags = new Map([
    ['--profile', 'profile'],
    ['--upstream-provider', 'upstreamProvider'],
    ['--vision-provider', 'visionProvider'],
    ['--vision-model', 'visionModel'],
    ['--provider-id', 'providerId'],
    ['--version', 'version'],
    ['--tarball', 'tarball'],
  ])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--yes') { options.yes = true; continue }
    if (arg === '--what-if') { options.whatIf = true; continue }
    if (arg === '--help' || arg === '-h') { options.help = true; continue }
    if (valueFlags.has(arg)) {
      const key = valueFlags.get(arg)
      if (seen.has(key)) { errors.push(`duplicate flag: ${arg}`); i += 1; continue }
      seen.add(key)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        errors.push(`${arg} needs a value`)
        continue
      }
      options[key] = value
      i += 1
      continue
    }
    if (arg.startsWith('-')) { errors.push(`unknown flag: ${arg}`); continue }
    errors.push(`unexpected argument: ${arg}`)
  }
  return { options, errors }
}

/* ------------------------------------------------------------------ */
/* Validation (frozen whitelists)                                      */
/* ------------------------------------------------------------------ */

/** Validate a profile name against the frozen strict subset. */
export function validateProfileName(name) {
  if (typeof name !== 'string' || name.trim() !== name || name.length === 0) {
    throw new Error('profile name must be a non-empty string without surrounding whitespace')
  }
  if (!PROFILE_NAME_PATTERN.test(name) || name === 'node_modules') {
    throw new Error(
      'The installer intentionally restricts profile names to letters, numbers, underscore and hyphen '
      + 'for safe DSH CLI invocation. Got: ' + JSON.stringify(name),
    )
  }
  return name
}

/** Validate a provider/model id against the frozen whitelist. */
export function validateProviderId(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace`)
  }
  if (!PROVIDER_ID_PATTERN.test(value)) {
    throw new Error(
      `${label} ${JSON.stringify(value)} is not allowed. Use letters, digits, and . _ @ / - only `
      + '(max 128 characters).',
    )
  }
  return value
}

/**
 * Build and validate the bridge config object. Mirrors the bridge runtime
 * guards (src/index.ts validateConfig): the wrapper id must never equal the
 * upstream or vision route. The optional providerId is only written when
 * explicitly provided; otherwise the bridge default applies.
 */
export function buildBridgeConfig({ upstreamProvider, visionProvider, visionModel, providerId }) {
  const upstream = validateProviderId(upstreamProvider, 'upstreamProvider')
  const vision = validateProviderId(visionProvider, 'visionProvider')
  const model = validateProviderId(visionModel, 'visionModel')
  const wrapperId = providerId === undefined ? `${upstream}-vision-bridge` : validateProviderId(providerId, 'providerId')
  if (wrapperId === upstream) {
    throw new Error(`providerId "${wrapperId}" must not equal upstreamProvider (the wrapper would wrap itself)`)
  }
  if (wrapperId === vision) {
    throw new Error(`providerId "${wrapperId}" must not equal visionProvider (vision calls would recurse)`)
  }
  const config = { upstreamProvider: upstream, visionProvider: vision, visionModel: model }
  if (providerId !== undefined) config.providerId = wrapperId
  return config
}

/** True when an existing config carries the three required non-empty strings. */
export function isConfigComplete(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return false
  return ['upstreamProvider', 'visionProvider', 'visionModel']
    .every((key) => typeof config[key] === 'string' && config[key].trim() !== '')
}

/* ------------------------------------------------------------------ */
/* DSH_HOME and profile discovery                                      */
/* ------------------------------------------------------------------ */

/** Resolve DSH_HOME the same way DSH does: $DSH_HOME (trimmed, tilde-expanded) else ~/.dsh. */
export function resolveDshHome(env = process.env) {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim().length > 0) {
    const value = raw.trim()
    if (value === '~') return path.resolve(homedir())
    if (value.startsWith('~/') || value.startsWith('~\\')) {
      return path.resolve(path.join(homedir(), value.slice(2)))
    }
    return path.resolve(value)
  }
  return path.join(homedir(), '.dsh')
}

/**
 * Enumerate existing profiles: real directories under <home>/profiles that
 * contain a package.json. node_modules (the launcher-maintained module
 * fallback), dot directories, and symlinks are excluded. Sorted by name.
 */
export function listProfiles(dshHome) {
  const root = path.join(dshHome, 'profiles')
  if (!existsSync(root)) return []
  let names
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter((name) => name.length > 0 && !name.startsWith('.') && name !== 'node_modules')
    .map((name) => path.join(root, name))
    .filter((dir) => {
      try {
        const stat = lstatSync(dir)
        return stat.isDirectory() && !stat.isSymbolicLink() && existsSync(path.join(dir, 'package.json'))
      } catch {
        return false
      }
    })
    .map((dir) => ({ name: path.basename(dir), dir }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ */
/* Environment checks                                                  */
/* ------------------------------------------------------------------ */

/** Locate a command on PATH (where.exe / which), returning the first hit or null. */
export function findOnPath(command, env = process.env, platform = process.platform) {
  const result = spawnSync(
    platform === 'win32' ? 'where.exe' : 'which',
    [command],
    { env, shell: false, encoding: 'utf8' },
  )
  if (result.status !== 0) return null
  const first = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
  return first ?? null
}

/**
 * Resolve a Windows cmd-shim (.cmd) to the JS entry it invokes, using the
 * stable cmd-shim `%~dp0\...` / `%dp0%\...` layout. Returns null when the
 * file is not a parseable shim (actionable diagnostics belong to the caller).
 */
export function resolveShimToNodeEntry(shimPath) {
  let text
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  const candidates = []
  for (const match of text.matchAll(/%~dp0([^"\r\n]+)/g)) candidates.push(match[1])
  for (const match of text.matchAll(/%dp0%([^"\r\n]+)/g)) candidates.push(match[1])
  for (const raw of candidates) {
    if (!/\.(?:js|cjs|mjs)$/.test(raw)) continue
    const relative = raw.replace(/^\\+/, '').replace(/\\/g, '/')
    const resolved = path.resolve(path.dirname(shimPath), relative)
    if (existsSync(resolved)) return resolved
  }
  return null
}

/** Resolve the npm JS CLI entry from the npm shim on PATH. */
export function resolveNpmCliEntry(env = process.env, platform = process.platform) {
  const shim = findOnPath('npm', env, platform)
  if (shim === null) return null
  if (platform === 'win32') return resolveShimToNodeEntry(shim)
  return existsSync(shim) ? shim : null
}

/** Resolve the npx JS CLI entry from the npx shim on PATH. */
export function resolveNpxCliEntry(env = process.env, platform = process.platform) {
  const shim = findOnPath('npx', env, platform)
  if (shim === null) return null
  if (platform === 'win32') return resolveShimToNodeEntry(shim)
  return existsSync(shim) ? shim : null
}

/** The npm _npx cache root for the current platform. */
export function npxCacheRoot(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    if (local !== undefined && local.trim() !== '') return path.join(local, 'npm-cache', '_npx')
  }
  return path.join(homedir(), '.npm', '_npx')
}

/**
 * Locate the pinned DSH CLI in the npm _npx cache. The cache hash layout is
 * opaque, so the lookup walks every cache entry and validates the package
 * version field — the version is authoritative.
 */
export function findNpxCachedDsh(env = process.env, platform = process.platform) {
  const root = npxCacheRoot(env, platform)
  if (!existsSync(root)) return null
  let names
  try {
    names = readdirSync(root)
  } catch {
    return null
  }
  for (const name of names) {
    const manifest = path.join(root, name, 'node_modules', DSH_PACKAGE_NAME, 'package.json')
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      if (parsed.version !== DSH_PIN) continue
      const bin = path.join(root, name, 'node_modules', DSH_PACKAGE_NAME, DSH_BIN_REL)
      if (existsSync(bin)) return bin
    } catch {
      // Not this entry; keep walking.
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Subprocess runner                                                   */
/* ------------------------------------------------------------------ */

/**
 * Run one command through Node with an argument array. This is the ONLY
 * subprocess path: no shell, no string-built command lines.
 */
export function runNodeCommand(nodeExecutable, args, options = {}) {
  const result = spawnSync(nodeExecutable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Verify a resolved dsh entry reports exactly the pinned version. */
export function verifyDshEntry(entry, nodeExecutable = process.execPath) {
  const result = runNodeCommand(nodeExecutable, [entry, '--version'])
  return result.status === 0 && result.stdout.trim() === DSH_PIN
}

/* ------------------------------------------------------------------ */
/* DSH materialization                                                 */
/* ------------------------------------------------------------------ */

/**
 * Resolve the pinned DSH CLI entry.
 *
 * Order: (1) the npm _npx cache (already materialized by a previous run),
 * (2) a warm-up through the resolved npx JS entry (constant arguments),
 * (3) `npm install --prefix <private-dir>` through the resolved npm JS entry
 * (constant arguments). Every step is `node <entry> <args>` with
 * shell:false. Returns { entry, prefix } where prefix is only set by step 3.
 */
export function resolveDshEntry({ env = process.env, platform = process.platform, nodeExecutable = process.execPath, tempDir, log = () => {} } = {}) {
  const cached = findNpxCachedDsh(env, platform)
  if (cached !== null && verifyDshEntry(cached, nodeExecutable)) {
    log(`ok: DSH ${DSH_PIN} found in the npm cache`)
    return { entry: cached, prefix: null }
  }

  const npxEntry = resolveNpxCliEntry(env, platform)
  if (npxEntry !== null) {
    log(`ok: materializing ${DSH_PACKAGE_SPEC} through npm (one-time)`)
    const warm = runNodeCommand(nodeExecutable, [npxEntry, '-y', DSH_PACKAGE_SPEC, '--version'], { env, timeoutMs: 10 * 60_000 })
    if (warm.status === 0 && warm.stdout.trim() === DSH_PIN) {
      const after = findNpxCachedDsh(env, platform)
      if (after !== null && verifyDshEntry(after, nodeExecutable)) {
        return { entry: after, prefix: null }
      }
    } else {
      log(`note: npx warm-up did not verify (${warm.status === null ? 'killed' : `exit ${warm.status}`})`)
    }
  }

  const npmEntry = resolveNpmCliEntry(env, platform)
  if (npmEntry === null) {
    throw new Error('neither the npm npx cache nor the npm CLI could be located; install npm (it ships with Node.js) and retry')
  }
  if (tempDir === undefined) {
    throw new Error('a private temporary directory is required to materialize the pinned DSH CLI')
  }
  const prefix = path.join(tempDir, 'dsh-prefix')
  mkdirSync(prefix, { recursive: true })
  log(`ok: installing ${DSH_PACKAGE_SPEC} into a private prefix (one-time)`)
  const install = runNodeCommand(nodeExecutable, [
    npmEntry, 'install', '--prefix', prefix,
    '--no-save', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error',
    DSH_PACKAGE_SPEC,
  ], { env, timeoutMs: 15 * 60_000 })
  if (install.status !== 0) {
    throw new Error(`npm install of ${DSH_PACKAGE_SPEC} failed (exit ${install.status === null ? 'killed' : install.status}); check network/proxy and retry`)
  }
  const entry = path.join(prefix, 'node_modules', DSH_PACKAGE_NAME, DSH_BIN_REL)
  if (!existsSync(entry) || !verifyDshEntry(entry, nodeExecutable)) {
    throw new Error(`materialized DSH at ${prefix} does not report version ${DSH_PIN}; refusing to continue`)
  }
  return { entry, prefix }
}

/* ------------------------------------------------------------------ */
/* Temporary directory strategy (frozen)                               */
/* ------------------------------------------------------------------ */

/**
 * Temp-root candidates in the frozen probe order. On Windows only roots
 * whose path is space-free and free of cmd metacharacters are usable, and
 * the REAL path (after symlink/junction resolution) must satisfy the same
 * rule. No 8.3 short names are ever used.
 */
export function tempRootCandidates(env = process.env, platform = process.platform) {
  const candidates = []
  if (platform === 'win32') {
    for (const value of [env.TEMP, env.TMP, env.SystemRoot !== undefined ? path.join(env.SystemRoot, 'Temp') : null, env.PUBLIC]) {
      if (value !== undefined && value !== null && value.trim() !== '') candidates.push(value.trim())
    }
  } else {
    for (const value of [env.TMPDIR, '/tmp']) {
      if (value !== undefined && value !== null && value.trim() !== '') candidates.push(value.trim())
    }
  }
  return [...new Set(candidates.map((value) => path.resolve(value)))]
}

/** True when a Windows path is space-free and cmd-safe (ASCII, no metacharacters). */
export function isSpaceFreeCmdSafe(target) {
  if (target.includes(' ')) return false
  return /^[A-Za-z0-9:._/\\-]+$/.test(target)
}

/** Pick the first acceptable temp root without writing anything (plan/--what-if). */
export function pickTempRoot(env = process.env, platform = process.platform) {
  const windows = platform === 'win32'
  for (const root of tempRootCandidates(env, platform)) {
    if (windows && !isSpaceFreeCmdSafe(root)) continue
    return root
  }
  return null
}

/**
 * Create the installer's private temp directory with fs.mkdtemp semantics
 * under the first acceptable root; the realpath of the result is re-checked
 * so a junction into a spaced location is rejected.
 */
export function createPrivateTempDir(env = process.env, platform = process.platform) {
  const windows = platform === 'win32'
  const failures = []
  for (const root of tempRootCandidates(env, platform)) {
    if (windows && !isSpaceFreeCmdSafe(root)) {
      failures.push(`${root} (path is not space-free)`)
      continue
    }
    try {
      const dir = createPrivateTempDirAt(root)
      const real = realpathSync(dir)
      if (windows && !isSpaceFreeCmdSafe(real)) {
        rmSync(dir, { recursive: true, force: true })
        failures.push(`${root} (resolves to a non-space-free path)`)
        continue
      }
      return real
    } catch (error) {
      failures.push(`${root} (${error?.message ?? 'not writable'})`)
    }
  }
  throw new Error(
    'no writable temporary directory with a space-free path was found '
    + `(tried: ${failures.join('; ')}). This is a Windows shell-quoting constraint of the DSH plugin command; `
    + 'the installer will not fall back to unsafe shell construction.',
  )
}

/** fs.mkdtemp-equivalent under one root (isolated for tests). */
export function createPrivateTempDirAt(root) {
  const suffix = randomBytes(8).toString('hex')
  const dir = path.join(root, `dsh-vision-bridge-setup-${suffix}`)
  mkdirSync(dir, { recursive: false })
  return dir
}

/* ------------------------------------------------------------------ */
/* HTTP client (bundled undici, single copy)                           */
/* ------------------------------------------------------------------ */

/**
 * Build the installer's fetch: undici's own fetch plus, when proxy
 * environment variables are present, an EnvHttpProxyAgent from the SAME
 * bundled undici copy. The dispatcher/global-fetch version skew documented
 * in the Design Correction is avoided by never using Node's global fetch.
 */
export function makeFetch(env = process.env) {
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
  const hasProxy = proxyKeys.some((key) => env[key] !== undefined && env[key].trim() !== '')
  const dispatcher = hasProxy ? new EnvHttpProxyAgent() : undefined
  return (url, options) => undiciFetch(url, { ...options, dispatcher })
}

/** Human-readable summary of a download failure. */
export function describeFetchError(error) {
  if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') {
    return 'download timed out'
  }
  const cause = error?.cause
  if (cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN') {
    return 'DNS resolution failed'
  }
  if (cause?.code === 'ECONNREFUSED') return 'connection refused'
  if (cause?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || cause?.code === 'CERT_HAS_EXPIRED' || String(error?.message ?? '').includes('certificate')) {
    return 'TLS certificate verification failed'
  }
  if (String(error?.message ?? '').toLowerCase().includes('proxy')) {
    return `proxy failure (${error?.message ?? 'unknown proxy error'})`
  }
  return error?.message ?? String(error)
}

/** Stream a URL to a file; never buffers the whole body. Cleans up partial files. */
export async function downloadToFile(url, dest, { fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'dsh-vision-bridge-setup' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`)
  }
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  } catch (error) {
    try { rmSync(dest, { force: true }) } catch { /* best effort */ }
    throw new Error(`download failed (${describeFetchError(error)})`)
  }
}

/* ------------------------------------------------------------------ */
/* YAML mutation (structured only; no string surgery)                  */
/* ------------------------------------------------------------------ */

/** Parse cordis.patch.yml text into a YAML Document, refusing anything unusable. */
export function parsePatchDocument(text) {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new Error(`cordis.patch.yml failed to parse: ${doc.errors[0].message}`)
  }
  return doc
}

/**
 * Read the current state of the bridge row: absent | present (with config) |
 * anomalous (with a reason). Never repairs or guesses.
 */
export function readBridgeRow(text) {
  let doc
  try {
    doc = parsePatchDocument(text)
  } catch (error) {
    return { status: 'anomalous', reason: error.message }
  }
  const top = doc.contents
  if (!isSeq(top)) {
    return { status: 'anomalous', reason: 'cordis.patch.yml top level must be a YAML array; refusing to modify' }
  }
  const indexes = []
  top.items.forEach((item, index) => {
    if (isMap(item) && item.get('id') === BRIDGE_ROW_ID) indexes.push(index)
  })
  if (indexes.length > 1) {
    return { status: 'anomalous', reason: `multiple "${BRIDGE_ROW_ID}" rows found; fix manually, refusing to guess` }
  }
  if (indexes.length === 0) return { status: 'absent' }
  const row = top.items[indexes[0]]
  const configNode = row.get('config', true)
  if (configNode !== undefined && !isMap(configNode)) {
    return { status: 'anomalous', reason: `the existing "${BRIDGE_ROW_ID}" row config is not a YAML map; refusing to modify` }
  }
  const config = configNode === undefined ? {} : configNode.toJSON()
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { status: 'anomalous', reason: `the existing "${BRIDGE_ROW_ID}" row config is unusable; refusing to modify` }
  }
  return { status: 'present', config }
}

/**
 * Structured mutation of the bridge row:
 *   case A (absent): append a new row;
 *   case B (present): replace ONLY the row's config subtree.
 * Untouched entries, comments, and formatting are preserved by the yaml
 * Document CST machinery; only the target config subtree is re-serialized.
 */
export function mutateBridgeRow(text, config) {
  const doc = parsePatchDocument(text)
  const top = doc.contents
  if (!isSeq(top)) {
    throw new Error('cordis.patch.yml top level must be a YAML array; refusing to modify')
  }
  const indexes = []
  top.items.forEach((item, index) => {
    if (isMap(item) && item.get('id') === BRIDGE_ROW_ID) indexes.push(index)
  })
  if (indexes.length > 1) {
    throw new Error(`multiple "${BRIDGE_ROW_ID}" rows found; fix manually, refusing to guess`)
  }
  if (indexes.length === 0) {
    doc.addIn([top.items.length], { id: BRIDGE_ROW_ID, config })
    forceBlockStyle(top, top.items[top.items.length - 1])
    return { text: String(doc), action: 'add' }
  }
  const row = top.items[indexes[0]]
  const configNode = row.get('config', true)
  if (configNode !== undefined && !isMap(configNode)) {
    throw new Error(`the existing "${BRIDGE_ROW_ID}" row config is not a YAML map; refusing to modify`)
  }
  doc.setIn([indexes[0], 'config'], config)
  return { text: String(doc), action: 'update' }
}

/**
 * Force block style on the sequence holding a freshly added row (DSH's own
 * template is a flow-style `[]`) and on the row's config map, so the written
 * YAML matches the documented block shape.
 */
function forceBlockStyle(top, node) {
  if (isSeq(top)) top.flow = false
  if (isMap(node)) {
    node.flow = false
    const configNode = node.get('config', true)
    if (isMap(configNode)) configNode.flow = false
  }
}

/** Round-trip parse check: the serialized text must parse and yield the row. */
export function verifySerializedPatch(text) {
  const state = readBridgeRow(text)
  if (state.status !== 'present') {
    throw new Error(`serialized cordis.patch.yml failed validation: ${state.status === 'anomalous' ? state.reason : 'bridge row missing'}`)
  }
  return true
}

/** Render the bridge config as the YAML block that would be written (preview). */
export function previewConfigYaml(config) {
  const doc = parseDocument('[]\n')
  doc.addIn([0], { id: BRIDGE_ROW_ID, config })
  forceBlockStyle(doc.contents, doc.contents.items[0])
  return String(doc).trimEnd()
}

/* ------------------------------------------------------------------ */
/* package.json bundle fallback (JSON only; never string surgery)      */
/* ------------------------------------------------------------------ */

/** Read the profile package.json manifest (must be a JSON object). */
export function readProfileManifestText(dir) {
  return readFileSync(path.join(dir, 'package.json'), 'utf8')
}

/**
 * Idempotently add a bundle entry to dsh.profile.bundles. Returns the new
 * text and whether anything changed. Refuses a non-array bundles field.
 */
export function addBundleEntry(text, packageName) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`profile package.json failed to parse: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('profile package.json must hold a JSON object')
  }
  const dsh = parsed.dsh ?? {}
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) {
    throw new Error('profile package.json "dsh" section is not an object')
  }
  const profile = dsh.profile ?? {}
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('profile package.json "dsh.profile" section is not an object')
  }
  const bundles = profile.bundles
  if (bundles !== undefined && !Array.isArray(bundles)) {
    throw new Error('profile package.json "dsh.profile.bundles" must be an array; refusing to modify')
  }
  const list = bundles === undefined ? [] : [...bundles]
  if (list.includes(packageName)) return { text, changed: false }
  list.push(packageName)
  parsed.dsh = { ...dsh, profile: { ...profile, bundles: list } }
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, changed: true }
}

/** Bundle-entry presence per identity (read-only view of the manifest). */
export function bridgeBundleState(dir) {
  const state = { scoped: false, legacy: false }
  try {
    const parsed = JSON.parse(readProfileManifestText(dir))
    const bundles = parsed?.dsh?.profile?.bundles
    if (Array.isArray(bundles)) {
      state.scoped = bundles.includes(BRIDGE_PACKAGE_NAME)
      state.legacy = bundles.includes(LEGACY_PACKAGE_NAME)
    }
  } catch {
    // Unreadable manifest: both false; the caller fails loudly elsewhere.
  }
  return state
}

/** True when the profile manifest lists the bridge under either identity. */
export function hasBridgeBundle(dir) {
  const state = bridgeBundleState(dir)
  return state.scoped || state.legacy
}

/** Installed bridge version per the frozen source of truth (scoped first). */
export function installedBridgeVersion(dir) {
  const scopedManifest = path.join(dir, 'node_modules', BRIDGE_PACKAGE_NAME, 'package.json')
  try {
    const parsed = JSON.parse(readFileSync(scopedManifest, 'utf8'))
    if (parsed?.name === BRIDGE_PACKAGE_NAME && typeof parsed?.version === 'string') {
      return parsed.version
    }
  } catch {
    // Not installed under the scoped identity.
  }
  // The legacy fallback is positively identified: an unrelated third-party
  // package under the unscoped name never influences plan-kind or the
  // downgrade gate.
  return legacyInstalledVersion(dir)
}

/**
 * Version of the package in the profile's legacy node_modules slot when it
 * POSITIVELY identifies as a previous dsh-vision-bridge install (unscoped
 * name, a released legacy version, and the dsh.bundle manifest). Anything
 * else — notably the unrelated third-party unscoped npm package — is never
 * treated as ours. Returns null otherwise.
 */
export function legacyInstalledVersion(dir) {
  const manifest = path.join(dir, 'node_modules', LEGACY_PACKAGE_NAME, 'package.json')
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    if (parsed?.name === LEGACY_PACKAGE_NAME
      && typeof parsed?.version === 'string'
      && LEGACY_RELEASE_VERSIONS.includes(parsed.version)
      && parsed?.dsh?.bundle?.patch !== undefined) {
      return parsed.version
    }
  } catch {
    // Absent or unreadable.
  }
  return null
}

/** True when a dependency spec is the installer's own dead temp-tarball path. */
export function isDeadInstallerTarballSpec(spec) {
  return typeof spec === 'string'
    && spec.startsWith('file:')
    && spec.includes('dsh-vision-bridge-setup-')
}

/**
 * Detect any legacy (v0.2.3-era unscoped) bridge presence in a profile:
 * dependency key, bundle entry, or positively identified node_modules
 * package. Returns null when nothing legacy is present. Never guesses,
 * never repairs.
 */
export function detectLegacyInstall(profileDir) {
  if (!existsSync(profileManifestPath(profileDir))) return null
  const parsed = JSON.parse(readProfileManifestText(profileDir))
  const deps = parsed?.dependencies ?? {}
  const bundles = parsed?.dsh?.profile?.bundles
  const hasDep = typeof deps[LEGACY_PACKAGE_NAME] === 'string'
  const hasBundle = Array.isArray(bundles) && bundles.includes(LEGACY_PACKAGE_NAME)
  const nodeModulesVersion = legacyInstalledVersion(profileDir)
  if (!hasDep && !hasBundle && nodeModulesVersion === null) return null
  return {
    depSpec: hasDep ? deps[LEGACY_PACKAGE_NAME] : null,
    hasDep,
    hasBundle,
    nodeModulesVersion,
  }
}

/** True when the scoped bridge dependency is the installer's own dead temp spec. */
export function hasDeadScopedSpec(profileDir) {
  try {
    const parsed = JSON.parse(readProfileManifestText(profileDir))
    return isDeadInstallerTarballSpec(parsed?.dependencies?.[BRIDGE_PACKAGE_NAME])
  } catch {
    return false
  }
}

/**
 * Remove a positively identified legacy bridge identity from the profile
 * manifest (dependency key + bundle entry) before the scoped package is
 * installed. Also drops a dead scoped `file:` spec the installer itself may
 * have written into a now-deleted temp dir on an earlier run.
 *
 * Safety boundary: the legacy dependency/bundle are only removed when they
 * positively identify as this bridge — a `file:` spec pointing into an
 * installer temp dir, or an installed legacy package with a released legacy
 * version and the dsh.bundle manifest. An unidentified legacy presence makes
 * the migration FAIL CLOSED (the unrelated third-party unscoped npm package
 * is never removed, not even from a profile).
 *
 * Returns { changed, depRemoved, bundleRemoved, deadScopedRemoved }. The
 * caller owns the manifest backup and the post-install node_modules prune.
 */
export function cleanupLegacyIdentity(profileDir) {
  const parsed = JSON.parse(readProfileManifestText(profileDir))
  const deps = parsed?.dependencies ?? {}
  const bundles = parsed?.dsh?.profile?.bundles
  const bundleList = Array.isArray(bundles) ? bundles : null
  const legacy = detectLegacyInstall(profileDir)
  const ownsBySpec = legacy !== null && isDeadInstallerTarballSpec(legacy.depSpec)
  const ownsByInstall = legacy !== null && legacy.nodeModulesVersion !== null
  // An unidentified legacy BUNDLE entry would duplicate the bridge identity
  // once the scoped package lands: fail closed rather than touch it. An
  // unidentified legacy DEPENDENCY without a bundle entry is not ours —
  // it is left untouched (third-party safety) and cannot create a
  // duplicate bundle.
  if (legacy !== null && legacy.hasBundle && !ownsBySpec && !ownsByInstall) {
    throw new Error(
      `the profile lists the unscoped package "${LEGACY_PACKAGE_NAME}" as a bundle that the installer `
      + 'cannot positively identify as a previous dsh-vision-bridge install; refusing to modify it. '
      + 'Remove that bundle entry manually, then re-run the installer.',
    )
  }
  const result = { changed: false, depRemoved: false, bundleRemoved: false, deadScopedRemoved: false }
  const nextDeps = { ...deps }
  if (legacy !== null && legacy.hasDep && (ownsBySpec || ownsByInstall)) {
    delete nextDeps[LEGACY_PACKAGE_NAME]
    result.depRemoved = true
  }
  if (typeof nextDeps[BRIDGE_PACKAGE_NAME] === 'string' && isDeadInstallerTarballSpec(nextDeps[BRIDGE_PACKAGE_NAME])) {
    delete nextDeps[BRIDGE_PACKAGE_NAME]
    result.deadScopedRemoved = true
  }
  if (legacy !== null && legacy.hasBundle && bundleList !== null && (ownsBySpec || ownsByInstall)) {
    parsed.dsh.profile.bundles = bundleList.filter((name) => name !== LEGACY_PACKAGE_NAME)
    result.bundleRemoved = true
  }
  if (result.depRemoved || result.deadScopedRemoved) parsed.dependencies = nextDeps
  result.changed = result.depRemoved || result.bundleRemoved || result.deadScopedRemoved
  if (result.changed) {
    writeFileAtomic(profileManifestPath(profileDir), `${JSON.stringify(parsed, null, 2)}\n`)
    const reparsed = JSON.parse(readProfileManifestText(profileDir))
    if (result.depRemoved && reparsed?.dependencies?.[LEGACY_PACKAGE_NAME] !== undefined) {
      throw new Error('legacy dependency removal failed verification; the manifest was not updated correctly')
    }
  }
  return result
}

/**
 * Prune the positively identified legacy bridge package from the profile's
 * node_modules. Identity-guarded: anything that is not positively a previous
 * dsh-vision-bridge install is left untouched. Call only AFTER the scoped
 * install succeeded.
 */
export function pruneLegacyNodeModules(profileDir) {
  const legacyDir = path.join(profileDir, 'node_modules', LEGACY_PACKAGE_NAME)
  if (!existsSync(legacyDir)) return false
  if (legacyInstalledVersion(profileDir) === null) return false
  rmSync(legacyDir, { recursive: true, force: true })
  return true
}

/* ------------------------------------------------------------------ */
/* Plan computation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Compute the plan kind from the installed package version, the target
 * version, and the current bridge-row state.
 */
export function computePlanKind({ installedVersion, targetVersion, configState }) {
  if (installedVersion !== null && compareSemver(installedVersion, targetVersion) > 0) {
    return 'downgrade'
  }
  if (installedVersion !== null && compareSemver(installedVersion, targetVersion) === 0) {
    if (configState.status === 'present' && isConfigComplete(configState.config)) return 'no-changes'
    return 'same-version-repair'
  }
  return installedVersion === null ? 'install' : 'upgrade'
}

/** Resolve the target release: version, entry, and tarball source. */
export function resolveTargetRelease({ versionFlag, tarballFlag, releaseMap = RELEASE_MAP }) {
  if (tarballFlag === undefined) {
    const version = versionFlag ?? DEFAULT_BRIDGE_VERSION
    const entry = releaseMap[version]
    if (entry === undefined) {
      throw new Error(
        `bridge version ${JSON.stringify(version)} is not in the installer's trusted release map; `
        + 'refusing to download an unverifiable version. Use a mapped version or --tarball with a trusted checksum.',
      )
    }
    return { version, entry, source: 'download' }
  }
  const version = versionFlag
  if (version !== undefined) {
    const entry = releaseMap[version]
    if (entry === undefined) {
      throw new Error(
        `bridge version ${JSON.stringify(version)} is not in the installer's trusted release map; `
        + 'a local tarball can only be installed against a mapped release.',
      )
    }
    return { version, entry, source: 'tarball' }
  }
  return { version: null, entry: null, source: 'tarball' }
}

/** Match a tarball SHA against the release map: returns { version, entry } or throws. */
export function matchTarballSha(sha, version, releaseMap = RELEASE_MAP) {
  if (version !== null && version !== undefined) {
    const entry = releaseMap[version]
    if (entry === undefined) {
      throw new Error(`bridge version ${JSON.stringify(version)} is not in the installer's trusted release map`)
    }
    if (entry.sha256 !== sha) {
      throw new Error(
        `SHA-256 mismatch for --tarball: expected ${entry.sha256} (release ${version}), got ${sha}. The file is not the trusted release; refusing to install.`,
      )
    }
    return { version, entry }
  }
  for (const [candidateVersion, candidate] of Object.entries(releaseMap)) {
    if (candidate.sha256 === sha) return { version: candidateVersion, entry: candidate }
  }
  throw new Error(
    `the SHA-256 of --tarball (${sha}) matches no trusted release in the installer's release map; `
    + 'refusing to install an unverifiable file. Supply --version <mapped-release> to check against a specific release.',
  )
}

/* ------------------------------------------------------------------ */
/* Profile file helpers                                                */
/* ------------------------------------------------------------------ */

export function profilePatchPath(profileDir) {
  return path.join(profileDir, 'cordis.patch.yml')
}

export function profileManifestPath(profileDir) {
  return path.join(profileDir, 'package.json')
}

/** Find the newest `cordis.patch.yml.backup-*` in a profile dir (rollback). */
export function findLatestBackup(patchPath) {
  const dir = path.dirname(patchPath)
  const prefix = `${path.basename(patchPath)}.backup-`
  let best = null
  let bestMtime = 0
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue
    const candidate = path.join(dir, name)
    try {
      const mtime = lstatSync(candidate).mtimeMs
      if (mtime >= bestMtime) {
        bestMtime = mtime
        best = candidate
      }
    } catch {
      // Not this one.
    }
  }
  return best
}

/**
 * Restore the profile patch file from its newest backup (rollback, Option B:
 * keep the installed package, restore the configuration). When the file did
 * not exist before the write and no backup exists, the written file is
 * removed instead. Returns true when the original state was restored.
 */
export function rollbackConfig({ profileDir, originalExisted, backupPath }) {
  const patchPath = profilePatchPath(profileDir)
  try {
    if (backupPath !== null && existsSync(backupPath)) {
      try {
        writeFileAtomic(patchPath, readFileSync(backupPath, 'utf8'))
      } catch {
        // Last-resort non-atomic restore (e.g. a read-only target).
        writeFileSync(patchPath, readFileSync(backupPath, 'utf8'), 'utf8')
      }
      return true
    }
    if (!originalExisted && existsSync(patchPath)) {
      unlinkSync(patchPath)
    }
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Installer flow                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run the installer end to end.
 *
 * deps: { argv, env, platform, nodeExecutable, prompt, log,
 *         releaseMap, fetchImpl }
 * Every filesystem effect happens inside the target profile or the
 * installer's private temp dir; --what-if performs none of them.
 *
 * Returns { exitCode }.
 */
export async function runSetup(deps = {}) {
  const {
    argv = process.argv.slice(2),
    env = process.env,
    platform = process.platform,
    nodeExecutable = process.execPath,
    prompt = null,
    log = (line) => console.log(line),
    releaseMap = RELEASE_MAP,
    fetchImpl = null,
  } = deps

  const fail = (message) => {
    throw new SetupError(message)
  }

  let tempDir = null
  try {
    const { options, errors: parseErrors } = parseArgs(argv)
    if (options.help) {
      log(usageText())
      return { exitCode: 0 }
    }
    if (parseErrors.length > 0) {
      fail(parseErrors.map((line) => `error: ${line}`).join('\n') + `\n\n${usageText()}`)
    }

    /** Compare the effective bridge config values (providerId defaults applied). */
    const configsEqual = (left, right) => {
      if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
      const effectiveProviderId = (cfg) => cfg.providerId ?? `${cfg.upstreamProvider}-vision-bridge`
      return ['upstreamProvider', 'visionProvider', 'visionModel'].every((key) => left[key] === right[key])
        && effectiveProviderId(left) === effectiveProviderId(right)
    }

    /** Prompt for any of the three ids that were not passed as flags. */
    const promptMissingIds = async () => {
      let upstreamProvider = options.upstreamProvider ?? null
      let visionProvider = options.visionProvider ?? null
      let visionModel = options.visionModel ?? null
      if (upstreamProvider === null) {
        log('Upstream provider (the text-only route to wrap).')
        log('  Find this ID on the DSH Models page.')
        upstreamProvider = await prompt('Upstream provider:')
      }
      if (visionProvider === null) {
        log('Vision provider (the route serving an image-capable model).')
        log('  May be the same provider as upstream.')
        visionProvider = await prompt('Vision provider:')
      }
      if (visionModel === null) {
        log('Vision model (must support image input).')
        visionModel = await prompt('Vision model:')
      }
      return buildBridgeConfig({ upstreamProvider, visionProvider, visionModel, providerId: options.providerId })
    }

    const whatIf = options.whatIf
    const yes = options.yes
    const interactive = prompt !== null

    // 1. Node version gate.
    if (compareSemver(process.versions.node, NODE_MIN_VERSION) < 0) {
      fail(`Node.js ${NODE_MIN_VERSION} or newer is required.\nDetected: ${process.versions.node}`)
    }
    log(`ok: Node.js ${process.versions.node} (>= ${NODE_MIN_VERSION} required)`)

    // 2. pnpm presence (DSH forwards plugin management to pnpm).
    const pnpmShim = findOnPath('pnpm', env, platform)
    if (pnpmShim === null) {
      fail('pnpm was not found on PATH. DSH manages profile plugins through pnpm; install pnpm first (the installer will not install or modify it).')
    }
    log('ok: pnpm found on PATH')

    // 3. DSH status. --what-if performs checks only, never downloads.
    if (!whatIf) {
      log(`note: DSH will be resolved as ${DSH_PACKAGE_SPEC} (pinned)`)
    } else {
      const cached = findNpxCachedDsh(env, platform)
      if (cached !== null && verifyDshEntry(cached, nodeExecutable)) {
        log(`ok: DSH ${DSH_PIN} already materialized in the npm cache`)
      } else if (resolveNpxCliEntry(env, platform) !== null || resolveNpmCliEntry(env, platform) !== null) {
        log(`ok: DSH ${DSH_PIN} will be materialized from npm during the real run (skipped in --what-if)`)
      } else {
        fail('neither the npm npx cache nor the npm CLI could be located; install npm (it ships with Node.js) and retry')
      }
      const globalDsh = findOnPath('dsh', env, platform)
      if (globalDsh !== null) {
        log('note: a global "dsh" was detected; the installer still uses the pinned version for its own steps')
      }
    }

    // 4. Profiles.
    const dshHome = resolveDshHome(env)
    const profiles = listProfiles(dshHome)
    log(`profiles root: ${dshHome}`)

    let profileName = options.profile ?? null
    if (profileName === null) {
      if (!interactive) {
        fail('--profile <name> is required when running non-interactively (or pass --help)')
      }
      const lines = profiles.map((entry, index) => `  [${index + 1}] ${entry.name}`)
      lines.push(`  [${profiles.length + 1}] Create a new profile`)
      log('Profiles:')
      for (const line of lines) log(line)
      const answer = await prompt('Select profile (number or name):')
      if (answer === null) fail('no profile selected')
      const asNumber = Number(answer)
      if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= profiles.length) {
        profileName = profiles[asNumber - 1].name
      } else if (Number.isInteger(asNumber) && asNumber === profiles.length + 1) {
        profileName = null
      } else {
        profileName = answer
      }
    }
    if (profileName === null) {
      const answer = await prompt('New profile name:')
      if (answer === null) fail('no profile name given')
      profileName = answer
    }
    validateProfileName(profileName)
    const profileDir = path.join(dshHome, 'profiles', profileName)
    const profileExists = existsSync(profileManifestPath(profileDir))

    // 5. Target release.
    const target = resolveTargetRelease({ versionFlag: options.version, tarballFlag: options.tarball, releaseMap })

    // 6. Tarball source preparation (SHA gate applies to every path).
    let tarballPlan
    if (target.source === 'tarball') {
      const sourcePath = path.resolve(options.tarball)
      if (!existsSync(sourcePath)) fail(`--tarball file not found: ${sourcePath}`)
      const tarballSha = await sha256File(sourcePath)
      const match = matchTarballSha(tarballSha, target.version, releaseMap)
      tarballPlan = { sourcePath, sha: tarballSha, version: match.version, entry: match.entry }
    } else {
      tarballPlan = { sourcePath: null, sha: target.entry.sha256, version: target.version, entry: target.entry }
    }
    const targetVersion = tarballPlan.version

    // 7. Installed state and plan kind (fails fast on downgrade, before any prompts).
    const installedVersion = profileExists ? installedBridgeVersion(profileDir) : null
    const patchPath = profilePatchPath(profileDir)
    const existingPatchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : null
    const configState = existingPatchText === null ? { status: 'absent' } : readBridgeRow(existingPatchText)
    if (configState.status === 'anomalous') {
      fail(`existing bridge configuration is unusable: ${configState.reason}`)
    }
    const planKind = computePlanKind({ installedVersion, targetVersion, configState })
    if (planKind === 'downgrade') {
      fail(
        `installed version ${installedVersion} is newer than the requested ${targetVersion}; `
        + 'downgrade is not enabled in installer v1. No changes were made.',
      )
    }

    // 8. Provider/model inputs (user-entered by design; no discovery, no guessing)
    //    and the keep/reconfigure/cancel decision.
    let config = null
    let writeConfig = false
    const providerArgsGiven = options.upstreamProvider !== undefined
      && options.visionProvider !== undefined
      && options.visionModel !== undefined
    if (providerArgsGiven) {
      config = buildBridgeConfig({
        upstreamProvider: options.upstreamProvider,
        visionProvider: options.visionProvider,
        visionModel: options.visionModel,
        providerId: options.providerId,
      })
      writeConfig = !(configState.status === 'present' && isConfigComplete(configState.config) && configsEqual(config, configState.config))
    } else if (configState.status === 'present' && isConfigComplete(configState.config)) {
      if (interactive) {
        const answer = await prompt('Bridge configuration already exists. Keep it, reconfigure, or cancel? [keep/reconfigure/cancel]')
        if (answer === null || answer === '' || answer.toLowerCase().startsWith('k')) {
          config = configState.config
          writeConfig = false
        } else if (answer.toLowerCase().startsWith('r')) {
          config = await promptMissingIds()
          writeConfig = !configsEqual(config, configState.config)
        } else if (answer.toLowerCase().startsWith('c')) {
          log('cancelled; no changes were made')
          return { exitCode: 0 }
        } else {
          fail('unrecognized choice; cancelling (no changes were made)')
        }
      } else {
        config = configState.config
        writeConfig = false
      }
    } else if (configState.status === 'absent') {
      if (!interactive) {
        fail('--upstream-provider, --vision-provider, and --vision-model are required together when running non-interactively (or pass --help)')
      }
      config = await promptMissingIds()
      writeConfig = true
    } else {
      // Incomplete existing config: repair requires the three ids.
      if (providerArgsGiven) {
        config = buildBridgeConfig({
          upstreamProvider: options.upstreamProvider,
          visionProvider: options.visionProvider,
          visionModel: options.visionModel,
          providerId: options.providerId,
        })
      } else if (interactive) {
        const answer = await prompt('Existing bridge configuration is incomplete. Reconfigure it now? [y/n]')
        const repair = answer !== null && (answer === '' || answer.toLowerCase().startsWith('y'))
        if (!repair) fail('existing configuration is incomplete and was not repaired; no changes were made')
        config = await promptMissingIds()
      } else {
        fail('existing bridge configuration is incomplete; pass --upstream-provider, --vision-provider, and --vision-model to repair it')
      }
      writeConfig = true
    }

    // 9. Summary.
    log('')
    log('Summary:')
    log(`  Profile:  ${profileName}${profileExists ? '' : ' (will be created on first DSH use)'}`)
    log(`  Action:   ${planKind}`)
    log(`  Version:  ${targetVersion}${installedVersion !== null ? ` (installed: ${installedVersion})` : ''}`)
    log(`  Upstream: ${config.upstreamProvider}`)
    log(`  Vision:   ${config.visionProvider} / ${config.visionModel}`)
    log(`  Source:   ${target.source === 'tarball' ? tarballPlan.sourcePath : tarballPlan.entry.url}`)
    log(`  SHA-256:  ${tarballPlan.entry.sha256}`)
    const tempRoot = pickTempRoot(env, platform)
    log(`  Temp:     ${tempRoot ?? '(none acceptable; the run would fail)'}`)
    log(`  Config:   ${writeConfig ? `will be written to ${patchPath} (backup first)` : 'kept as-is'}`)
    log('')

    if (whatIf) {
      log('--what-if: nothing was downloaded, installed, or written.')
      if (writeConfig) {
        log('')
        log('The configuration below is the exact YAML that would be written:')
        log(previewConfigYaml(config))
      }
      return { exitCode: 0, dryRun: true }
    }

    if (!yes) {
      if (!interactive) {
        fail('--yes is required when running non-interactively (or pass --what-if to preview)')
      }
      const answer = await prompt('Proceed? [Y/n]')
      if (answer !== null && answer.trim() !== '' && !answer.toLowerCase().startsWith('y')) {
        log('cancelled; no changes were made')
        return { exitCode: 0 }
      }
    }

    // Fast path: identical version, valid bundle, complete config, no
    // reconfigure. A profile with ANY legacy bridge presence (duplicate
    // bundle identities, or a legacy dependency the migration owns) is never
    // fast-pathed — the migration must reconcile it first.
    const fastPathBundleState = bridgeBundleState(profileDir)
    if (planKind === 'no-changes' && !writeConfig && profileExists && hasBridgeBundle(profileDir)
      && !(fastPathBundleState.scoped && fastPathBundleState.legacy)
      && detectLegacyInstall(profileDir) === null) {
      log('No changes required (version, bundle list, and configuration are already in place).')
      return { exitCode: 0 }
    }

    // 10. Execute.
    tempDir = createPrivateTempDir(env, platform)
    const dshEntry = resolveDshEntry({ env, platform, nodeExecutable, tempDir, log }).entry
    log(`ok: DSH ${DSH_PIN} ready (pinned)`)

    // 11a. Acquire the tarball into the private temp dir under a controlled
    // ASCII filename; its SHA is enforced regardless of source. The file sits
    // at the temp dir ROOT because the plugin add is spawned with that root
    // as cwd and a `./<name>` relative spec (frozen path strategy).
    const controlledName = tarballPlan.entry.asset
    const artifactPath = path.join(tempDir, controlledName)
    if (target.source === 'tarball') {
      log(`ok: verifying local tarball (${tarballPlan.sourcePath})`)
      copyFileSync(tarballPlan.sourcePath, artifactPath)
    } else {
      log(`ok: downloading ${controlledName}`)
      const fetch = fetchImpl ?? makeFetch(env)
      await downloadToFile(tarballPlan.entry.url, artifactPath, { fetchImpl: fetch })
    }
    const actualSha = await sha256File(artifactPath)
    if (actualSha !== tarballPlan.entry.sha256) {
      rmSync(artifactPath, { force: true })
      fail(`SHA-256 mismatch: expected ${tarballPlan.entry.sha256}, got ${actualSha}. The file was deleted; nothing was installed.`)
    }
    log(`ok: SHA-256 verified (${actualSha})`)

    // 11a+. Legacy identity migration (v0.2.4 scoped targets only): before
    // the scoped package is added, remove a positively identified legacy
    // install from the manifest so the profile ends with exactly one bridge
    // identity. The manifest is backed up first and restored if the
    // subsequent install fails.
    let migrationBackup = null
    if (profileExists && tarballPlan.entry.packageName !== undefined) {
      const legacy = detectLegacyInstall(profileDir)
      if (legacy !== null || hasDeadScopedSpec(profileDir)) {
        migrationBackup = createBackup(profileManifestPath(profileDir))
        try {
          const cleanup = cleanupLegacyIdentity(profileDir)
          if (cleanup.changed) {
            log('ok: previous bridge identity removed (legacy dependency/bundle cleaned before the scoped install)')
          }
        } catch (error) {
          fail(`legacy bridge cleanup failed: ${error.message}`)
        }
      }
    }

    // 11b. Install / upgrade the package (same version skips this step).
    if (planKind !== 'no-changes' && planKind !== 'same-version-repair') {
      log(`ok: installing ${BRIDGE_PACKAGE_NAME} ${targetVersion} into profile "${profileName}"`)
      const add = runNodeCommand(nodeExecutable, [
        dshEntry, 'plugin', '--profile', profileName, 'add', `./${controlledName}`,
      ], { cwd: tempDir, env })
      if (add.status !== 0) {
        if (migrationBackup !== null && existsSync(migrationBackup)) {
          try {
            writeFileAtomic(profileManifestPath(profileDir), readFileSync(migrationBackup, 'utf8'))
            log('note: the pre-upgrade profile manifest was restored')
          } catch {
            log(`note: the pre-upgrade profile manifest backup is at ${migrationBackup}`)
          }
        }
        fail(
          `the DSH plugin install failed (exit ${add.status === null ? 'killed' : add.status}). `
          + 'The profile was left as-is; see the DSH output above and retry, or use Manual Installation.',
        )
      }
    }

    // 11b+. Prune the legacy package files now that the scoped install is
    // verified (identity-guarded; unidentified packages are never touched).
    if (profileExists && tarballPlan.entry.packageName !== undefined && pruneLegacyNodeModules(profileDir)) {
      log('ok: legacy bridge package files removed')
    }

    // 11c. Bundle verification with JSON-only fallback (identity-aware: the
    // fallback adds the exact package identity of the target release).
    const profileReady = existsSync(profileManifestPath(profileDir))
    const targetPackageName = tarballPlan.entry.packageName ?? LEGACY_PACKAGE_NAME
    if (profileReady && !hasBridgeBundle(profileDir)) {
      log('note: the DSH build did not reconcile the bundle list; applying the verified JSON fallback')
      const manifestText = readProfileManifestText(profileDir)
      createBackup(profileManifestPath(profileDir))
      const { text, changed } = addBundleEntry(manifestText, targetPackageName)
      if (changed) {
        writeFileAtomic(profileManifestPath(profileDir), text)
        const reparsed = JSON.parse(readProfileManifestText(profileDir))
        const bundles = reparsed?.dsh?.profile?.bundles
        if (!Array.isArray(bundles) || !bundles.includes(targetPackageName)) {
          fail('bundle fallback failed verification; the profile manifest was not updated correctly')
        }
        log('ok: bundle entry added and verified')
      } else {
        log('ok: bundle entry already present')
      }
    }

    // 11c+. Scoped identity invariant (scoped targets only): exactly one
    // bridge bundle (the scoped one), the scoped dependency key present, and
    // no legacy entries left behind by the migration.
    if (profileExists && tarballPlan.entry.packageName !== undefined) {
      const finalState = bridgeBundleState(profileDir)
      let finalDeps = {}
      try {
        finalDeps = JSON.parse(readProfileManifestText(profileDir))?.dependencies ?? {}
      } catch {
        // Manifest unreadable: treated as missing dependency keys.
      }
      if (!finalState.scoped || finalState.legacy || !(BRIDGE_PACKAGE_NAME in finalDeps)) {
        fail(
          'the profile was not left with exactly the scoped bridge identity '
          + `(scoped bundle: ${finalState.scoped}, legacy bundle: ${finalState.legacy}, `
          + `scoped dependency: ${BRIDGE_PACKAGE_NAME in finalDeps}). `
          + 'The install did not complete consistently; re-run the installer or use Manual Installation.',
        )
      }
    }

    // 11d. Config write with backup + atomic replace (+ Option B rollback).
    let configWrite = null
    if (writeConfig) {
      log('ok: writing bridge configuration')
      const originalExisted = existsSync(patchPath)
      const backup = createBackup(patchPath)
      if (originalExisted && backup === null) {
        fail('failed to back up the existing configuration; no changes were written')
      }
      configWrite = { originalExisted, backup }
      const baseText = originalExisted ? readFileSync(patchPath, 'utf8') : '[]\n'
      try {
        const { text } = mutateBridgeRow(baseText, config)
        verifySerializedPatch(text)
        writeFileAtomic(patchPath, text)
      } catch (error) {
        const restored = (() => {
          try { return rollbackConfig({ profileDir, originalExisted, backupPath: backup }) } catch { return false }
        })()
        fail(
          `configuration write failed (${error.message}). `
          + `${restored ? 'The previous configuration was restored' : 'The previous configuration file was left in place'} `
          + `and ${BRIDGE_PACKAGE_NAME} remains installed. Fix the issue and re-run, or use Manual Installation.`,
        )
      }
      log(`ok: configuration written (backup: ${backup ?? 'none'})`)
    }

    // 11e. dump-config validation (boot-free; no provider calls).
    log('ok: validating with dsh --dump-config')
    const dump = runNodeCommand(nodeExecutable, [dshEntry, '--profile', profileName, '--dump-config'], { env })
    const output = `${dump.stdout}\n${dump.stderr}`
    const rowOk = output.includes(BRIDGE_ROW_ID)
    const valuesOk = config !== null
      && ['upstreamProvider', 'visionProvider', 'visionModel'].every((key) => output.includes(config[key]))
    if (dump.status !== 0 || !rowOk || !valuesOk) {
      if (configWrite !== null) {
        try {
          rollbackConfig({ profileDir, originalExisted: configWrite.originalExisted, backupPath: configWrite.backup })
        } catch {
          // Original file untouched in the worst case; still report clearly.
        }
      }
      const why = dump.status !== 0
        ? `dsh --profile ${profileName} --dump-config exited ${dump.status === null ? 'killed' : dump.status}`
        : 'the composed config is missing the bridge row or one of the three required keys'
      fail(
        `validation failed: ${why}. `
        + 'The configuration was restored; the package remains installed. '
        + 'Check the profile and re-run, or use Manual Installation.',
      )
    }
    log('ok: composed configuration verified (bridge row + all three keys present)')

    log('')
    log(`${BRIDGE_PACKAGE_NAME} ${targetVersion} is ready in profile "${profileName}".`)
    log('Start DSH with:')
    log(`  dsh --profile ${profileName}`)
    log(`  (or: npx -y ${DSH_PACKAGE_SPEC} --profile ${profileName})`)
    log('Then select a "(vision bridge)" model and attach an image.')
    log('No Vision call was made by this installer.')
    return { exitCode: 0 }
  } catch (error) {
    if (error instanceof Error) {
      log(`error: ${error.message}`)
      return { exitCode: 1 }
    }
    log(`error: unexpected failure: ${String(error)}`)
    return { exitCode: 1 }
  } finally {
    if (tempDir !== null) {
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

/** Typed failure carrying a user-facing message. */
export class SetupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SetupError'
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/** Default readline prompt factory (TTY only). */
export function makeTtyPrompt() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  let closed = false
  return async (question) => {
    if (closed) return null
    try {
      const answer = await readline.question(`${question} `)
      return answer.trim() === '' ? '' : answer.trim()
    } catch {
      return null
    }
  }
}

/** Run as a CLI. */
export async function main(argv = process.argv.slice(2)) {
  const prompt = makeTtyPrompt()
  const result = await runSetup({ argv, prompt })
  return result.exitCode
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  const code = await main()
  process.exit(code)
}
