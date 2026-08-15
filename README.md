# dsh-vision-bridge

A DSH-native vision bridge: a synthetic image-capable wrapper provider that
converts native `ImageBlock` attachments into structured vision evidence for
a text-only DSH reasoning provider.

**Community plugin for DeepSeek Harness (DSH) — not affiliated with or
endorsed by DeepSeek. v0.2.0. Distributed as a release tarball; not on npm.**

## Compatibility

- Tested against the DeepSeek Harness checkout commit
  `47f943859bef60e4160492346772ded9b24f765a`.
- DeepSeek Harness is a **developer preview**: interfaces may change and
  future compatibility is not guaranteed. The verified environment is
  scoped to the tested baseline.
- No claims are made about other DSH versions, other operating systems, or
  Vision providers beyond the tested pi-ai-backed route.
- Installation is verified via the packaged tarball only; npm and Git-source
  installation are not proven paths.

## Architecture

```
DSH ImageAttachment (durable, attachment ref)
  -> Vision Wrapper (synthetic adapter, inputModalities: text+image)
  -> Vision Analyzer (one ctx.llm.stream call per content-container work unit
     on the configured image-capable DSH route)
  -> Structured Evidence (validated locally)
  -> Evidence Transformer (evidence rendered as explicitly-UNTRUSTED text)
  -> downstream text-only upstream provider (ctx.llm.stream, same signal)
```

The production plugin consumes **`ctx.llm` only** and **never reads raw image
bytes**: ImageBlocks pass through verbatim to the vision route, whose own
adapter resolves bytes via `ctx.attachments.readImage`. The plugin has **zero
runtime dependencies** and no secret store of its own — vision credentials
belong to the configured DSH vision provider (DSH Credentials layer).

## Configuration (plugin row config)

```yaml
- id: dsh-vision-bridge
  config:
    upstreamProvider: deepseek-official   # explicit text-only reasoning route
    visionProvider: <dsn vision route>    # DSH route serving an image-capable model
    visionModel: <vision model id>
    # providerId: <optional wrapper id, default "<upstreamProvider>-vision-bridge">
```

`upstreamProvider === visionProvider` is allowed (same route, different models).

## Behavior contract

- **Catalog** (`listModels`): upstream route unavailable -> diagnostic + empty
  catalog (no throw). Text-only models are exposed as wrapped models;
  image-capable / unknown-modality models are omitted.
- **Execution** (`resolveModel` / `stream`): fail closed. Unresolvable,
  unknown, or image-capable upstream models refuse to wrap; the vision route
  must be positively image-capable.
- **Single-image work units**: one vision call per image occurrence, single
  Evidence object, in-place evidence replacement — the sealed Stage 1/1R
  behavior.
- **Multi-image work units (content-container batch)**: one maximal run of
  consecutive non-tool-result blocks containing two or more images becomes
  ONE vision call carrying all images in traversal order; the downstream wire
  replaces each image in place with a positional `[Image n]` anchor and
  appends one batch Evidence block, so the original text/image association is
  preserved. Tool-result content is a recursive boundary (each nesting level
  processes independently; work units never merge across boundaries or
  messages). Work units run serially in traversal order.
- **Multi-image Evidence**: `{ images: [{ index, summary, ocr, layout,
  semantics, visual, uncertainty }], relations: [{ imageIndexes,
  description }] }`. Indexes are 1..N in work-unit order and are shared by the
  vision input order, the `[Image n]` anchors, and `relations`.
- **Failure semantics**: any vision failure (route error, stream error, abort,
  no finish, tool-call finish, empty output, invalid JSON, schema-invalid
  evidence) fails the request explicitly — **the downstream provider is never
  invoked without valid evidence**, and a failed batch never emits partial
  evidence.
- **Cancellation**: one request signal threads wrapper -> vision -> downstream;
  cancellation before downstream means downstream is not called.
- **Evidence cache (v0.2.0)**: in-memory, session-partitioned, completed
  validated Evidence only, bounded LRU. A cache hit reuses the exact validated
  Evidence with zero vision calls; failures and cancellations are never
  cached; the cache is not persistent and disappears with the plugin fiber
  (config reload / disable / remove). Missing `sessionId` or invalid
  attachment ids bypass the cache and vision runs normally. No shared work /
  single-flight is performed.
- **Untrusted-data boundary**: evidence delivered downstream is explicitly
  labeled untrusted observed data and must not be executed as instructions
  (prompt-injection mitigation only — NOT a security boundary).

## Evidence contract (ModLens v2 concepts)

`summary`, `ocr{full_text, lines[]}`, `layout{regions[]}`,
`semantics{scene, entities[]}`, `visual{}`, `uncertainty[]`.
No bbox, no numeric confidence. Invalid evidence MUST NOT reach downstream.

## Provenance

Recursive ImageBlock/tool-result traversal, evidence projection, evidence
schema concepts, and the local validation approach are adapted from
@liustack/modlens v3.16.6 (MIT, (c) Leon Liu) — see THIRD_PARTY_NOTICES.md.
No ModLens code is directly copied.

## Development

```sh
pnpm install        # devDeps only: typescript, @types/node
pnpm run build      # tsc -> dist
pnpm test           # node:test against dist
pnpm pack           # release artifact (see files whitelist)
```

Runtime dependencies: **0**.
