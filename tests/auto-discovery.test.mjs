// V0.3 Auto-mode vision-route discovery tests. Fully deterministic mocks — no
// real provider, no file IO. Manual mode is covered by bridge.test.mjs/config.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../dist/index.js'

const VALID_EVIDENCE = {
  summary: 'A deterministic test image: a blue rectangle labelled HELLO-42.',
  ocr: {
    full_text: 'HELLO-42\nFIXTURE-EVIDENCE-LINE-2',
    lines: [{ text: 'HELLO-42' }, { text: 'FIXTURE-EVIDENCE-LINE-2' }],
  },
  layout: {
    regions: [
      { type: 'title', reading_order: 1, text: 'HELLO-42' },
      { type: 'paragraph', reading_order: 2, text: 'FIXTURE-EVIDENCE-LINE-2' },
    ],
  },
  semantics: { scene: 'test fixture', entities: [{ name: 'HELLO-42', type: 'token' }] },
  visual: {},
  uncertainty: ['fixture-only image'],
}

const UPSTREAM = 'upstream-text'
const WRAPPER = `${UPSTREAM}-vision-bridge`

function evidenceStream(json) {
  const text = typeof json === 'string' ? json : JSON.stringify(json)
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

async function drain(iterable) {
  for await (const _ of iterable) { /* drain */ }
}

const imageBlock = (attachmentId = 'sha256:att-1') => ({
  type: 'image',
  attachment: { attachmentId, mediaType: 'image/png', width: 32, height: 32, bytes: 2050 },
})

const isImageCapableLike = (info) =>
  Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')

/**
 * Deterministic auto-mode mock. `providers` is the listProviders graph (the
 * wrapper's own route is NOT included unless the test says so); `models` maps
 * provider id -> catalog models; `resolve` maps `${provider}/${model}` -> an
 * override for resolveModelInfo (info object or Error to throw). Default
 * resolveModelInfo returns the catalog entry (or a text-only fallback).
 *
 * Counters: listProviders / listModels / resolveModelInfo (raw arrays),
 * confirmations (deduped image-capable resolveModelInfo results — the exact
 * "secondary confirmation" count), visionStreams / upstreamStreams.
 */
function makeCtxAuto({ providers = [], models = {}, resolve = {} } = {}) {
  const calls = {
    register: [],
    listProviders: [],
    listModels: [],
    resolveModelInfo: [],
    confirmations: [],
    visionStreams: [],
    upstreamStreams: [],
  }
  const adapters = new Map()
  const confirmedPairs = new Set()
  const llm = {
    registerAdapter(ids, adapter) {
      calls.register.push(ids)
      for (const id of ids) adapters.set(id, adapter)
      return () => {}
    },
    listProviders() {
      calls.listProviders.push(providers)
      return providers
    },
    listModels: async (provider) => {
      calls.listModels.push(provider)
      return models[provider] ?? []
    },
    resolveModelInfo: async (provider, model) => {
      calls.resolveModelInfo.push({ provider, model })
      const key = `${provider}/${model}`
      let info
      if (Object.prototype.hasOwnProperty.call(resolve, key)) {
        const entry = resolve[key]
        if (entry instanceof Error) throw entry
        info = entry
      } else {
        info = (models[provider] ?? []).find((m) => m.id === model)
          ?? { provider, id: model, name: model, inputModalities: ['text'] }
      }
      if (isImageCapableLike(info) && !confirmedPairs.has(key)) {
        confirmedPairs.add(key)
        calls.confirmations.push({ provider, model })
      }
      return info
    },
    stream(options) {
      if (options.provider === UPSTREAM) {
        calls.upstreamStreams.push(options)
        return (async function* () {})()
      }
      calls.visionStreams.push(options)
      return evidenceStream(VALID_EVIDENCE)
    },
  }
  return { ctx: { llm }, calls, adapters }
}

const imageRequest = (sessionId, attachmentId) => ({
  provider: WRAPPER,
  model: 't1',
  sessionId,
  messages: [{ role: 'user', content: [imageBlock(attachmentId)] }],
})

test('T2 auto unique candidate: discovered, confirmed once, vision stream routed', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p-vision', name: 'Vision' }],
    models: { 'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }] },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:t2')))

  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.visionStreams[0].provider, 'p-vision')
  assert.equal(calls.visionStreams[0].model, 'v1')
  assert.equal(calls.upstreamStreams.length, 1)
  assert.equal(calls.listProviders.length, 1)
  assert.deepEqual(calls.listModels, ['p-vision'])
  assert.equal(calls.confirmations.length, 1)
})

test('T3 zero candidate: fails closed with guidance, downstream untouched', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [
      { id: 'p-undef', name: 'Undef' },
      { id: 'p-text', name: 'Text' },
      { id: 'p-empty', name: 'Empty' },
    ],
    models: {
      'p-undef': [{ id: 'm-undef', name: 'Undef' }],
      'p-text': [{ id: 'm-text', name: 'Text', inputModalities: ['text'] }],
      'p-empty': [{ id: 'm-empty', name: 'Empty', inputModalities: [] }],
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await assert.rejects(
    drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:t3'))),
    (error) => /no image-capable model/.test(error.message)
      && /visionProvider/.test(error.message)
      && /visionModel/.test(error.message),
  )
  assert.equal(calls.visionStreams.length, 0)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('T4 multiple candidates: deterministic sorted listing, no credentials, fail closed', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    // Intentionally out-of-order so the sort is actually exercised.
    providers: [
      { id: 'p-b', name: 'PB' },
      { id: 'p-a', name: 'PA' },
    ],
    models: {
      'p-b': [{ id: 'vb', name: 'VB', inputModalities: ['text', 'image'] }],
      'p-a': [{ id: 'va', name: 'VA', inputModalities: ['text', 'image'] }],
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await assert.rejects(
    drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:t4'))),
    (error) => {
      const msg = error.message
      return /multiple image-capable models/.test(msg)
        && msg.indexOf('p-a / va') !== -1
        && msg.indexOf('p-b / vb') !== -1
        && msg.indexOf('p-a / va') < msg.indexOf('p-b / vb')
        && !/api[-_]?key|token|secret|credential/i.test(msg)
    },
  )
  assert.equal(calls.visionStreams.length, 0)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('T7/T8/T9 modality filter: only text+image becomes a candidate', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p', name: 'P' }],
    models: {
      'p': [
        { id: 'm-undef', name: 'Undefined' },
        { id: 'm-text', name: 'Text', inputModalities: ['text'] },
        { id: 'm-image', name: 'Image', inputModalities: ['text', 'image'] },
      ],
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:t7')))

  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.visionStreams[0].model, 'm-image')
  assert.equal(calls.confirmations.length, 1)
  assert.deepEqual(calls.confirmations[0], { provider: 'p', model: 'm-image' })
})

test('T9b explicit [image]-only modality is a candidate', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p', name: 'P' }],
    models: { 'p': [{ id: 'm-img-only', name: 'Image Only', inputModalities: ['image'] }] },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:t9b')))

  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.visionStreams[0].model, 'm-img-only')
  assert.equal(calls.confirmations.length, 1)
})

test('T10 self exclusion: wrapper own route is skipped, real vision wins', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [
      { id: WRAPPER, name: 'Vision Bridge (self)' },
      { id: 'p-vision', name: 'Vision' },
    ],
    models: {
      // If self were NOT excluded, both entries would be image-capable and
      // discovery would fail as "multiple". The wrapper's own route must be
      // filtered out deterministically before any catalog enumeration.
      [WRAPPER]: [{ id: 'v1', name: 'Self V1', inputModalities: ['text', 'image'] }],
      'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }],
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:t10')))

  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.visionStreams[0].provider, 'p-vision')
  assert.deepEqual(calls.listModels, ['p-vision'])
})

test('T11 lazy: pure-text request never triggers discovery', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p-vision', name: 'Vision' }],
    models: { 'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }] },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'plain question' }] }]
  await drain(adapters.get(WRAPPER).stream({ provider: WRAPPER, model: 't1', messages }))

  assert.equal(calls.listProviders.length, 0)
  assert.equal(calls.listModels.length, 0)
  assert.equal(calls.resolveModelInfo.length, 0)
  assert.equal(calls.visionStreams.length, 0)
  assert.equal(calls.upstreamStreams.length, 1)
})

test('T12 first image discovery once: every provider enumerated, one confirmation', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [
      { id: 'p-text', name: 'Text' },
      { id: 'p-vision', name: 'Vision' },
    ],
    models: {
      'p-text': [{ id: 't1', name: 'T1', inputModalities: ['text'] }],
      'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }],
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:t12')))

  assert.equal(calls.listProviders.length, 1)
  assert.equal(calls.listModels.length, 2)
  assert.equal(calls.confirmations.length, 1)
  assert.equal(calls.visionStreams[0].provider, 'p-vision')
})

test('T13 pin reuse: second image request (different session) does not rediscover', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p-vision', name: 'Vision' }],
    models: { 'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }] },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await drain(adapters.get(WRAPPER).stream(imageRequest('s1', 'sha256:t13-a')))
  const listProvidersAfter1 = calls.listProviders.length
  const listModelsAfter1 = calls.listModels.length
  const confirmationsAfter1 = calls.confirmations.length

  await drain(adapters.get(WRAPPER).stream(imageRequest('s2', 'sha256:t13-b')))

  assert.equal(calls.listProviders.length, listProvidersAfter1)
  assert.equal(calls.listModels.length, listModelsAfter1)
  assert.equal(calls.confirmations.length, confirmationsAfter1)
  assert.equal(calls.visionStreams.length, 2)
  assert.equal(calls.visionStreams[0].provider, calls.visionStreams[1].provider)
  assert.equal(calls.visionStreams[0].model, calls.visionStreams[1].model)
})

test('T14 manual bypass: full three-key config never calls listProviders/listModels', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p-vision', name: 'Vision' }],
    models: { 'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }] },
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: 'p-vision', visionModel: 'v1' })
  await drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:t14')))

  assert.equal(calls.listProviders.length, 0)
  assert.equal(calls.listModels.length, 0)
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.visionStreams[0].provider, 'p-vision')
  assert.equal(calls.visionStreams[0].model, 'v1')
})

test('extra-A cache key uses resolved target: same session+attachment hits cache', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p-vision', name: 'Vision' }],
    models: { 'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }] },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  const request = () => imageRequest('s-cache', 'sha256:cache-att')
  await drain(adapters.get(WRAPPER).stream(request()))
  const visionAfter1 = calls.visionStreams.length
  await drain(adapters.get(WRAPPER).stream(request()))

  assert.equal(visionAfter1, 1)
  assert.equal(calls.visionStreams.length, visionAfter1)
  assert.equal(calls.upstreamStreams.length, 2)
})

test('extra-B concurrent first discovery: single-flight, one listProviders call', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p-vision', name: 'Vision' }],
    models: { 'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }] },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  // Defer the async catalog step so discovery stays in-flight across both
  // concurrent requests (listProviders is synchronous in the real runtime, so
  // the deferral point is the async listModels step).
  let release
  const gate = new Promise((resolveGate) => { release = resolveGate })
  const realListModels = ctx.llm.listModels
  ctx.llm.listModels = async (provider) => {
    await gate
    return realListModels(provider)
  }

  const first = drain(adapters.get(WRAPPER).stream(imageRequest('s-b1', 'sha256:b1')))
  const second = drain(adapters.get(WRAPPER).stream(imageRequest('s-b2', 'sha256:b2')))
  release()
  await Promise.all([first, second])

  assert.equal(calls.listProviders.length, 1)
  assert.equal(calls.listModels.length, 1)
  assert.equal(calls.visionStreams.length, 2)
  assert.equal(calls.visionStreams[0].provider, calls.visionStreams[1].provider)
  assert.equal(calls.visionStreams[0].model, calls.visionStreams[1].model)
})

test('extra-C secondary confirmation rejects: non-image resolution drops the candidate', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p', name: 'P' }],
    models: { 'p': [{ id: 'v', name: 'V', inputModalities: ['text', 'image'] }] },
    // listModels says image; exact-model metadata says text-only -> dropped.
    resolve: { 'p/v': { provider: 'p', id: 'v', name: 'V', inputModalities: ['text'] } },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await assert.rejects(
    drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:extra-c'))),
    /no image-capable model/,
  )
  assert.equal(calls.visionStreams.length, 0)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('extra-D listModels provider failure: fail closed naming the provider', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [
      { id: 'p-broken', name: 'Broken' },
      { id: 'p-good', name: 'Good' },
    ],
    models: { 'p-good': [{ id: 'v', name: 'V', inputModalities: ['text', 'image'] }] },
  })
  const realListModels = ctx.llm.listModels
  ctx.llm.listModels = async (provider) => {
    if (provider === 'p-broken') throw new Error('catalog down')
    return realListModels(provider)
  }
  apply(ctx, { upstreamProvider: UPSTREAM })
  await assert.rejects(
    drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:extra-d'))),
    /cannot enumerate models for provider "p-broken"/,
  )
  assert.equal(calls.visionStreams.length, 0)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('extra-E resolveModelInfo confirmation failure: candidate dropped, fail closed', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p', name: 'P' }],
    models: { 'p': [{ id: 'v', name: 'V', inputModalities: ['text', 'image'] }] },
    resolve: { 'p/v': new Error('resolve boom') },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await assert.rejects(
    drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:extra-e'))),
    /no image-capable model/,
  )
  assert.equal(calls.visionStreams.length, 0)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('extra-F no name heuristic: "vision"-named text-only model is never selected (A11)', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p', name: 'P' }],
    models: {
      'p': [
        // Adversarial naming: a model NAMED like a vision model but declaring
        // text-only input must NOT become a candidate — capability detection
        // is metadata-only (A11, no name heuristic).
        { id: 'vision-1', name: 'Vision Flagship Multimodal', inputModalities: ['text'] },
        { id: 'obscure-xyz', name: 'Obscure', inputModalities: ['text', 'image'] },
      ],
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  await drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:extra-f')))

  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.visionStreams[0].model, 'obscure-xyz')
  assert.deepEqual(calls.confirmations, [{ provider: 'p', model: 'obscure-xyz' }])
})

test('extra-G pin scope is the apply closure: a second apply() re-discovers (A8 lifecycle)', async () => {
  const base = {
    providers: [{ id: 'p-vision', name: 'Vision' }],
    models: { 'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }] },
  }
  // First bridge instance: discovery runs and pins inside ITS apply closure.
  const first = makeCtxAuto(base)
  apply(first.ctx, { upstreamProvider: UPSTREAM })
  await drain(first.adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:extra-g-1')))
  assert.equal(first.calls.listProviders.length, 1)
  assert.equal(first.calls.visionStreams[0].provider, 'p-vision')

  // Second bridge instance (fresh apply — e.g. config reload / fiber rebuild):
  // it must NOT inherit the first instance's pin; discovery runs again.
  const second = makeCtxAuto(base)
  apply(second.ctx, { upstreamProvider: UPSTREAM })
  assert.equal(second.calls.listProviders.length, 0, 'apply() itself never discovers')
  await drain(second.adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:extra-g-2')))
  assert.equal(second.calls.listProviders.length, 1, 'fresh apply discovers independently')
  assert.equal(second.calls.visionStreams[0].provider, 'p-vision')

  // The first instance's pin is untouched by the second instance's discovery.
  await drain(first.adapters.get(WRAPPER).stream(imageRequest('s-g', 'sha256:extra-g-3')))
  assert.equal(first.calls.listProviders.length, 1, 'first instance still pins its own target')
  assert.equal(first.calls.visionStreams.length, 2)
})

test('extra-H upstream provider itself may serve the unique image-capable model (G1)', async () => {
  // One DSH route can serve both a text-only reasoning model and an
  // image-capable Vision model (config contract: upstreamProvider ===
  // visionProvider is ALLOWED). Auto discovery must NOT exclude the upstream
  // provider — only the synthetic wrapper's own providerId is excluded.
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: UPSTREAM, name: 'Dual' }],
    models: {
      [UPSTREAM]: [
        { id: 'text-1', name: 'Text One', inputModalities: ['text'] },
        { id: 'img-1', name: 'Image One', inputModalities: ['text', 'image'] },
      ],
    },
  })
  // Vision target here IS the upstream route: make the mock distinguish a
  // Vision call (request carries an ImageBlock) from the downstream call.
  const realStream = ctx.llm.stream
  ctx.llm.stream = (options) => {
    const hasImage = (options.messages ?? []).some((m) =>
      (m.content ?? []).some((b) => b?.type === 'image'))
    if (options.provider === UPSTREAM && !hasImage) {
      calls.upstreamStreams.push(options)
      return (async function* () {})()
    }
    if (hasImage) {
      calls.visionStreams.push(options)
      return evidenceStream(VALID_EVIDENCE)
    }
    return realStream(options)
  }
  apply(ctx, { upstreamProvider: UPSTREAM })
  await drain(adapters.get(WRAPPER).stream(imageRequest(undefined, 'sha256:extra-h')))

  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.visionStreams[0].provider, UPSTREAM)
  assert.equal(calls.visionStreams[0].model, 'img-1')
  assert.equal(calls.upstreamStreams.length, 1)
  assert.deepEqual(calls.confirmations, [{ provider: UPSTREAM, model: 'img-1' }])
})

test('extra-I abort during discovery fails closed and never reaches downstream (G7)', async () => {
  const { ctx, adapters, calls } = makeCtxAuto({
    providers: [{ id: 'p-vision', name: 'Vision' }],
    models: { 'p-vision': [{ id: 'v1', name: 'V1', inputModalities: ['text', 'image'] }] },
  })
  apply(ctx, { upstreamProvider: UPSTREAM })
  // Defer the async catalog step so discovery is still in flight when the
  // caller aborts; the abort must fail the request, not be disguised as a
  // 0-candidate outcome (M2a).
  let release
  const gate = new Promise((resolveGate) => { release = resolveGate })
  const realListModels = ctx.llm.listModels
  ctx.llm.listModels = async (provider) => {
    await gate
    return realListModels(provider)
  }
  const controller = new AbortController()
  const request = imageRequest(undefined, 'sha256:extra-i')
  request.signal = controller.signal
  const run = drain(adapters.get(WRAPPER).stream(request))
  controller.abort(new Error('caller gave up'))
  release()
  await assert.rejects(run, /caller gave up/)
  assert.equal(calls.visionStreams.length, 0)
  assert.equal(calls.upstreamStreams.length, 0)
})
