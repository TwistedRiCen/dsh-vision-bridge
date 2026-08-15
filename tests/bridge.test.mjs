// Stage 1 bridge behavior tests: wrapper registration, catalog filtering,
// resolveModel fail-closed, conversions, failure/cancellation semantics.
// The mock context provides llm ONLY — proving the production path consumes
// no other DSH service (and never reads raw image bytes).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, collectChunks, EVIDENCE_BOUNDARY } from '../dist/index.js'

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
const VISION = 'vision-route'
const VISION_MODEL = 'vision-1'
const WRAPPER = `${UPSTREAM}-vision-bridge`

function makeCtx() {
  const calls = { register: [], listModels: [], resolveModelInfo: [], streams: [] }
  const adapters = new Map()
  const llm = {
    registerAdapter(ids, adapter) {
      calls.register.push(ids)
      for (const id of ids) adapters.set(id, adapter)
      return () => {}
    },
    listModels: async (provider) => {
      calls.listModels.push(provider)
      throw new Error('route unavailable')
    },
    resolveModelInfo: async (provider, model) => {
      calls.resolveModelInfo.push({ provider, model })
      throw new Error('unresolvable')
    },
    stream: async function* (options) {
      calls.streams.push(options)
    },
  }
  return { ctx: { llm }, calls, adapters }
}

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

const imageBlock = (attachmentId = 'sha256:att-1') => ({ type: 'image', attachment: { attachmentId, mediaType: 'image/png', width: 32, height: 32, bytes: 2050 } })

test('apply registers the synthetic adapter with the derived provider id', () => {
  const { ctx, calls } = makeCtx()
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  assert.deepEqual(calls.register, [[WRAPPER]])
})

test('listModels: upstream route unavailable -> diagnostic, empty catalog, NO throw (discovery path)', async () => {
  const { ctx, adapters } = makeCtx()
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const models = await adapters.get(WRAPPER).listModels(WRAPPER)
  assert.deepEqual(models, [])
})

test('listModels filtering: text-only exposed; image-capable, unknown, and empty-modality omitted', async () => {
  const { ctx, adapters } = makeCtx()
  ctx.llm.listModels = async () => [
    { provider: UPSTREAM, id: 't1', name: 'Text One', inputModalities: ['text'] },
    { provider: UPSTREAM, id: 'v1', name: 'Native Vision', inputModalities: ['text', 'image'] },
    { provider: UPSTREAM, id: 'u1', name: 'Unknown' },
    { provider: UPSTREAM, id: 'e1', name: 'Empty', inputModalities: [] },
  ]
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const models = await adapters.get(WRAPPER).listModels(WRAPPER)
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 't1')
  assert.equal(models[0].provider, WRAPPER)
  assert.equal(models[0].name, 'Text One (vision bridge)')
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
})

test('resolveModel: upstream unresolvable -> fail closed with explicit error', async () => {
  const { ctx, adapters } = makeCtx()
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  await assert.rejects(adapters.get(WRAPPER).resolveModel(WRAPPER, 'm'), /cannot resolve model "m"/)
})

test('resolveModel: image-capable or unknown upstream model -> fail closed', async () => {
  const { ctx, adapters } = makeCtx()
  ctx.llm.resolveModelInfo = async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text', 'image'] })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  await assert.rejects(adapters.get(WRAPPER).resolveModel(WRAPPER, 'm'), /not positively-confirmed text-only/)

  ctx.llm.resolveModelInfo = async (p, m) => ({ provider: p, id: m, name: m })
  await assert.rejects(adapters.get(WRAPPER).resolveModel(WRAPPER, 'm'), /not positively-confirmed text-only/)
})

test('resolveModel: positively-confirmed text-only wraps and preserves context', async () => {
  const { ctx, adapters } = makeCtx()
  ctx.llm.resolveModelInfo = async (p, m) => ({
    provider: p,
    id: m,
    name: 'Text One',
    inputModalities: ['text'],
    context: { contextWindow: 64000 },
    reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' },
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const info = await adapters.get(WRAPPER).resolveModel(WRAPPER, 't1')
  assert.equal(info.provider, WRAPPER)
  assert.equal(info.id, 't1')
  assert.equal(info.name, 'Text One (vision bridge)')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assert.equal(info.context.contextWindow, 64000)
  assert.equal(info.reasoning.defaultEffort, 'max')
})

test('top-level image conversion: vision called once, downstream gets evidence text, no ImageBlock, input untouched', async () => {
  const { ctx, adapters, calls } = makeCtx()
  const visionSeen = { blocks: [] }
  ctx.llm.resolveModelInfo = async (p, m) =>
    p === VISION ? { provider: p, id: m, name: m, inputModalities: ['text', 'image'] } : { provider: p, id: m, name: m, inputModalities: ['text'] }
  const seen = []
  ctx.llm.stream = (options) => {
    seen.push({ provider: options.provider, messages: options.messages })
    if (options.provider === VISION) {
      const content = options.messages[0].content
      visionSeen.blocks.push(content.find((b) => b.type === 'image'))
      return evidenceStream(VALID_EVIDENCE)
    }
    return (async function* () {})()
  }
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const attachment = imageBlock('sha256:att-9')
  const request = {
    provider: WRAPPER,
    model: 't1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, attachment] }],
  }
  await drain(adapters.get(WRAPPER).stream(request))

  assert.equal(visionSeen.blocks.length, 1)
  assert.equal(visionSeen.blocks[0], attachment) // the SAME ImageBlock passes through
  const upstreamCalls = seen.filter((s) => s.provider === UPSTREAM)
  assert.equal(upstreamCalls.length, 1, 'downstream invoked exactly once after evidence')
  const converted = upstreamCalls[0].messages[0].content
  assert.ok(!converted.some((b) => b.type === 'image'), 'downstream wire carries zero ImageBlock')
  const text = converted.map((b) => b.text ?? '').join('\n')
  assert.ok(text.includes(EVIDENCE_BOUNDARY), 'evidence marked as untrusted observed data')
  assert.ok(text.includes('HELLO-42'), 'evidence marker reaches downstream')
  assert.equal(request.messages[0].content[1].type, 'image', 'durable input message untouched')
})

test('nested tool-result image conversion recurses into tool-result content', async () => {
  const { ctx, adapters, calls } = makeCtx()
  ctx.llm.resolveModelInfo = async (p, m) =>
    p === VISION ? { provider: p, id: m, name: m, inputModalities: ['text', 'image'] } : { provider: p, id: m, name: m, inputModalities: ['text'] }
  ctx.llm.stream = (options) =>
    options.provider === VISION ? evidenceStream(VALID_EVIDENCE) : (async function* () {})()
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER,
    model: 't1',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            content: [{ type: 'text', text: '<path>shot.png</path>' }, imageBlock('sha256:nested')],
          },
        ],
      },
    ],
  }
  const seen = []
  ctx.llm.stream = (options) => {
    seen.push({ provider: options.provider, messages: options.messages })
    return options.provider === VISION ? evidenceStream(VALID_EVIDENCE) : (async function* () {})()
  }
  await drain(adapters.get(WRAPPER).stream(request))
  const upstreamCall = seen.find((s) => s.provider === UPSTREAM)
  assert.ok(upstreamCall, 'downstream invoked')
  const wire = upstreamCall.messages[0].content
  assert.equal(wire[0].type, 'tool-result')
  assert.ok(!JSON.stringify(wire[0].content).includes('"type":"image"'), 'nested image converted')
  assert.ok(wire[0].content.some((b) => b.text?.includes('HELLO-42')))
  assert.equal(request.messages[0].content[0].content[1].type, 'image', 'durable nested image untouched')
})

test('no-image passthrough: vision route is never consulted or invoked', async () => {
  const { ctx, adapters, calls } = makeCtx()
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'plain question' }] }]
  await drain(adapters.get(WRAPPER).stream({ provider: WRAPPER, model: 't1', messages }))
  const visionResolves = calls.resolveModelInfo.filter((c) => c.provider === VISION)
  assert.equal(visionResolves.length, 0)
  assert.equal(calls.streams.filter((s) => s.provider === VISION).length, 0)
  const upstreamCall = calls.streams.find((s) => s.provider === UPSTREAM)
  assert.deepEqual(upstreamCall.messages, messages)
})

test('vision failure (stream throws) -> explicit failure, downstream invocation count = 0', async () => {
  const { ctx, adapters, calls } = makeCtx()
  ctx.llm.resolveModelInfo = async (p, m) =>
    p === VISION ? { provider: p, id: m, name: m, inputModalities: ['text', 'image'] } : { provider: p, id: m, name: m, inputModalities: ['text'] }
  ctx.llm.stream = (options) => {
    if (options.provider === VISION) {
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        throw new Error('vision route down')
      })()
    }
    return (async function* () {})()
  }
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock()] }]
  await assert.rejects(drain(adapters.get(WRAPPER).stream({ provider: WRAPPER, model: 't1', messages })), /vision route down/)
  assert.equal(calls.streams.filter((s) => s.provider === UPSTREAM).length, 0)
})

test('invalid JSON evidence -> explicit failure, downstream invocation count = 0', async () => {
  const { ctx, adapters, calls } = makeCtx()
  ctx.llm.resolveModelInfo = async (p, m) => ({ provider: p, id: m, name: m, inputModalities: p === VISION ? ['text', 'image'] : ['text'] })
  ctx.llm.stream = (options) => (options.provider === VISION ? evidenceStream('this is not json {') : (async function* () {})())
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock()] }]
  await assert.rejects(drain(adapters.get(WRAPPER).stream({ provider: WRAPPER, model: 't1', messages })), /not valid JSON/)
  assert.equal(calls.streams.filter((s) => s.provider === UPSTREAM).length, 0)
})

test('schema-invalid evidence -> explicit failure, downstream invocation count = 0', async () => {
  const { ctx, adapters, calls } = makeCtx()
  ctx.llm.resolveModelInfo = async (p, m) => ({ provider: p, id: m, name: m, inputModalities: p === VISION ? ['text', 'image'] : ['text'] })
  ctx.llm.stream = (options) => (options.provider === VISION ? evidenceStream({ summary: 'missing everything else' }) : (async function* () {})())
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock()] }]
  await assert.rejects(drain(adapters.get(WRAPPER).stream({ provider: WRAPPER, model: 't1', messages })), /failed validation/)
  assert.equal(calls.streams.filter((s) => s.provider === UPSTREAM).length, 0)
})

test('vision route not image-capable -> fail closed, downstream invocation count = 0', async () => {
  const { ctx, adapters, calls } = makeCtx()
  ctx.llm.resolveModelInfo = async (p, m) => ({ provider: p, id: m, name: m, inputModalities: ['text'] })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock()] }]
  await assert.rejects(drain(adapters.get(WRAPPER).stream({ provider: WRAPPER, model: 't1', messages })), /not positively-confirmed image-capable/)
  assert.equal(calls.streams.filter((s) => s.provider === UPSTREAM).length, 0)
})

test('cancellation (pre-aborted signal) -> downstream invocation count = 0', async () => {
  const { ctx, adapters, calls } = makeCtx()
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const controller = new AbortController()
  controller.abort(new Error('caller cancelled'))
  const messages = [{ role: 'user', content: [imageBlock()] }]
  await assert.rejects(drain(adapters.get(WRAPPER).stream({ provider: WRAPPER, model: 't1', messages, signal: controller.signal })), /caller cancelled/)
  assert.equal(calls.streams.filter((s) => s.provider === UPSTREAM).length, 0)
})

test('cancellation during vision stream -> downstream invocation count = 0', async () => {
  const { ctx, adapters, calls } = makeCtx()
  ctx.llm.resolveModelInfo = async (p, m) => ({ provider: p, id: m, name: m, inputModalities: p === VISION ? ['text', 'image'] : ['text'] })
  const controller = new AbortController()
  ctx.llm.stream = (options) => {
    if (options.provider === VISION) {
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'partial' }
        controller.abort(new Error('mid cancel'))
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
    return (async function* () {})()
  }
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock()] }]
  await assert.rejects(drain(adapters.get(WRAPPER).stream({ provider: WRAPPER, model: 't1', messages, signal: controller.signal })), /mid cancel/)
  assert.equal(calls.streams.filter((s) => s.provider === UPSTREAM).length, 0)
})

test('accumulator is importable and the boundary text is a stable exported constant', async () => {
  const text = await collectChunks(
    (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'x' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  )
  assert.equal(text, 'x')
  assert.ok(EVIDENCE_BOUNDARY.includes('untrusted observed data'))
})
