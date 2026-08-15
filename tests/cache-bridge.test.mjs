// Stage 3B bridge-level cache behavior tests (C1-C21 + concurrency).
// The mock context provides llm ONLY; requests carry DSH GenerateOptions
// sessionId where cache participation is expected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../dist/index.js'

const UPSTREAM = 'upstream-text'
const VISION = 'vision-route'
const VISION_MODEL = 'vision-1'
const WRAPPER = `${UPSTREAM}-vision-bridge`

const single = (marker) => ({
  summary: `${marker} summary`,
  ocr: { full_text: `${marker}-OCR`, lines: [{ text: `${marker}-OCR` }] },
  layout: { regions: [{ type: 'paragraph', reading_order: 1, text: marker }] },
  semantics: { scene: 'scene', entities: [{ name: marker, type: 'fixture' }] },
  visual: {},
  uncertainty: [],
})

const imageBlock = (attachmentId) => ({
  type: 'image',
  attachment: { attachmentId, mediaType: 'image/png', width: 16, height: 16, bytes: 100 },
})

const textBlock = (text) => ({ type: 'text', text })

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

function hasImageRecursive(blocks) {
  return blocks.some(
    (b) => b?.type === 'image'
      || (b?.type === 'tool-result' && hasImageRecursive(b.content)),
  )
}

function makeCtx({ visionResponder } = {}) {
  const calls = { register: [], resolveModelInfo: [], visionStreams: [], upstreamStreams: [] }
  const adapters = new Map()
  const llm = {
    registerAdapter(ids, adapter) {
      calls.register.push(ids)
      for (const id of ids) adapters.set(id, adapter)
      return () => {}
    },
    listModels: async () => { throw new Error('route unavailable') },
    resolveModelInfo: async (provider, model) => {
      calls.resolveModelInfo.push({ provider, model })
      return { provider, id: model, name: model, inputModalities: provider === VISION ? ['text', 'image'] : ['text'] }
    },
    stream: (options) => {
      if (options.provider === VISION) {
        calls.visionStreams.push(options)
        return visionResponder(options)
      }
      calls.upstreamStreams.push(options)
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'UP-OK' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'UP-OK' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { ctx: { llm }, calls, adapters }
}

const defaultResponder = (options) => {
  const images = options.messages[0].content.filter((b) => b?.type === 'image')
  const json = images.length === 1
    ? JSON.stringify(single('FIXTURE-M1'))
    : JSON.stringify({
      images: images.map((_, i) => ({ index: i + 1, ...single(`FIXTURE-M${i + 1}`) })),
      relations: [],
    })
  return evidenceStream(json)
}

const stream = (adapters, request) => drain(adapters.get(WRAPPER).stream(request))

const request = (sessionId, messages) => ({
  provider: WRAPPER,
  model: 't1',
  ...(sessionId === undefined ? {} : { sessionId }),
  messages,
})

test('C1/C2: single-image eligible MISS inserts; same session hits with zero extra Vision calls', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [textBlock('what is this'), imageBlock('att-1')] }]
  await stream(adapters, request('sess-1', messages))
  assert.equal(calls.visionStreams.length, 1, 'C1: one Vision call on miss')
  assert.equal(calls.upstreamStreams.length, 1)
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.visionStreams.length, 1, 'C2: HIT — zero additional Vision calls')
  assert.equal(calls.upstreamStreams.length, 2, 'downstream invoked again')
  const wire = calls.upstreamStreams.at(-1).messages[0].content
  assert.ok(wire.some((b) => b.text?.includes('FIXTURE-M1')), 'hit renders the cached canonical Evidence')
})

test('C3/C4: multi [A,B] MISS then same-session HIT', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock('att-a'), imageBlock('att-b')] }]
  await stream(adapters, request('sess-1', messages))
  assert.equal(calls.visionStreams.length, 1, 'C3: one batch Vision call on miss')
  assert.equal(calls.visionStreams[0].messages[0].content.filter((b) => b.type === 'image').length, 2)
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.visionStreams.length, 1, 'C4: HIT')
  assert.equal(calls.upstreamStreams.length, 2)
})

test('C5: [B,A] order is a different key -> MISS', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  await stream(adapters, request('sess-1', [{ role: 'user', content: [imageBlock('att-a'), imageBlock('att-b')] }]))
  await stream(adapters, request('sess-1', [{ role: 'user', content: [imageBlock('att-b'), imageBlock('att-a')] }]))
  assert.equal(calls.visionStreams.length, 2, 'reversed order misses')
  assert.deepEqual(
    calls.visionStreams[1].messages[0].content.filter((b) => b.type === 'image').map((b) => b.attachment.attachmentId),
    ['att-b', 'att-a'],
    'second Vision call received the reversed order',
  )
})

test('C9: provider/parse/schema failure inserts nothing; next request retries', async () => {
  let attempt = 0
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: (options) => {
      attempt += 1
      return attempt === 1
        ? evidenceStream(JSON.stringify({ summary: 'missing everything' })) // schema failure
        : defaultResponder(options)
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock('att-1')] }]
  await assert.rejects(stream(adapters, request('sess-1', messages)), /failed validation/)
  assert.equal(calls.upstreamStreams.length, 0)
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.visionStreams.length, 2, 'failure was not cached: retry performed a fresh Vision call')
  assert.equal(calls.upstreamStreams.length, 1)
})

test('C10: cancellation inserts nothing; next request retries', async () => {
  const controller = new AbortController()
  let attempt = 0
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: (options) => {
      attempt += 1
      if (attempt === 1) {
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: 'partial' }
          controller.abort(new Error('cancel-first'))
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
      return defaultResponder(options)
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock('att-1')] }]
  const r1 = request('sess-1', messages)
  r1.signal = controller.signal
  await assert.rejects(stream(adapters, r1), /cancel-first/)
  assert.equal(calls.upstreamStreams.length, 0)
  // Same session, fresh signal: the cancelled attempt must not be cached.
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.visionStreams.length, 2, 'cancellation was not cached: retry performed a fresh Vision call')
  assert.equal(calls.upstreamStreams.length, 1)
})

test('C14: identical top-level and tool-result work units share one cache identity (same session)', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  await stream(adapters, request('sess-1', [{ role: 'user', content: [imageBlock('att-1')] }]))
  await stream(adapters, request('sess-1', [{
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'call_1', content: [imageBlock('att-1')] }],
  }]))
  assert.equal(calls.visionStreams.length, 1, 'toolCallId is not part of the identity: same work unit HIT')
  assert.equal(calls.upstreamStreams.length, 2)
})

test('C15: original messages remain deep-equal on HIT and MISS', async () => {
  const { ctx, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [textBlock('keep'), imageBlock('att-1'), imageBlock('att-2')] }]
  const missRequest = request('sess-1', messages)
  const missSnapshot = JSON.parse(JSON.stringify(missRequest))
  await stream(adapters, missRequest)
  assert.deepEqual(missRequest, missSnapshot, 'durable input unchanged on MISS')
  const hitRequest = request('sess-1', JSON.parse(JSON.stringify(messages)))
  const hitSnapshot = JSON.parse(JSON.stringify(hitRequest))
  await stream(adapters, hitRequest)
  assert.deepEqual(hitRequest, hitSnapshot, 'durable input unchanged on HIT')
})

test('C16: downstream recursively zero ImageBlock on HIT and MISS', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock('att-a'), imageBlock('att-b')] }]
  await stream(adapters, request('sess-1', messages))
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  for (const upstreamCall of calls.upstreamStreams) {
    for (const message of upstreamCall.messages) {
      assert.ok(!hasImageRecursive(message.content), 'zero ImageBlocks on every downstream wire')
    }
  }
})

test('C17: cached multi Evidence produces the same sealed anchor/wire semantics', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [textBlock('before'), imageBlock('att-a'), textBlock('between'), imageBlock('att-b'), textBlock('after')] }]
  await stream(adapters, request('sess-1', messages))
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.upstreamStreams.length, 2)
  const missWire = calls.upstreamStreams[0].messages[0].content
  const hitWire = calls.upstreamStreams[1].messages[0].content
  assert.deepEqual(missWire.slice(0, 5), [
    textBlock('before'), textBlock('[Image 1]'), textBlock('between'), textBlock('[Image 2]'), textBlock('after'),
  ])
  assert.deepEqual(hitWire.slice(0, 5), missWire.slice(0, 5), 'anchors identical on HIT')
  assert.equal(hitWire[5].type, 'text')
  assert.ok(hitWire[5].text.includes('untrusted observed data'), 'trust boundary on HIT')
  assert.ok(hitWire[5].text.includes('Image 1:') && hitWire[5].text.includes('Image 2:'))
})

test('C18: tolerated unknown Evidence extras never leak through the renderer on HIT', async () => {
  const responder = (options) => {
    const images = options.messages[0].content.filter((b) => b?.type === 'image')
    const json = images.length === 1
      ? JSON.stringify({ ...single('FIXTURE-M1'), secretExtra: 'SHOULD-NOT-LEAK', nested: { deep: 'ALSO-HIDDEN' } })
      : '{}'
    return evidenceStream(json)
  }
  const { ctx, calls, adapters } = makeCtx({ visionResponder: responder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock('att-1')] }]
  await stream(adapters, request('sess-1', messages))
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  for (const upstreamCall of calls.upstreamStreams) {
    const text = upstreamCall.messages[0].content.map((b) => b.text ?? '').join('\n')
    assert.ok(!text.includes('SHOULD-NOT-LEAK'))
    assert.ok(!text.includes('ALSO-HIDDEN'))
  }
})

test('C19: session partition — identical work unit under a different sessionId MISSES', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock('att-1')] }]
  await stream(adapters, request('sess-1', messages))
  await stream(adapters, request('sess-2', JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.visionStreams.length, 2, 'no cross-session Evidence reuse')
})

test('C20: missing sessionId BYPASSES the cache (repeated Vision work)', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock('att-1')] }]
  await stream(adapters, request(undefined, messages))
  await stream(adapters, request(undefined, JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.visionStreams.length, 2, 'bypass: every request re-analyzes')
})

test('C21: invalid attachmentId BYPASSES the cache but Vision still works', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const badBlock = { type: 'image', attachment: { attachmentId: '', mediaType: 'image/png', width: 16, height: 16, bytes: 100 } }
  const messages = [{ role: 'user', content: [badBlock] }]
  await stream(adapters, request('sess-1', messages))
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.visionStreams.length, 2, 'bypass: no lookup, no insert')
  assert.equal(calls.upstreamStreams.length, 2, 'Vision still succeeded both times')
})

test('concurrent double-miss: 2 Vision calls, first completed insert wins, callers keep OWN results', async () => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()]
  let callIndex = 0
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => {
      const index = callIndex++
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: JSON.stringify(single(index === 0 ? 'MARKER-A' : 'MARKER-B')) }
        await gates[index].promise
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock('att-1')] }]
  const drainA = stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  while (calls.visionStreams.length < 1) await new Promise((r) => setTimeout(r, 5))
  const drainB = stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  while (calls.visionStreams.length < 2) await new Promise((r) => setTimeout(r, 5))
  assert.equal(calls.visionStreams.length, 2, 'both callers missed before either inserted (no single-flight)')
  gates[0].resolve()
  await drainA
  gates[1].resolve()
  await drainB
  const wireA = calls.upstreamStreams[0].messages[0].content.map((b) => b.text ?? '').join('\n')
  const wireB = calls.upstreamStreams[1].messages[0].content.map((b) => b.text ?? '').join('\n')
  assert.ok(wireA.includes('MARKER-A'), 'caller A completed with its OWN validated result')
  assert.ok(wireB.includes('MARKER-B'), 'caller B completed with its OWN validated result (no substitution)')
  // Third caller: HIT the first successful insert (A).
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.visionStreams.length, 2, 'no third Vision call')
  const wireC = calls.upstreamStreams[2].messages[0].content.map((b) => b.text ?? '').join('\n')
  assert.ok(wireC.includes('MARKER-A'), 'cache winner is the first successful completed insert')
  assert.ok(!wireC.includes('MARKER-B'))
})

test('concurrent cancellation: aborting A never reaches B; B inserts; later C hits B', async () => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()]
  let callIndex = 0
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => {
      const index = callIndex++
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: JSON.stringify(single(index === 0 ? 'MARKER-A' : 'MARKER-B')) }
        await gates[index].promise
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '{}' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const messages = [{ role: 'user', content: [imageBlock('att-1')] }]
  const controllerA = new AbortController()
  const reqA = request('sess-1', JSON.parse(JSON.stringify(messages)))
  reqA.signal = controllerA.signal
  const drainA = stream(adapters, reqA).catch((e) => e)
  while (calls.visionStreams.length < 1) await new Promise((r) => setTimeout(r, 5))
  const drainB = stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  while (calls.visionStreams.length < 2) await new Promise((r) => setTimeout(r, 5))
  controllerA.abort(new Error('cancel-A-only'))
  gates[0].resolve()
  gates[1].resolve()
  const outcomeA = await drainA
  assert.ok(outcomeA instanceof Error && /cancel-A-only/.test(String(outcomeA.message)), 'A failed per cancellation semantics')
  await drainB
  assert.equal(calls.visionStreams.length, 2, 'exactly 2 Vision calls (no shared work, no retry)')
  const wireB = calls.upstreamStreams.at(-1).messages[0].content.map((b) => b.text ?? '').join('\n')
  assert.ok(wireB.includes('MARKER-B'), 'B completed independently and inserted')
  await stream(adapters, request('sess-1', JSON.parse(JSON.stringify(messages))))
  assert.equal(calls.visionStreams.length, 2)
  const wireC = calls.upstreamStreams.at(-1).messages[0].content.map((b) => b.text ?? '').join('\n')
  assert.ok(wireC.includes('MARKER-B'), 'later caller HITs B')
})
