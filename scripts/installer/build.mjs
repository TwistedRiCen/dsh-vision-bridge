/**
 * Installer release build: bundles scripts/installer/setup-src.mjs (plus the
 * pinned yaml and undici devDependencies) into the standalone release
 * artifact dist-installer/setup.mjs and writes dist-installer/setup.mjs.sha256.
 *
 * Frozen build rules (Design Correction):
 *   - esbuild JS API, format esm, platform node, target node22, no minify;
 *   - yaml is aliased to its browser build (the node build dynamic-requires
 *     process/assert at runtime and breaks inside an ESM bundle);
 *   - the createRequire + license banner comes from banner.txt;
 *   - output is deterministic: two builds are byte-identical.
 *
 * DSH_SETUP_OUTDIR overrides the output directory (used by the determinism
 * test). The generated artifacts are release outputs, not tracked sources.
 */

import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const outDir = process.env.DSH_SETUP_OUTDIR !== undefined
  ? path.resolve(process.env.DSH_SETUP_OUTDIR)
  : path.join(repoRoot, 'dist-installer')
const banner = readFileSync(path.join(here, 'banner.txt'), 'utf8')

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [path.join(here, 'setup-src.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  minify: false,
  outfile: path.join(outDir, 'setup.mjs'),
  alias: { yaml: path.join(repoRoot, 'node_modules', 'yaml', 'browser', 'dist', 'index.js') },
  banner: { js: banner },
  logLevel: 'info',
})

const bytes = readFileSync(path.join(outDir, 'setup.mjs'))
const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase()
writeFileSync(path.join(outDir, 'setup.mjs.sha256'), `${sha256}  setup.mjs\n`, 'utf8')
console.log(`built dist-installer/setup.mjs (${bytes.length} bytes)`)
console.log(`SHA-256: ${sha256}`)
