// v0.2.3 candidate: multi-image anti-merge request-construction regressions.
// Deterministic mock-ctx tests — no provider. Locks the per-attachment
// boundary labels ("Image i of N:") interleaved with the ImageBlocks of the
// multi Vision request, the strict cardinality validator behavior for the
// captured real merge class (N=2 input, ONE merged images[] entry), and the
// 2-attempt retry cap. Also locks the single-image path as label-free.
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

const multiValid = (marker, n) => ({
  images: Array.from({ length: n }, (_, i) => ({ index: i + 1, ...single(`${marker}-${i + 1}`) })),
  relations: n >= 2
    ? [{ imageIndexes: Array.from({ length: n }, (_, i) => i + 1), description: `${marker} relation` }]
    : [],
})

/** Structural mirror of the captured real merge failure: ONE entry for N>=2. */
const mergedEntry = (marker) => ({ images: [{ index: 1, ...single(`${marker}-merged`) }], relations: [] })

const imageBlock = (attachmentId) => ({
  type: 'image',
  attachment: { attachmentId, mediaType: 'image/png', width: 16, height: 16, bytes: 100 },
})

const textBlock = (text) => ({ type: 'text', text })

const chunksOf = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const UP_OK = (async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'UP-OK' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'UP-OK' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})()

async function drain(iterable) {
  for await (const _ of iterable) { /* drain */ }
}

function makeCtx({ visionResponder } = {}) {
  const calls = { visionStreams: [], upstreamStreams: [] }
  const adapters = new Map()
  const llm = {
    registerAdapter(ids, adapter) {
      for (const id of ids) adapters.set(id, adapter)
      return () => {}
    },
    listModels: async () => { throw new Error('route unavailable') },
    resolveModelInfo: async (provider, model) => {
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

function queueResponder(scripts) {
  let call = 0
  return () => {
    const script = scripts[Math.min(call, scripts.length - 1)]
    call += 1
    return (async function* () { for (const chunk of script) yield chunk })()
  }
}

const stream = (adapters, request) => drain(adapters.get(WRAPPER).stream(request))
const applyBridge = (ctx) => apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })

const visionImages = (options) => options.messages[0].content.filter((b) => b.type === 'image')

test('L1 two images: ONE Vision call carries prompt + boundary labels + BOTH ImageBlocks in order', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(JSON.stringify(multiValid('L1', 2)))]),
  })
  applyBridge(ctx)
  const imgA = imageBlock('sha256:att-a')
  const imgB = imageBlock('sha256:att-b')
  await stream(adapters, {
    provider: WRAPPER,
    model: 't1',
    messages: [{ role: 'user', content: [imgA, imgB] }],
  })

  assert.equal(calls.visionStreams.length, 1, 'exactly one Vision call')
  const content = calls.visionStreams[0].messages[0].content
  assert.equal(content.length, 5, 'prompt + 2 labels + 2 images')
  assert.equal(content[0].type, 'text', 'prompt text first')
  assert.equal(content[1].type, 'text')
  assert.equal(content[1].text, 'Image 1 of 2:', 'attachment 1 boundary label')
  assert.equal(content[2], imgA, 'image A passes through verbatim after label 1')
  assert.equal(content[3].type, 'text')
  assert.equal(content[3].text, 'Image 2 of 2:', 'attachment 2 boundary label')
  assert.equal(content[4], imgB, 'image B passes through verbatim after label 2')
  assert.equal(calls.visionStreams[0].temperature, 0, 'multi temperature stays 0')
  assert.equal(calls.upstreamStreams.length, 1, 'downstream once after success')
})

test('L2 three images: labels Image 1..3 of 3, valid Evidence requires indexes [1,2,3]', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(JSON.stringify(multiValid('L2', 3)))]),
  })
  applyBridge(ctx)
  const imgA = imageBlock('sha256:att-a')
  const imgB = imageBlock('sha256:att-b')
  const imgC = imageBlock('sha256:att-c')
  await stream(adapters, {
    provider: WRAPPER,
    model: 't1',
    messages: [{ role: 'user', content: [imgA, imgB, imgC] }],
  })

  assert.equal(calls.visionStreams.length, 1)
  const content = calls.visionStreams[0].messages[0].content
  assert.deepEqual(content.map((b) => b.type), ['text', 'text', 'image', 'text', 'image', 'text', 'image'])
  assert.equal(content[1].text, 'Image 1 of 3:')
  assert.equal(content[2], imgA)
  assert.equal(content[3].text, 'Image 2 of 3:')
  assert.equal(content[4], imgB)
  assert.equal(content[5].text, 'Image 3 of 3:')
  assert.equal(content[6], imgC)
  assert.deepEqual(visionImages(calls.visionStreams[0]).map((b) => b.attachment.attachmentId), ['sha256:att-a', 'sha256:att-b', 'sha256:att-c'], 'order preserved')

  const wire = calls.upstreamStreams[0].messages[0].content
  assert.deepEqual(wire.slice(0, 3), [textBlock('[Image 1]'), textBlock('[Image 2]'), textBlock('[Image 3]')], 'three in-place anchors')
  const evidence = wire[3].text
  assert.ok(evidence.includes('Image 1:') && evidence.includes('Image 2:') && evidence.includes('Image 3:'), 'three evidence entries rendered')
  assert.ok(evidence.includes('L2-1') && evidence.includes('L2-2') && evidence.includes('L2-3'))
  assert.ok(evidence.includes('Images 1,2,3:'), 'three-image relation rendered')
})

test('L3 two images, reversed order: labels and blocks follow the traversal order', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(JSON.stringify(multiValid('L3', 2)))]),
  })
  applyBridge(ctx)
  const imgB = imageBlock('sha256:att-b')
  const imgA = imageBlock('sha256:att-a')
  await stream(adapters, {
    provider: WRAPPER,
    model: 't1',
    messages: [{ role: 'user', content: [imgB, imgA] }],
  })
  const content = calls.visionStreams[0].messages[0].content
  assert.equal(content[1].text, 'Image 1 of 2:')
  assert.equal(content[2], imgB, 'first input anchors as Image 1')
  assert.equal(content[3].text, 'Image 2 of 2:')
  assert.equal(content[4], imgA, 'second input anchors as Image 2')
})

test('L4 single-image regression: NO boundary labels on the single-image Vision request', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(JSON.stringify(single('L4-OK')))]),
  })
  applyBridge(ctx)
  const img = imageBlock('sha256:att-single')
  await stream(adapters, {
    provider: WRAPPER,
    model: 't1',
    messages: [{ role: 'user', content: [textBlock('what is this'), img] }],
  })
  assert.equal(calls.visionStreams.length, 1)
  const content = calls.visionStreams[0].messages[0].content
  assert.deepEqual(content.map((b) => b.type), ['text', 'image'], 'prompt text + single image, no labels')
  assert.ok(content.every((b) => b.type !== 'text' || !b.text.includes('of 1:')), 'no boundary label text on the single path')
  assert.equal('temperature' in calls.visionStreams[0], false, 'single-image temperature policy unchanged')
})

test('L5 exact real merge class: attempt1 merged entry (N=2) + attempt2 merged entry -> validation exhausted, exact message, downstream 0, no attempt 3', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('L5-A'))),
      chunksOf(JSON.stringify(mergedEntry('L5-B'))),
      chunksOf(JSON.stringify(multiValid('L5-SPARE', 2))), // must never run
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(
    stream(adapters, {
      provider: WRAPPER,
      model: 't1',
      messages: [{ role: 'user', content: [imageBlock('att-a'), imageBlock('att-b')] }],
    }),
    (error) => {
      assert.equal(
        error.message,
        '[dsh-vision-bridge] vision evidence failed validation (retry exhausted): images.length (expected 2, got 1)',
        'the exact real-world failure message',
      )
      return true
    },
  )
  assert.equal(calls.visionStreams.length, 2, 'exactly 2 attempts, never a third')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream 0')
})

test('L6 attempt1 merged entry + attempt2 valid -> success, exactly 2 calls, both attempts carry identical labeled construction', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('L6-JUNK'))),
      chunksOf(JSON.stringify(multiValid('L6', 2))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, {
    provider: WRAPPER,
    model: 't1',
    messages: [{ role: 'user', content: [imageBlock('att-a'), imageBlock('att-b')] }],
  })
  assert.equal(calls.visionStreams.length, 2)
  assert.deepEqual(calls.visionStreams[1].messages, calls.visionStreams[0].messages, 'attempt 2 request byte-identical (same prompt, same labels, same images, same order)')
  const content = calls.visionStreams[1].messages[0].content
  assert.deepEqual(content.map((b) => b.type), ['text', 'text', 'image', 'text', 'image'])
  assert.equal(content[1].text, 'Image 1 of 2:')
  assert.equal(content[3].text, 'Image 2 of 2:')
  const allText = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(!allText.includes('L6-JUNK'), 'merged attempt-1 output never fed back')
  assert.equal(calls.upstreamStreams.length, 1, 'downstream exactly once after retry success')
  assert.ok(calls.upstreamStreams[0].messages[0].content.at(-1).text.includes('L6-2'), 'attempt-2 Evidence downstream')
})

test('L7 three images, merged entry (1 of 3) twice -> exact three-image failure message, no attempt 3', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('L7-A'))),
      chunksOf(JSON.stringify(mergedEntry('L7-B'))),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(
    stream(adapters, {
      provider: WRAPPER,
      model: 't1',
      messages: [{ role: 'user', content: [imageBlock('att-a'), imageBlock('att-b'), imageBlock('att-c')] }],
    }),
    (error) => {
      assert.equal(
        error.message,
        '[dsh-vision-bridge] vision evidence failed validation (retry exhausted): images.length (expected 3, got 1)',
        'three-image cardinality stays strict',
      )
      return true
    },
  )
  assert.equal(calls.visionStreams.length, 2, 'no attempt 3 for N=3')
  assert.equal(calls.upstreamStreams.length, 0)
})
