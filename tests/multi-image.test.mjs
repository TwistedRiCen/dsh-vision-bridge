// Stage 3A multi-image content-container batch behavior tests (T1-T10).
// The mock context provides llm ONLY — production consumes no other service.
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
  uncertainty: [`uncertain-${marker}`],
})

const imageBlock = (attachmentId) => ({
  type: 'image',
  attachment: { attachmentId, mediaType: 'image/png', width: 32, height: 32, bytes: 2050 },
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

const UP_OK = (async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'UP-OK' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'UP-OK' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})()

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
  const calls = {
    register: [],
    resolveModelInfo: [],
    visionStreams: [],
    upstreamStreams: [],
  }
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
      return UP_OK
    },
  }
  return { ctx: { llm }, calls, adapters }
}

/** Default responder: valid single Evidence for 1 image, valid multi Evidence for 2+. */
function defaultResponder(track) {
  return (options) => {
    const content = options.messages[0].content
    const images = content.filter((b) => b?.type === 'image')
    track?.push({
      count: images.length,
      attachments: images.map((b) => b.attachment.attachmentId),
      blockTypes: content.map((b) => b.type),
    })
    const json = images.length === 1
      ? JSON.stringify(single('FIXTURE-M1'))
      : JSON.stringify({
        images: images.map((_, i) => ({ index: i + 1, ...single(`FIXTURE-M${i + 1}`) })),
        relations: [{ imageIndexes: images.map((_, i) => i + 1), description: 'fixture relation in input order' }],
      })
    return evidenceStream(json)
  }
}

const stream = (adapters, request) => drain(adapters.get(WRAPPER).stream(request))

test('T1 single-image regression: one Vision call, one image, single Evidence, NO anchor', async () => {
  const seen = []
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder(seen) })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const attachment = imageBlock('sha256:a1')
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{ role: 'user', content: [textBlock('what is this'), attachment] }],
  }
  await stream(adapters, request)

  assert.equal(calls.visionStreams.length, 1, 'exactly one Vision call')
  const visionContent = calls.visionStreams[0].messages[0].content
  const visionImages = visionContent.filter((b) => b.type === 'image')
  assert.equal(visionImages.length, 1, 'exactly one ImageBlock in Vision request')
  assert.equal(visionImages[0], attachment, 'same ImageBlock passes through verbatim')
  assert.equal(seen[0].blockTypes.filter((t) => t === 'image').length, 1)

  const wire = calls.upstreamStreams[0].messages[0].content
  assert.equal(calls.upstreamStreams.length, 1)
  assert.ok(!hasImageRecursive(wire), 'downstream zero ImageBlock')
  const texts = wire.filter((b) => b.type === 'text').map((b) => b.text)
  assert.ok(texts.every((t) => !t.includes('[Image')), 'no multi-image anchor on the single-image path')
  assert.equal(texts[0], 'what is this', 'original text preserved in place')
  const evidence = texts.find((t) => t.includes('untrusted observed data'))
  assert.ok(evidence?.includes('FIXTURE-M1'), 'single Evidence marker reaches downstream')
  assert.equal(request.messages[0].content[1].type, 'image', 'durable input untouched')
})

test('T2 two images same user-message run: one batch call, in-place anchors, one Evidence block', async () => {
  const seen = []
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder(seen) })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const imgA = imageBlock('sha256:att-a')
  const imgB = imageBlock('sha256:att-b')
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{
      role: 'user',
      content: [textBlock('text-before'), imgA, textBlock('text-between'), imgB, textBlock('text-after')],
    }],
  }
  await stream(adapters, request)

  assert.equal(calls.visionStreams.length, 1, 'exactly ONE Vision invocation for the run')
  assert.deepEqual(seen[0], {
    count: 2,
    attachments: ['sha256:att-a', 'sha256:att-b'],
    blockTypes: ['text', 'text', 'image', 'text', 'image'],
  }, 'one user message carrying prompt + per-attachment boundary labels + both ImageBlocks, A then B')

  const wire = calls.upstreamStreams[0].messages[0].content
  assert.deepEqual(wire.slice(0, 5), [
    textBlock('text-before'),
    textBlock('[Image 1]'),
    textBlock('text-between'),
    textBlock('[Image 2]'),
    textBlock('text-after'),
  ], 'anchors replace images IN PLACE, text order preserved')
  const evidence = wire[5]
  assert.equal(evidence.type, 'text', 'exactly one appended batch Evidence block')
  assert.ok(evidence.text.includes('untrusted observed data'))
  assert.ok(evidence.text.includes('Image 1:'))
  assert.ok(evidence.text.includes('FIXTURE-M1'))
  assert.ok(evidence.text.includes('Image 2:'))
  assert.ok(evidence.text.includes('FIXTURE-M2'))
  assert.ok(evidence.text.includes('Cross-image relations:'))
  assert.ok(evidence.text.includes('- Images 1,2: fixture relation in input order'))
  assert.ok(!hasImageRecursive(wire), 'downstream zero ImageBlock')
})

test('T3 reversed A/B: Vision input and anchors follow the new traversal order', async () => {
  const seen = []
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder(seen) })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const imgB = imageBlock('sha256:att-b')
  const imgA = imageBlock('sha256:att-a')
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{ role: 'user', content: [imgB, imgA] }],
  }
  await stream(adapters, request)

  assert.deepEqual(seen[0].attachments, ['sha256:att-b', 'sha256:att-a'], 'Vision receives B then A')
  const wire = calls.upstreamStreams[0].messages[0].content
  assert.deepEqual(wire[0], textBlock('[Image 1]'), 'first image (B) anchors as Image 1')
  assert.deepEqual(wire[1], textBlock('[Image 2]'), 'second image (A) anchors as Image 2')
  assert.ok(wire[2].text.includes('Image 1:'))
  assert.ok(wire[2].text.includes('Image 2:'))
  // no cache implementation: order-semantic identity is asserted at the contract level only.
})

test('T4 tool-result mixed content: one tool-result-local batch, outer block preserved', async () => {
  const seen = []
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder(seen) })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call_1',
        isError: false,
        content: [textBlock('text A'), imageBlock('sha256:att-a'), textBlock('text B'), imageBlock('sha256:att-b')],
      }],
    }],
  }
  await stream(adapters, request)

  assert.equal(calls.visionStreams.length, 1, 'one batch inside the tool-result')
  assert.equal(seen[0].count, 2)
  const wire = calls.upstreamStreams[0].messages[0].content
  const outer = wire[0]
  assert.equal(outer.type, 'tool-result')
  assert.equal(outer.toolCallId, 'call_1')
  assert.equal(outer.isError, false)
  assert.deepEqual(outer.content.slice(0, 4), [
    textBlock('text A'),
    textBlock('[Image 1]'),
    textBlock('text B'),
    textBlock('[Image 2]'),
  ])
  assert.ok(outer.content[4].type === 'text' && outer.content[4].text.includes('untrusted observed data'))
  assert.ok(!hasImageRecursive(wire), 'zero ImageBlock downstream')
  assert.equal(request.messages[0].content[0].content[1].type, 'image', 'durable tool-result untouched')
})

test('T4b nested tool-result boundaries never merge (outer run, nested run, sibling run separate)', async () => {
  const seen = []
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder(seen) })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{
      role: 'user',
      content: [
        imageBlock('sha256:top'),
        {
          type: 'tool-result',
          toolCallId: 'call_nested',
          content: [imageBlock('sha256:nested')],
        },
        imageBlock('sha256:sibling'),
      ],
    }],
  }
  await stream(adapters, request)

  assert.equal(calls.visionStreams.length, 3, 'three separate work units, never merged')
  assert.deepEqual(seen.map((s) => s.count), [1, 1, 1])
  const wire = calls.upstreamStreams[0].messages[0].content
  assert.equal(wire.length, 3, 'outer structure preserved')
  assert.equal(wire[1].type, 'tool-result')
  assert.ok(!hasImageRecursive(wire))
})

test('T5 images in two separate historical messages: independent sequential calls, never merged', async () => {
  const seen = []
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder(seen) })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [
      { role: 'user', content: [textBlock('turn 1'), imageBlock('sha256:att-a')] },
      { role: 'user', content: [textBlock('turn 2'), imageBlock('sha256:att-b')] },
    ],
  }
  await stream(adapters, request)

  assert.equal(calls.visionStreams.length, 2, 'two separate Vision calls in message order')
  assert.deepEqual(seen.map((s) => s.attachments), [['sha256:att-a'], ['sha256:att-b']], 'never one merged call')
  assert.equal(calls.resolveModelInfo.filter((c) => c.provider === VISION).length, 1, 'vision route resolved once per request (memoized)')
  const wire = calls.upstreamStreams[0].messages
  assert.ok(wire[0].content.some((b) => b.text?.includes('FIXTURE-M1')), 'evidence inside message 1')
  assert.ok(wire[1].content.some((b) => b.text?.includes('FIXTURE-M1')), 'evidence inside message 2')
  assert.ok(!hasImageRecursive(wire.flatMap((m) => m.content)))
})

test('T6 atomic failure: invalid multi Evidence -> fail closed, downstream invocation = 0, no partial output', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: (options) => {
      const images = options.messages[0].content.filter((b) => b?.type === 'image')
      return images.length >= 2
        ? evidenceStream(JSON.stringify({ images: [{ index: 1, ...single('M1') }], relations: [] })) // wrong length
        : evidenceStream(JSON.stringify(single('M1')))
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [
      { role: 'user', content: [imageBlock('sha256:first-ok')] },
      { role: 'user', content: [imageBlock('sha256:att-a'), imageBlock('sha256:att-b')] },
    ],
  }
  await assert.rejects(stream(adapters, request), /failed validation/)
  assert.equal(calls.upstreamStreams.length, 0, 'downstream invocation = 0 even though the first work unit succeeded')
})

test('T6b atomic failure: terminal error finish from Vision -> downstream invocation = 0', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: (options) => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'vision route down', code: 'DOWN' } } }
    })(),
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{ role: 'user', content: [imageBlock('sha256:att-a'), imageBlock('sha256:att-b')] }],
  }
  await assert.rejects(stream(adapters, request), /vision stream error/)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('T7 cancellation mid-batch: whole batch aborted, no later work unit starts, downstream = 0', async () => {
  const controller = new AbortController()
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: (options) => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      controller.abort(new Error('mid cancel'))
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [
      { role: 'user', content: [imageBlock('sha256:att-a'), imageBlock('sha256:att-b')] },
      { role: 'user', content: [imageBlock('sha256:att-c')] },
    ],
    signal: controller.signal,
  }
  await assert.rejects(stream(adapters, request), /mid cancel/)
  assert.equal(calls.visionStreams.length, 1, 'no later work unit starts after cancellation')
  assert.equal(calls.upstreamStreams.length, 0)
})

test('T8 recursive downstream scan: zero ImageBlock at every nesting depth after success', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder() })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{
      role: 'user',
      content: [
        textBlock('top'),
        imageBlock('sha256:top-1'),
        imageBlock('sha256:top-2'),
        {
          type: 'tool-result',
          toolCallId: 'outer',
          content: [
            imageBlock('sha256:outer-1'),
            {
              type: 'tool-result',
              toolCallId: 'inner',
              content: [textBlock('deep'), imageBlock('sha256:inner-1')],
            },
          ],
        },
      ],
    }],
  }
  await stream(adapters, request)
  const wire = calls.upstreamStreams[0].messages[0].content
  assert.ok(!hasImageRecursive(wire), 'zero ImageBlock at every nesting depth')
  assert.ok(wire.some((b) => b.text?.includes('[Image 1]')), 'top-level anchors present')
})

test('T9 durable/source immutability: original messages deep-equal after success AND after failure', async () => {
  const successCtx = makeCtx({ visionResponder: defaultResponder() })
  apply(successCtx.ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const okRequest = {
    provider: WRAPPER, model: 't1',
    messages: [{ role: 'user', content: [textBlock('keep'), imageBlock('sha256:att-a'), imageBlock('sha256:att-b')] }],
  }
  const okSnapshot = JSON.parse(JSON.stringify(okRequest))
  await stream(successCtx.adapters, okRequest)
  assert.deepEqual(okRequest, okSnapshot, 'durable input unchanged after success')

  const failCtx = makeCtx({
    visionResponder: () => evidenceStream(JSON.stringify({ images: [{ index: 1, ...single('M1') }], relations: [] })),
  })
  apply(failCtx.ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const failRequest = {
    provider: WRAPPER, model: 't1',
    messages: [{ role: 'user', content: [textBlock('keep'), imageBlock('sha256:att-a'), imageBlock('sha256:att-b')] }],
  }
  const failSnapshot = JSON.parse(JSON.stringify(failRequest))
  await assert.rejects(stream(failCtx.adapters, failRequest), /failed validation/)
  assert.deepEqual(failRequest, failSnapshot, 'durable input unchanged after failure')
})

test('T10 deterministic cross-image relation: one call receives A+B, relation reaches downstream', async () => {
  const seen = []
  const { ctx, calls, adapters } = makeCtx({ visionResponder: defaultResponder(seen) })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{
      role: 'user',
      content: [imageBlock('sha256:att-a'), imageBlock('sha256:att-b')],
    }],
  }
  await stream(adapters, request)
  assert.equal(calls.visionStreams.length, 1)
  assert.deepEqual(seen[0].attachments, ['sha256:att-a', 'sha256:att-b'])
  const evidence = calls.upstreamStreams[0].messages[0].content.at(-1)
  assert.ok(evidence.text.includes('Images 1,2: fixture relation in input order'), 'relation rendered downstream')
})

test('sequential work-unit behavior: serial in traversal order, no overlap, no Promise.all', async () => {
  let active = 0
  let maxActive = 0
  const order = []
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: (options) => {
      const images = options.messages[0].content.filter((b) => b?.type === 'image')
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(images.map((b) => b.attachment.attachmentId))
      return (async function* () {
        const json = images.length === 1
          ? JSON.stringify(single('FIXTURE-M1'))
          : JSON.stringify({
            images: images.map((_, i) => ({ index: i + 1, ...single(`FIXTURE-M${i + 1}`) })),
            relations: [],
          })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: json }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: json } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        active -= 1
      })()
    },
  })
  apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [
      { role: 'user', content: [imageBlock('sha256:w1')] },
      { role: 'user', content: [imageBlock('sha256:w2-a'), imageBlock('sha256:w2-b')] },
      { role: 'user', content: [imageBlock('sha256:w3')] },
    ],
  }
  await stream(adapters, request)
  assert.deepEqual(order, [['sha256:w1'], ['sha256:w2-a', 'sha256:w2-b'], ['sha256:w3']], 'traversal order')
  assert.equal(maxActive, 1, 'never more than one Vision call in flight — serial by construction')
  assert.equal(calls.upstreamStreams.length, 1)
})
