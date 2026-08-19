// v0.2.1 schema-robustness deterministic tests (S-R1-S-R25 + sequence matrix).
// ONE shared multi output-contract retry budget (MAX_MULTI_ATTEMPTS = 2):
// strict JSON parse failure AND multi Evidence validation failure consume the
// SAME budget; provider/transport/stream failures and caller cancellation
// never retry. All deterministic mock-ctx tests — no provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  buildEvidenceCacheKey,
  EVIDENCE_POLICY_VERSION,
  renderMultiEvidence,
  validateMultiEvidence,
} from '../dist/index.js'

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

const multiValid = (marker, n = 2) => ({
  images: Array.from({ length: n }, (_, i) => ({ index: i + 1, ...single(`${marker}-${i + 1}`) })),
  relations: [{ imageIndexes: Array.from({ length: n }, (_, i) => i + 1), description: `${marker} relation` }],
})

/**
 * S-R3 fixture: the exact STRUCTURAL shape of the captured real gap — two
 * ImageBlock inputs (N=2) but ONE merged images[] entry (index 1) and
 * relations []. Synthetic marker content only; no private OCR text from the
 * real capture is reproduced.
 */
const mergedEntry = (marker) => ({
  images: [{ index: 1, ...single(`${marker}-merged`) }],
  relations: [],
})

const imageBlock = (attachmentId) => ({
  type: 'image',
  attachment: { attachmentId, mediaType: 'image/png', width: 16, height: 16, bytes: 100 },
})

const textBlock = (text) => ({ type: 'text', text })

const twoImageRequest = (sessionId, extra = {}) => ({
  provider: WRAPPER,
  model: 't1',
  ...(sessionId === undefined ? {} : { sessionId }),
  messages: [{ role: 'user', content: [imageBlock('att-a'), imageBlock('att-b')] }],
  ...extra,
})

/** One complete deterministic text reply as a chunk list. */
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

function hasImageRecursive(blocks) {
  return blocks.some(
    (b) => b?.type === 'image'
      || (b?.type === 'tool-result' && hasImageRecursive(b.content)),
  )
}

/**
 * Mock ctx (llm ONLY). Every Vision stream option is recorded verbatim so
 * temperature presence/value, message identity, and image order are
 * observable per attempt.
 */
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
      return UP_OK
    },
  }
  return { ctx: { llm }, calls, adapters }
}

/** Queue one script per Vision invocation (chunk array or function); the last script repeats. */
function queueResponder(scripts) {
  let call = 0
  return (options) => {
    const script = scripts[Math.min(call, scripts.length - 1)]
    call += 1
    return typeof script === 'function'
      ? script(options)
      : (async function* () { for (const chunk of script) yield chunk })()
  }
}

const stream = (adapters, request) => drain(adapters.get(WRAPPER).stream(request))

const applyBridge = (ctx) => apply(ctx, { upstreamProvider: UPSTREAM, visionProvider: VISION, visionModel: VISION_MODEL })

const wireOf = (calls, index = 0) => calls.upstreamStreams[index].messages[0].content
const attachmentsOf = (visionOptions) => visionOptions.messages[0].content.filter((b) => b.type === 'image').map((b) => b.attachment.attachmentId)

const PARSE_EXHAUSTED = /^\[dsh-vision-bridge\] vision output is not valid JSON \(retry exhausted\):/
const VALIDATION_EXHAUSTED = /^\[dsh-vision-bridge\] vision evidence failed validation \(retry exhausted\):/

/* ------------------------------------------------------------------ */
/* S-R1-S-R7: output-contract sequences                                */
/* ------------------------------------------------------------------ */

test('S-R1 [VALID] -> 1 Vision call -> success -> downstream once', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(JSON.stringify(multiValid('SR1')))]) })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 1, 'exactly one Vision call')
  assert.equal(calls.upstreamStreams.length, 1, 'downstream invoked once')
  assert.ok(wireOf(calls).at(-1).text.includes('SR1-1'), 'valid Evidence downstream')
})

test('S-R2 [PARSE_FAIL, VALID] -> exactly 2 Vision calls -> success -> downstream once', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf('sr2 not json {'),
      chunksOf(JSON.stringify(multiValid('SR2'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2, 'exactly one retry')
  assert.equal(calls.upstreamStreams.length, 1, 'downstream exactly once, only after success')
  const wire = wireOf(calls)
  assert.ok(wire.at(-1).text.includes('SR2-1'), 'attempt-2 Evidence downstream')
  assert.ok(!wire.at(-1).text.includes('sr2 not json'), 'attempt-1 junk never downstream')
})

test('S-R3 EXACT REAL GAP FIXTURE: attempt1 merged single entry (N=2, relations []) -> attempt2 valid N=2 -> exactly 2 calls -> success -> downstream once, only attempt-2 Evidence', async () => {
  // Structural mirror of the captured real failure: valid JSON envelope,
  // images.length === 1 for N = 2, relations: [] — no private OCR content.
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('FIRST-MERGED'))),
      chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2, 'exactly 2 calls: one schema-retry')
  assert.equal(calls.upstreamStreams.length, 1, 'downstream exactly once')
  const wire = wireOf(calls)
  const evidenceBlock = wire.at(-1)
  assert.ok(evidenceBlock.text.includes('SECOND-OK-1') && evidenceBlock.text.includes('SECOND-OK-2'), 'canonical N=2 Evidence downstream')
  assert.ok(!evidenceBlock.text.includes('FIRST-MERGED'), 'merged attempt-1 entry discarded, never downstream')
  assert.ok(!hasImageRecursive(wire), 'downstream zero ImageBlock')
})

test('S-R4 [SCHEMA_FAIL, SCHEMA_FAIL] -> exactly 2 calls -> validation-exhausted -> downstream 0', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR4-JUNK-1'))),
      chunksOf(JSON.stringify(mergedEntry('SR4-JUNK-2'))),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, VALIDATION_EXHAUSTED)
    assert.match(error.message, /images\.length/)
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/, 'not a parse classification')
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'exactly 2 attempts, never a third')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream 0')
})

test('S-R5 [SCHEMA_FAIL, PARSE_FAIL] -> exactly 2 calls -> final classification parse-exhausted -> downstream 0', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR5-JUNK'))),
      chunksOf('sr5 not json {'),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED, 'final failure classified by the Attempt-2 kind: parse')
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'exactly 2 attempts, no third')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream 0')
})

test('S-R6 [PARSE_FAIL, SCHEMA_FAIL] -> exactly 2 calls -> final classification validation-exhausted -> downstream 0', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf('sr6 not json {'),
      chunksOf(JSON.stringify(mergedEntry('SR6-JUNK'))),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, VALIDATION_EXHAUSTED, 'final failure classified by the Attempt-2 kind: validation')
    assert.match(error.message, /images\.length/)
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'exactly 2 attempts, no third')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream 0')
})

test('S-R7 [PARSE_FAIL, PARSE_FAIL] -> exactly 2 calls -> parse-exhausted -> downstream 0', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf('sr7 not json {'), chunksOf('sr7 again not json {')]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2)
  assert.equal(calls.upstreamStreams.length, 0)
})

/* ------------------------------------------------------------------ */
/* S-R8-S-R11: non-retryable failure classes                           */
/* ------------------------------------------------------------------ */

test('S-R8 schema failure attempt1 + caller abort before retry -> exactly 1 Vision call -> abort reason propagates -> downstream 0', async () => {
  const controller = new AbortController()
  const { ctx, calls, adapters } = makeCtx({
    // Deterministic boundary: the generator aborts the signal only AFTER the
    // attempt-1 finish chunk is delivered and consumed, so the bridge reaches
    // its between-attempts throwIfAborted with the signal already aborted.
    visionResponder: queueResponder([
      (options) => (async function* () {
        yield* chunksOf(JSON.stringify(mergedEntry('SR8-JUNK')))
        controller.abort(new Error('SR8 abort between attempts'))
      })(),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest(undefined, { signal: controller.signal })), /SR8 abort between attempts/)
  assert.equal(calls.visionStreams.length, 1, 'Attempt 2 never started')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream 0')
})

test('S-R9 [PROVIDER_FAIL] -> exactly 1 call -> no output-contract retry', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'vision route down', code: 'DOWN' } } }
    })(),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/, 'provider error is NOT a parse failure')
    assert.match(error.message, /vision stream error/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1, 'no retry on provider error')
  assert.equal(calls.upstreamStreams.length, 0)
})

test('S-R10 missing finish -> 1 call -> no retry', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial-then-silence' }
    })(),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, /ended without a finish/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('S-R11 tool-call finish -> 1 call -> no retry', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })(),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, /tool-calls/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

/* ------------------------------------------------------------------ */
/* S-R12-S-R14: cache + policy                                        */
/* ------------------------------------------------------------------ */

test('S-R12 schema retry success caches ONLY final validated attempt-2 Evidence', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('FIRST-MERGED'))),
      chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest('sess-sr12'))
  assert.equal(calls.visionStreams.length, 2, 'retry consumed both attempts')
  const wire = wireOf(calls)
  assert.ok(wire.at(-1).text.includes('SECOND-OK'), 'downstream carries the canonical attempt-2 Evidence')
  assert.ok(!wire.at(-1).text.includes('FIRST-MERGED'), 'attempt-1 invalid Evidence absent everywhere')
  // Cache membership is observable only through behavior (the cache is a
  // closure-private Stage-3B detail): S-R13 proves the HIT serves exactly the
  // attempt-2 canonical value and never the discarded attempt-1 value.
})

test('S-R13 later same-session repeat -> cache HIT -> zero additional Vision calls -> attempt-2 canonical Evidence served', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('FIRST-MERGED'))),
      chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest('sess-sr13'))
  assert.equal(calls.visionStreams.length, 2)

  await stream(adapters, twoImageRequest('sess-sr13'))
  assert.equal(calls.visionStreams.length, 2, 'cache HIT: zero additional Vision calls')
  assert.equal(calls.upstreamStreams.length, 2, 'downstream ran again through the same renderer path')
  const hitWire = wireOf(calls, 1)
  assert.ok(hitWire.at(-1).text.includes('SECOND-OK'), 'HIT serves the canonical attempt-2 Evidence')
  assert.ok(!hitWire.at(-1).text.includes('FIRST-MERGED'), 'attempt-1 Evidence was never cached')
})

test('S-R14 policy version 5 participates in the cache key; policy 1/2/3/4/5 pairwise distinct; order semantic', () => {
  assert.equal(EVIDENCE_POLICY_VERSION, 5, 'v0.2.5 candidate single-image U+200B tolerance policy version is 5')
  const base = { sessionId: 's1', visionProvider: 'vp', visionModel: 'vm', orderedAttachmentIds: ['a', 'b'] }
  const official = buildEvidenceCacheKey(base)
  assert.equal(official, JSON.stringify([5, 's1', 'vp', 'vm', ['a', 'b']]), 'key embeds policy version 5')
  assert.notEqual(official, JSON.stringify([1, 's1', 'vp', 'vm', ['a', 'b']]), 'policy-1 keys are distinct')
  assert.notEqual(official, JSON.stringify([2, 's1', 'vp', 'vm', ['a', 'b']]), 'policy-2 keys are distinct')
  assert.notEqual(official, JSON.stringify([3, 's1', 'vp', 'vm', ['a', 'b']]), 'policy-3 keys are distinct')
  assert.notEqual(official, JSON.stringify([4, 's1', 'vp', 'vm', ['a', 'b']]), 'policy-4 keys are distinct')
  assert.notEqual(
    JSON.stringify([1, 's1', 'vp', 'vm', ['a', 'b']]),
    JSON.stringify([2, 's1', 'vp', 'vm', ['a', 'b']]),
    'policy 1 and 2 are also distinct',
  )
  assert.notEqual(
    buildEvidenceCacheKey(base),
    buildEvidenceCacheKey({ ...base, orderedAttachmentIds: ['b', 'a'] }),
    'order remains semantic',
  )
})

/* ------------------------------------------------------------------ */
/* S-R15-S-R19: scope discipline + attempt equivalence                 */
/* ------------------------------------------------------------------ */

test('S-R15 single-image regression: no retry (parse OR schema), no forced temperature', async () => {
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{ role: 'user', content: [imageBlock('att-single')] }],
  }
  // Valid single-image: one call, no temperature override.
  const validCtx = makeCtx({ visionResponder: queueResponder([chunksOf(JSON.stringify(single('SR15-OK')))]) })
  applyBridge(validCtx.ctx)
  await stream(validCtx.adapters, request)
  assert.equal(validCtx.calls.visionStreams.length, 1)
  assert.equal('temperature' in validCtx.calls.visionStreams[0], false, 'single-image Vision gets NO forced temperature')

  // Single-image parse failure: NO retry even with a spare valid script.
  const parseCtx = makeCtx({
    visionResponder: queueResponder([chunksOf('sr15 not json {'), chunksOf(JSON.stringify(single('SR15-SPARE'))) ]),
  })
  applyBridge(parseCtx.ctx)
  await assert.rejects(stream(parseCtx.adapters, request), (error) => {
    assert.match(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON:/)
    assert.doesNotMatch(error.message, /retry exhausted/)
    return true
  })
  assert.equal(parseCtx.calls.visionStreams.length, 1, 'single-image parse failure NEVER retries')

  // Single-image schema failure: NO retry even with a spare valid script.
  const schemaCtx = makeCtx({
    visionResponder: queueResponder([chunksOf(JSON.stringify({ summary: 'missing everything' })), chunksOf(JSON.stringify(single('SR15-SPARE2'))) ]),
  })
  applyBridge(schemaCtx.ctx)
  await assert.rejects(stream(schemaCtx.adapters, request), (error) => {
    assert.match(error.message, /vision evidence failed validation:/)
    assert.doesNotMatch(error.message, /retry exhausted/)
    return true
  })
  assert.equal(schemaCtx.calls.visionStreams.length, 1, 'single-image schema failure NEVER retries')
})

test('S-R16 multi temperature 0 on BOTH attempts through a schema retry', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR16-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SR16'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2)
  for (const options of calls.visionStreams) {
    assert.equal('temperature' in options, true, 'temperature key present')
    assert.equal(options.temperature, 0, 'every multi attempt is temperature 0')
  }
})

test('S-R17 attempt 2 carries identical image refs and identical order', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR17-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SR17'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2)
  assert.deepEqual(attachmentsOf(calls.visionStreams[0]), ['att-a', 'att-b'], 'attempt 1 order')
  assert.deepEqual(attachmentsOf(calls.visionStreams[1]), ['att-a', 'att-b'], 'attempt 2: identical refs, identical order')
})

test('S-R18 attempt 2 request is bridge-equivalent to attempt 1: no attempt-1 output or violations fed back', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('FIRST-MERGED'))),
      chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2)
  assert.deepEqual(calls.visionStreams[1].messages, calls.visionStreams[0].messages, 'attempt 2 payload byte-identical to attempt 1')
  const content = calls.visionStreams[1].messages[0].content
  assert.deepEqual(content.map((b) => b.type), ['text', 'text', 'image', 'text', 'image'], 'prompt text + per-attachment boundary labels + images')
  assert.equal(content[1].text, 'Image 1 of 2:', 'attachment 1 label')
  assert.equal(content[3].text, 'Image 2 of 2:', 'attachment 2 label')
  const allText = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(!allText.includes('FIRST-MERGED'), 'attempt-1 Evidence never fed back')
  assert.ok(!allText.includes('images.length'), 'no validation violations fed back')
})

test('S-R19 wire after schema-retry success: in-place anchors + exactly one appended Evidence block', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR19-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SR19'))),
    ]),
  })
  applyBridge(ctx)
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{
      role: 'user',
      content: [textBlock('text-before'), imageBlock('att-a'), textBlock('text-between'), imageBlock('att-b'), textBlock('text-after')],
    }],
  }
  await stream(adapters, request)
  const wire = wireOf(calls)
  assert.deepEqual(wire.slice(0, 5), [
    textBlock('text-before'),
    textBlock('[Image 1]'),
    textBlock('text-between'),
    textBlock('[Image 2]'),
    textBlock('text-after'),
  ], 'anchors replace images IN PLACE, order preserved')
  assert.equal(wire[5].type, 'text', 'exactly one appended batch Evidence block')
  assert.ok(wire[5].text.includes('untrusted observed data'))
  assert.ok(wire[5].text.includes('SR19-1') && wire[5].text.includes('SR19-2'))
  assert.ok(!wire[5].text.includes('SR19-JUNK'), 'no attempt-1 content')
  assert.ok(!hasImageRecursive(wire))
})

/* ------------------------------------------------------------------ */
/* S-R20-S-R25: sealed-semantics regressions + structural proofs       */
/* ------------------------------------------------------------------ */

test('S-R20 renderer whitelist unchanged: no layout/semantics/visual/extra leakage', () => {
  const check = validateMultiEvidence({
    images: [
      { index: 1, ...single('W1'), visual: { dominant_colors: ['#111111'] } },
      { index: 2, ...single('W2') },
    ],
    relations: [{ imageIndexes: [1, 2], description: 'whitelist relation' }],
    secretExtra: 'SHOULD-NOT-LEAK',
  }, 2)
  assert.equal(check.ok, true)
  const text = renderMultiEvidence(check.value)
  assert.ok(text.includes('untrusted observed data'))
  assert.ok(text.includes('Image 1:') && text.includes('Image 2:'))
  assert.ok(text.includes('Summary: W1 summary'))
  assert.ok(text.includes('W2-OCR'))
  assert.ok(text.includes('Images 1,2: whitelist relation'))
  assert.ok(!text.includes('layout'), 'layout never rendered')
  assert.ok(!text.includes('semantics'), 'semantics never rendered')
  assert.ok(!text.includes('#111111'), 'visual never rendered')
  assert.ok(!text.includes('SHOULD-NOT-LEAK'), 'unknown extras never rendered')
})

test('S-R21 schema retry success with nested tool-result: zero ImageBlocks at every downstream depth', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR21-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SR21'))),
      chunksOf(JSON.stringify(single('NESTED-OK'))), // nested tool-result work unit (1 image)
    ]),
  })
  applyBridge(ctx)
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{
      role: 'user',
      content: [
        imageBlock('att-a'),
        imageBlock('att-b'),
        { type: 'tool-result', toolCallId: 'call_1', content: [imageBlock('att-c')] },
      ],
    }],
  }
  await stream(adapters, request)
  assert.ok(!hasImageRecursive(wireOf(calls)), 'zero ImageBlock at every depth after schema-retry success')
  assert.ok(wireOf(calls).some((b) => b.text?.includes('[Image 1]')), 'top-level anchors present')
})

test('S-R22 durable source messages immutable on schema-retry success AND exhaustion', async () => {
  const okCtx = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR22-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SR22-OK'))),
    ]),
  })
  applyBridge(okCtx.ctx)
  const okRequest = twoImageRequest()
  const okSnapshot = JSON.parse(JSON.stringify(okRequest))
  await stream(okCtx.adapters, okRequest)
  assert.deepEqual(okRequest, okSnapshot, 'durable input unchanged after schema-retry success')

  const failCtx = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR22-JUNK-1'))),
      chunksOf(JSON.stringify(mergedEntry('SR22-JUNK-2'))),
    ]),
  })
  applyBridge(failCtx.ctx)
  const failRequest = twoImageRequest()
  const failSnapshot = JSON.parse(JSON.stringify(failRequest))
  await assert.rejects(stream(failCtx.adapters, failRequest), (error) => {
    assert.match(error.message, VALIDATION_EXHAUSTED)
    return true
  })
  assert.deepEqual(failRequest, failSnapshot, 'durable input unchanged after validation exhaustion')
})

test('S-R23 [SCHEMA_FAIL, SCHEMA_FAIL] never cached: same-session repeat performs its own fresh 2 attempts', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR23-JUNK-1'))),
      chunksOf(JSON.stringify(mergedEntry('SR23-JUNK-2'))),
      chunksOf(JSON.stringify(mergedEntry('SR23-JUNK-3'))),
      chunksOf(JSON.stringify(mergedEntry('SR23-JUNK-4'))),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest('sess-sr23')), (error) => {
    assert.match(error.message, VALIDATION_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'first request performed 2 attempts')
  await assert.rejects(stream(adapters, twoImageRequest('sess-sr23')), (error) => {
    assert.match(error.message, VALIDATION_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 4, 'validation failure was not cached: the repeat performed its own fresh 2 attempts')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream never invoked')
})

test('S-R24 downstream invoked exactly once after schema retry success', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR24-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SR24'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2)
  assert.equal(calls.upstreamStreams.length, 1, 'downstream exactly once, only after final success')
})

test('S-R25 structural no-Attempt-3 proof: [PARSE_FAIL, SCHEMA_FAIL, VALID_SPARE] -> exactly 2 calls', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf('sr25 not json {'),
      chunksOf(JSON.stringify(mergedEntry('SR25-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SR25-SPARE'))),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, VALIDATION_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'the third scripted response is never consumed')
  assert.equal(calls.upstreamStreams.length, 0)
})

test('S-R25 structural no-Attempt-3 proof: [SCHEMA_FAIL, PARSE_FAIL, VALID_SPARE] -> exactly 2 calls', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify(mergedEntry('SR25B-JUNK'))),
      chunksOf('sr25b not json {'),
      chunksOf(JSON.stringify(multiValid('SR25B-SPARE'))),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'the third scripted response is never consumed')
  assert.equal(calls.upstreamStreams.length, 0)
})

/* ------------------------------------------------------------------ */
/* Sequence state-machine matrix                                       */
/*                                                                     */
/* Proves structurally: no execution sequence can consume a third      */
/* Vision response — every row asserts the exact total Vision-call      */
/* count and the observable final classification.                      */
/* ------------------------------------------------------------------ */

const asGenerator = (chunks) => (async function* () { for (const chunk of chunks) yield chunk })()

/** One scripted response factory per outcome name (fresh iterable per call). */
const OUTCOMES = {
  VALID: () => asGenerator(chunksOf(JSON.stringify(multiValid('MATRIX-VALID')))),
  PARSE_FAIL: () => asGenerator(chunksOf('matrix not json {')),
  SCHEMA_FAIL: () => asGenerator(chunksOf(JSON.stringify(mergedEntry('MATRIX-SCHEMA')))),
  PROVIDER_FAIL: () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'vision route down', code: 'DOWN' } } }
  })(),
  SPARE: () => asGenerator(chunksOf(JSON.stringify(multiValid('SPARE-NEVER-CONSUMED')))),
}

const MATRIX = [
  { seq: '[VALID]', outcomes: ['VALID'], calls: 1, result: 'success' },
  { seq: '[PARSE_FAIL, VALID]', outcomes: ['PARSE_FAIL', 'VALID'], calls: 2, result: 'success' },
  { seq: '[SCHEMA_FAIL, VALID]', outcomes: ['SCHEMA_FAIL', 'VALID'], calls: 2, result: 'success' },
  { seq: '[PARSE_FAIL, SCHEMA_FAIL]', outcomes: ['PARSE_FAIL', 'SCHEMA_FAIL'], calls: 2, result: 'validation-exhausted' },
  { seq: '[SCHEMA_FAIL, PARSE_FAIL]', outcomes: ['SCHEMA_FAIL', 'PARSE_FAIL'], calls: 2, result: 'parse-exhausted' },
  { seq: '[SCHEMA_FAIL, SCHEMA_FAIL]', outcomes: ['SCHEMA_FAIL', 'SCHEMA_FAIL'], calls: 2, result: 'validation-exhausted' },
  { seq: '[PARSE_FAIL, PARSE_FAIL]', outcomes: ['PARSE_FAIL', 'PARSE_FAIL'], calls: 2, result: 'parse-exhausted' },
  { seq: '[PROVIDER_FAIL]', outcomes: ['PROVIDER_FAIL'], calls: 1, result: 'provider' },
  { seq: '[SCHEMA_FAIL, PROVIDER_FAIL]', outcomes: ['SCHEMA_FAIL', 'PROVIDER_FAIL'], calls: 2, result: 'provider' },
  { seq: '[VALID, SPARE]', outcomes: ['VALID', 'SPARE'], calls: 1, result: 'success' },
  { seq: '[PARSE_FAIL, SCHEMA_FAIL, SPARE]', outcomes: ['PARSE_FAIL', 'SCHEMA_FAIL', 'SPARE'], calls: 2, result: 'validation-exhausted' },
]

const CLASSIFIERS = {
  'parse-exhausted': (error) => assert.match(error.message, PARSE_EXHAUSTED),
  'validation-exhausted': (error) => assert.match(error.message, VALIDATION_EXHAUSTED),
  provider: (error) => assert.match(error.message, /vision stream error/),
}

for (const { seq, outcomes, calls, result } of MATRIX) {
  test(`state machine ${seq} -> exactly ${calls} Vision call(s) -> ${result}`, async () => {
    const { ctx, calls: rec, adapters } = makeCtx({
      visionResponder: queueResponder(outcomes.map((name) => OUTCOMES[name])),
    })
    applyBridge(ctx)
    if (result === 'success') {
      await stream(adapters, twoImageRequest())
      assert.equal(rec.upstreamStreams.length, 1, 'downstream exactly once on success')
    } else {
      await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
        CLASSIFIERS[result](error)
        return true
      })
      assert.equal(rec.upstreamStreams.length, 0, 'downstream zero on failure')
    }
    assert.equal(rec.visionStreams.length, calls, `exactly ${calls} Vision call(s); no third response can ever be consumed`)
  })
}
