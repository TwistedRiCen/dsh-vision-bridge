/**
 * Installer unit tests: pure helpers, frozen whitelists, release map,
 * temp-root strategy, shim resolution. Deterministic; no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addBundleEntry, backupPathFor, buildBridgeConfig, compareSemver, DSH_PIN,
  formatBackupStamp, isSpaceFreeCmdSafe, matchTarballSha, parseArgs,
  pickTempRoot, PROVIDER_ID_PATTERN, PROFILE_NAME_PATTERN, RELEASE_MAP,
  resolveDshHome, resolveShimToNodeEntry, resolveTargetRelease,
  tempRootCandidates, usageText, validateProfileName, validateProviderId,
} from '../../scripts/installer/setup-src.mjs'

const win = process.platform === 'win32'

/* ------------------------------------------------------------------ */
/* semver                                                              */
/* ------------------------------------------------------------------ */

test('compareSemver orders numeric and prerelease versions', () => {
  assert.equal(compareSemver('22.19.0', '22.19.0'), 0)
  assert.equal(compareSemver('22.20.0', '22.19.0'), 1)
  assert.equal(compareSemver('22.19.0', '22.20.0'), -1)
  assert.equal(compareSemver('0.1.0-rc.6', '0.1.0'), -1)
  assert.equal(compareSemver('0.1.0-rc.10', '0.1.0-rc.9'), 1)
  assert.equal(compareSemver('0.1.0-rc.9', '0.1.0-rc.10'), -1)
  assert.equal(compareSemver('0.1.0-rc.6', '0.1.0-rc.6'), 0)
  assert.equal(compareSemver('0.2.0', '0.2.1'), -1)
  assert.equal(compareSemver('0.2.1', '0.2.0'), 1)
  assert.equal(compareSemver('garbage', '0.2.1'), -1)
})

/* ------------------------------------------------------------------ */
/* CLI parsing                                                         */
/* ------------------------------------------------------------------ */

test('parseArgs collects the frozen flag set', () => {
  const { options, errors } = parseArgs([
    '--profile', 'work', '--upstream-provider', 'a', '--vision-provider', 'b',
    '--vision-model', 'm', '--provider-id', 'p', '--version', '0.2.1',
    '--tarball', 'x.tgz', '--yes', '--what-if',
  ])
  assert.deepEqual(errors, [])
  assert.equal(options.profile, 'work')
  assert.equal(options.upstreamProvider, 'a')
  assert.equal(options.visionProvider, 'b')
  assert.equal(options.visionModel, 'm')
  assert.equal(options.providerId, 'p')
  assert.equal(options.version, '0.2.1')
  assert.equal(options.tarball, 'x.tgz')
  assert.equal(options.yes, true)
  assert.equal(options.whatIf, true)
})

test('parseArgs rejects unknown flags, missing values, duplicates, stray args', () => {
  assert.equal(parseArgs(['--nope']).errors.length, 1)
  assert.equal(parseArgs(['--profile']).errors.length, 1)
  assert.equal(parseArgs(['--profile', 'a', '--profile', 'b']).errors.length, 1)
  assert.equal(parseArgs(['stray']).errors.length, 1)
  assert.equal(parseArgs(['--profile', '--yes']).errors.length, 1)
})

test('usageText names the pinned DSH spec and default version', () => {
  const text = usageText()
  assert.ok(text.includes('0.2.3'))
  assert.ok(text.includes('--what-if'))
  assert.ok(text.includes('--tarball'))
})

/* ------------------------------------------------------------------ */
/* frozen whitelists                                                   */
/* ------------------------------------------------------------------ */

test('validateProfileName accepts the frozen subset and rejects everything else', () => {
  for (const name of ['work', 'work-2', 'Test_Profile', 'a'.repeat(64)]) {
    assert.equal(validateProfileName(name), name)
  }
  for (const name of ['', 'has space', 'a/b', 'a\\b', '.', '..', 'node_modules', 'a'.repeat(65), 'é', 'work ']) {
    assert.throws(() => validateProfileName(name))
  }
  assert.ok(PROFILE_NAME_PATTERN.test('node_modules') === true, 'regex alone would allow it; explicit guard required')
})

test('validateProviderId accepts the frozen subset and rejects everything else', () => {
  for (const id of ['deepseek-official', 'provider.a_b@c/d-1', 'x'.repeat(128)]) {
    assert.equal(validateProviderId(id, 'k'), id)
  }
  for (const id of ['', ' has space ', 'a b', 'x'.repeat(129), 'a;b', 'a&b', 'a|b']) {
    assert.throws(() => validateProviderId(id, 'k'))
  }
  assert.ok(PROVIDER_ID_PATTERN.test('a'.repeat(128)))
})

test('buildBridgeConfig mirrors the bridge runtime guards', () => {
  const base = { upstreamProvider: 'provider-a', visionProvider: 'provider-b', visionModel: 'vision-model-a' }
  const config = buildBridgeConfig(base)
  assert.deepEqual(config, base)
  // Same provider for both roles is explicitly allowed (I17).
  const same = buildBridgeConfig({ upstreamProvider: 'p', visionProvider: 'p', visionModel: 'm' })
  assert.equal(same.upstreamProvider, 'p')
  assert.equal(same.visionProvider, 'p')
  // providerId default applies in the bridge; the installer only writes it explicitly.
  const explicit = buildBridgeConfig({ ...base, providerId: 'my-bridge' })
  assert.equal(explicit.providerId, 'my-bridge')
  // Recursion guards.
  assert.throws(() => buildBridgeConfig({ ...base, providerId: 'provider-a' }), /wrap itself/)
  assert.throws(() => buildBridgeConfig({ ...base, providerId: 'provider-b' }), /recurse/)
})

/* ------------------------------------------------------------------ */
/* DSH_HOME                                                            */
/* ------------------------------------------------------------------ */

test('resolveDshHome mirrors DSH precedence and tilde expansion', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\dsh' }), path.resolve('C:\\dsh'))
  assert.equal(resolveDshHome({ DSH_HOME: '  ' }), path.join(os.homedir(), '.dsh'))
  assert.equal(resolveDshHome({ DSH_HOME: '~/x' }), path.join(os.homedir(), 'x'))
  assert.equal(resolveDshHome({}), path.join(os.homedir(), '.dsh'))
})

/* ------------------------------------------------------------------ */
/* release map                                                         */
/* ------------------------------------------------------------------ */

test('release map is frozen and carries the verified 0.2.3 identity; 0.2.2 stays trusted', () => {
  assert.ok(Object.isFrozen(RELEASE_MAP))
  const entry = RELEASE_MAP['0.2.3']
  assert.equal(entry.asset, 'dsh-vision-bridge-0.2.3.tgz')
  assert.equal(entry.url, 'https://github.com/TwistedRiCen/dsh-vision-bridge/releases/download/v0.2.3/dsh-vision-bridge-0.2.3.tgz')
  assert.equal(entry.sha256, 'D6D5D2A3FFECA2FD9213DA9A34A527E19321E8DB44CD0FCFCFCC168B42FE16C1')
  assert.match(entry.asset, /^dsh-vision-bridge-0\.2\.3\.tgz$/)
  assert.ok(entry.url.endsWith(entry.asset))
  const previous = RELEASE_MAP['0.2.2']
  assert.equal(previous.sha256, 'D5EB402017756FC5DC54E0E6E01DFA77216DC8B81A1EF3418F01B2962181EA7F', '0.2.2 stays trusted')
  assert.equal(RELEASE_MAP['0.2.1'].sha256, 'A3E02C67F629C0C30BA74114B77E721C4F48EE884C83E31608E00EE71030837C', '0.2.1 stays trusted')
})

test('resolveTargetRelease refuses unmapped versions for download', () => {
  assert.equal(resolveTargetRelease({}).version, '0.2.3')
  assert.equal(resolveTargetRelease({ versionFlag: '0.2.3' }).source, 'download')
  assert.equal(resolveTargetRelease({ versionFlag: '0.2.2' }).source, 'download', '0.2.2 remains a mapped release')
  assert.throws(() => resolveTargetRelease({ versionFlag: '9.9.9' }), /trusted release map/)
  assert.equal(resolveTargetRelease({ tarballFlag: 'x.tgz' }).source, 'tarball')
  assert.throws(() => resolveTargetRelease({ tarballFlag: 'x.tgz', versionFlag: '9.9.9' }), /trusted release map/)
})

test('matchTarballSha accepts only mapped identities', () => {
  const sha = RELEASE_MAP['0.2.1'].sha256
  const match = matchTarballSha(sha, null)
  assert.equal(match.version, '0.2.1')
  assert.equal(matchTarballSha(sha, '0.2.1').version, '0.2.1')
  assert.throws(() => matchTarballSha(sha, '0.2.0'), /not in the installer's trusted release map/)
  assert.throws(() => matchTarballSha('DEADBEEF'.repeat(8), '0.2.1'), /SHA-256 mismatch/)
  assert.throws(() => matchTarballSha('DEADBEEF'.repeat(8), null), /matches no trusted release/)
})

/* ------------------------------------------------------------------ */
/* temp-root strategy                                                  */
/* ------------------------------------------------------------------ */

test('isSpaceFreeCmdSafe enforces the frozen Windows rules', () => {
  assert.equal(isSpaceFreeCmdSafe('C:\\Users\\a\\AppData\\Local\\Temp'), true)
  assert.equal(isSpaceFreeCmdSafe('C:\\Users\\John Smith\\Temp'), false)
  assert.equal(isSpaceFreeCmdSafe('C:\\Users\\a&b'), false)
  assert.equal(isSpaceFreeCmdSafe('C:\\Users\\a%b'), false)
  assert.equal(isSpaceFreeCmdSafe('C:\\Users\\a'), true)
})

test('pickTempRoot skips spaced roots on Windows and falls back in probe order', () => {
  const env = {
    TEMP: 'C:\\Users\\John Smith\\Temp',
    TMP: 'C:\\Users\\John Smith\\Temp',
    SystemRoot: 'C:\\Win',
    PUBLIC: 'C:\\Users\\Public Space',
  }
  if (win) {
    assert.equal(pickTempRoot(env, 'win32'), path.resolve('C:\\Win\\Temp'))
  }
  const good = pickTempRoot({ TEMP: 'C:\\ok' }, 'win32')
  if (win) assert.equal(good, path.resolve('C:\\ok'))
  const roots = tempRootCandidates({ TEMP: 'C:\\a', TMP: 'C:\\a', SystemRoot: 'C:\\W', PUBLIC: 'C:\\P' }, 'win32')
  if (win) {
    assert.equal(roots[0], path.resolve('C:\\a'))
    assert.equal(roots[1], path.resolve('C:\\W\\Temp'))
    assert.equal(roots[2], path.resolve('C:\\P'))
    assert.equal(roots.length, 3)
  }
})

/* ------------------------------------------------------------------ */
/* backup naming                                                       */
/* ------------------------------------------------------------------ */

test('formatBackupStamp is deterministic UTC YYYYMMDD-HHmmssZ', () => {
  assert.match(formatBackupStamp(new Date('2026-02-14T15:30:00Z')), /^20260214-153000Z$/)
})

test('backupPathFor is collision-safe', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dg-bu-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'cordis.patch.yml')
  writeFileSync(file, 'x')
  const first = backupPathFor(file, new Date('2026-02-14T15:30:00Z'))
  assert.equal(path.basename(first), 'cordis.patch.yml.backup-20260214-153000Z')
  writeFileSync(first, 'x')
  const second = backupPathFor(file, new Date('2026-02-14T15:30:00Z'))
  assert.equal(path.basename(second), 'cordis.patch.yml.backup-20260214-153000Z-1')
})

/* ------------------------------------------------------------------ */
/* bundle fallback JSON                                                */
/* ------------------------------------------------------------------ */

test('addBundleEntry is idempotent and preserves unrelated fields', () => {
  const input = JSON.stringify({
    name: 'dsh-profile-work',
    private: true,
    dependencies: { 'some-dep': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  })
  const { text, changed } = addBundleEntry(input, 'dsh-vision-bridge')
  assert.equal(changed, true)
  const parsed = JSON.parse(text)
  assert.deepEqual(parsed.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-vision-bridge'])
  assert.deepEqual(parsed.dependencies, { 'some-dep': '1.0.0' })
  const again = addBundleEntry(text, 'dsh-vision-bridge')
  assert.equal(again.changed, false)
  assert.equal(again.text, text)
})

test('addBundleEntry creates missing dsh.profile.bundles and refuses anomalies', () => {
  const { text, changed } = addBundleEntry(JSON.stringify({ name: 'p' }), 'dsh-vision-bridge')
  assert.equal(changed, true)
  assert.deepEqual(JSON.parse(text).dsh.profile.bundles, ['dsh-vision-bridge'])
  assert.throws(() => addBundleEntry('{broken', 'dsh-vision-bridge'), /failed to parse/)
  assert.throws(() => addBundleEntry('[1,2]', 'dsh-vision-bridge'), /JSON object/)
  assert.throws(() => addBundleEntry(JSON.stringify({ dsh: { profile: { bundles: 'nope' } } }), 'dsh-vision-bridge'), /must be an array/)
})

/* ------------------------------------------------------------------ */
/* shim resolution                                                     */
/* ------------------------------------------------------------------ */

function fixtureShim(t, name, content) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dg-shim-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const shim = path.join(dir, name)
  writeFileSync(shim, content)
  return { dir, shim }
}

test('resolveShimToNodeEntry parses npm-global cmd-shim layout', (t) => {
  const { dir, shim } = fixtureShim(t, 'pnpm.cmd', '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\n')
  const target = path.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, '// stub')
  assert.equal(resolveShimToNodeEntry(shim), target)
})

test('resolveShimToNodeEntry parses the Node.js corepack shim and skips node.exe', (t) => {
  const { dir, shim } = fixtureShim(t, 'pnpm.CMD', '@SETLOCAL\n@IF EXIST "%~dp0\\node.exe" (\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\corepack\\dist\\pnpm.js" %*\n) ELSE (\n  node  "%~dp0\\node_modules\\corepack\\dist\\pnpm.js" %*\n)\n')
  const target = path.join(dir, 'node_modules', 'corepack', 'dist', 'pnpm.js')
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, '// stub')
  assert.equal(resolveShimToNodeEntry(shim), target)
})

test('resolveShimToNodeEntry parses the npm npm-cli.js shim and returns null for garbage', (t) => {
  const { dir, shim } = fixtureShim(t, 'npm.cmd', 'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\n')
  const target = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, '// stub')
  assert.equal(resolveShimToNodeEntry(shim), target)
  const { shim: garbage } = fixtureShim(t, 'x.cmd', 'echo nothing useful here')
  assert.equal(resolveShimToNodeEntry(garbage), null)
  assert.equal(resolveShimToNodeEntry(path.join(dir, 'missing.cmd')), null)
})

test('DSH pin constant is the frozen value', () => {
  assert.equal(DSH_PIN, '0.1.0-rc.6')
})
