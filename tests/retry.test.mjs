// v0.2.1 robustness tests (R1-R24 + output-contract failure discriminators).
// Multi prompt hardening + temperature 0 (multi only) + ONE shared retry
// budget (MAX_MULTI_ATTEMPTS = 2) across strict JSON parse failure AND multi
// Evidence validation failure. All deterministic mock-ctx tests — no provider.
//
// IMPORTANT: R3's synthetic leading artifact proves RETRY MECHANICS only. It
// is a plausible stand-in for the uncaptured real failure class (non-JSON
// output) and does NOT claim to reproduce the exact raw form of the two
// failed UI runs, which was never durably captured.
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

/** Valid JSON wrapped in one Markdown fence (existing compatibility policy). */
const fenced = (json) => `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``

/** Synthetic leading non-JSON artifact: prose before a valid JSON object. */
const leadingArtifact = (json) => `Here is the requested analysis:\n${JSON.stringify(json)}`

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

/* ------------------------------------------------------------------ */
/* R1-R12: retry mechanics                                            */
/* ------------------------------------------------------------------ */

test('R1 ordinary valid multi JSON -> 1 Vision call -> success', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(JSON.stringify(multiValid('R1')))]) })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 1, 'exactly one Vision call')
  assert.equal(calls.upstreamStreams.length, 1, 'downstream invoked once')
  const wire = wireOf(calls)
  assert.deepEqual(wire.slice(0, 2), [textBlock('[Image 1]'), textBlock('[Image 2]')], 'anchors unchanged')
  assert.ok(wire[2].text.includes('R1-1'), 'valid evidence reached downstream')
  assert.ok(!hasImageRecursive(wire), 'downstream zero ImageBlock')
})

test('R2 fenced valid JSON -> existing compatibility accepts it -> 1 Vision call', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(fenced(multiValid('R2')))]) })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 1, 'no retry needed')
  assert.equal(calls.upstreamStreams.length, 1)
  assert.ok(wireOf(calls)[2].text.includes('R2-1'))
})

test('R3 synthetic leading non-JSON artifact on attempt 1 -> typed parse failure; attempt 2 valid -> success, exactly 2 Vision calls', async () => {
  const scripts = [
    chunksOf(leadingArtifact(multiValid('FIRST-JUNK'))),
    chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
  ]
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder(scripts) })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  // This synthetic prefix proves retry mechanics only; it is NOT claimed to be
  // the exact uncaptured raw form of the failed real UI runs.
  assert.equal(calls.visionStreams.length, 2, 'exactly one retry')
  assert.equal(calls.upstreamStreams.length, 1, 'downstream exactly once, only after success')
  const wire = wireOf(calls)
  assert.ok(wire[2].text.includes('SECOND-OK'), 'attempt-2 evidence used')
  assert.ok(!wire[2].text.includes('FIRST-JUNK'), 'attempt-1 text never reaches downstream')
  for (const options of calls.visionStreams) assert.equal(options.temperature, 0, 'temperature 0 on every multi attempt')
})

test('R4 attempt1 malformed + attempt2 malformed -> exactly 2 calls -> retry exhausted -> downstream 0 -> cache empty', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf('still not json {'), chunksOf('also not json {')]),
  })
  applyBridge(ctx)
  const request = twoImageRequest('sess-r4')
  await assert.rejects(stream(adapters, request), (error) => {
    // Observable classification (the internal error class is not exported):
    // stable message prefix + retry-exhaustion marker.
    assert.match(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON \(retry exhausted\):/, 'v0.2.0-compatible prefix + exhaustion')
    assert.ok(!error.message.includes('att-a'), 'no attachment refs in the error')
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'exactly 2 attempts, never a third')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream 0')
  // Cache: failures are never inserted — a same-session repeat performs fresh attempts.
  await assert.rejects(stream(adapters, twoImageRequest('sess-r4')), /retry exhausted/)
  assert.equal(calls.visionStreams.length, 4, 'cache stayed empty: the repeat performed its own 2 attempts')
})

test('R5 attempt1 malformed + attempt2 schema-invalid -> exactly 2 calls -> validation-exhausted failure -> no third -> downstream 0 -> cache empty', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf('not json {'),
      chunksOf(JSON.stringify({ images: [{ index: 1, ...single('ONLY-ONE') }], relations: [] })), // wrong length for N=2
      chunksOf('still not json {'),
      chunksOf('still not json either {'),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest('sess-r5')), (error) => {
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/, 'final schema failure is NOT classified as a parse failure')
    assert.match(error.message, /vision evidence failed validation/)
    assert.match(error.message, /retry exhausted/)
    assert.match(error.message, /images\.length/)
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'exactly 2 attempts, no third')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream 0')
  await assert.rejects(stream(adapters, twoImageRequest('sess-r5')), /retry exhausted/)
  assert.equal(calls.visionStreams.length, 4, 'schema failure was not cached either: the repeat performed its own fresh attempts')
})

test('R6 attempt1 schema-invalid + attempt2 valid -> exactly 2 calls -> retry success -> downstream once', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify({ images: [{ index: 1, ...single('FIRST-SCHEMA-JUNK') }], relations: [] })), // wrong length for N=2
      chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2, 'schema failure now consumes the shared retry budget')
  assert.equal(calls.upstreamStreams.length, 1, 'downstream exactly once after retry success')
  const wire = wireOf(calls)
  assert.ok(wire.at(-1).text.includes('SECOND-OK'), 'attempt-2 Evidence downstream')
  assert.ok(!wire.at(-1).text.includes('FIRST-SCHEMA-JUNK'), 'attempt-1 invalid Evidence discarded')
})

test('R7 abort after attempt1 parse failure and before attempt2 -> exactly 1 Vision call -> aborted -> downstream 0', async () => {
  const controller = new AbortController()
  const { ctx, calls, adapters } = makeCtx({
    // Deterministic boundary: the generator aborts the signal only AFTER the
    // attempt-1 finish chunk is delivered and consumed, so the bridge reaches
    // its between-attempts throwIfAborted with the signal already aborted.
    visionResponder: queueResponder([
      (options) => (async function* () {
        yield* chunksOf('not json {')
        controller.abort(new Error('R7 abort between attempts'))
      })(),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest(undefined, { signal: controller.signal })), /R7 abort between attempts/)
  assert.equal(calls.visionStreams.length, 1, 'no second Vision attempt after cancellation')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream 0')
})

test('R8 provider execution error -> 1 call -> NO retry', async () => {
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

test('R9 tool-call finish -> 1 call -> NO retry', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })(),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/)
    assert.match(error.message, /tool-calls/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('R10 missing finish -> 1 call -> NO retry', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial-then-silence' }
    })(),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/)
    assert.match(error.message, /ended without a finish/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('R11/R12 successful second attempt -> only validated attempt2 Evidence inserted; later same-session repeat -> cache HIT, 0 additional Vision calls', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(leadingArtifact(multiValid('FIRST-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest('sess-r11'))
  assert.equal(calls.visionStreams.length, 2, 'retry consumed both attempts')
  assert.ok(wireOf(calls).at(-1).text.includes('SECOND-OK'), 'downstream carries the validated attempt-2 Evidence')

  await stream(adapters, twoImageRequest('sess-r11'))
  assert.equal(calls.visionStreams.length, 2, 'cache HIT: zero additional Vision calls')
  assert.equal(calls.upstreamStreams.length, 2, 'downstream ran again through the same renderer path')
  assert.ok(wireOf(calls, 1).at(-1).text.includes('SECOND-OK'), 'HIT serves the canonical attempt-2 Evidence')
})

test('R13 policy key: versions 1/2/3 pairwise distinct; [A,B] != [B,A] preserved', () => {
  assert.equal(EVIDENCE_POLICY_VERSION, 3, 'v0.2.1 schema-robustness policy version is 3')
  const base = { sessionId: 's1', visionProvider: 'vp', visionModel: 'vm', orderedAttachmentIds: ['a', 'b'] }
  const official = buildEvidenceCacheKey(base)
  assert.equal(official, JSON.stringify([3, 's1', 'vp', 'vm', ['a', 'b']]), 'key embeds policy version 3')
  assert.notEqual(official, JSON.stringify([1, 's1', 'vp', 'vm', ['a', 'b']]), 'v0.2.0 policy-1 keys are distinct')
  assert.notEqual(official, JSON.stringify([2, 's1', 'vp', 'vm', ['a', 'b']]), 'v0.2.1 policy-2 keys are distinct')
  assert.notEqual(
    buildEvidenceCacheKey(base),
    buildEvidenceCacheKey({ ...base, orderedAttachmentIds: ['b', 'a'] }),
    'order remains semantic',
  )
})

/* ------------------------------------------------------------------ */
/* R14-R16: scope discipline (single-image / temperature)             */
/* ------------------------------------------------------------------ */

test('R14 single-image regression: no forced temperature, no retry, existing behavior', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(JSON.stringify(single('S1-OK'))) ]),
  })
  applyBridge(ctx)
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{ role: 'user', content: [textBlock('what is this'), imageBlock('att-single')] }],
  }
  await stream(adapters, request)
  assert.equal(calls.visionStreams.length, 1)
  const options = calls.visionStreams[0]
  assert.equal('temperature' in options, false, 'single-image Vision gets NO forced temperature')
  const wire = wireOf(calls)
  assert.ok(!wire.some((b) => b.text?.includes('[Image')), 'no multi anchor on the single path')
  assert.ok(wire.some((b) => b.text?.includes('S1-OK')), 'single evidence downstream')
  assert.ok(!hasImageRecursive(wire))

  // Single-image malformed: strict parse failure propagates, NO retry.
  const failCtx = makeCtx({ visionResponder: queueResponder([chunksOf('not json {')]) })
  applyBridge(failCtx.ctx)
  await assert.rejects(stream(failCtx.adapters, request), (error) => {
    assert.match(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON:/, 'v0.2.0 message prefix retained')
    assert.doesNotMatch(error.message, /retry exhausted/, 'single-image parse failure never retries')
    return true
  })
  assert.equal(failCtx.calls.visionStreams.length, 1, 'single-image path NEVER retries')
  assert.equal(failCtx.calls.upstreamStreams.length, 0)
})

test('R15 multi Vision call captures temperature === 0', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(JSON.stringify(multiValid('R15')))]) })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 1)
  assert.equal('temperature' in calls.visionStreams[0], true, 'temperature key present')
  assert.equal(calls.visionStreams[0].temperature, 0, 'multi attempt is temperature 0')
})

test('R16 downstream text call: Bridge never forces temperature 0', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(JSON.stringify(multiValid('R16')))]) })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest(undefined, { temperature: 0.7 }))
  assert.equal(calls.upstreamStreams[0].temperature, 0.7, 'caller-supplied downstream temperature preserved verbatim')
  assert.equal(calls.visionStreams[0].temperature, 0, 'vision still temperature 0')

  const omittedCtx = makeCtx({ visionResponder: queueResponder([chunksOf(JSON.stringify(multiValid('R16')))]) })
  applyBridge(omittedCtx.ctx)
  await stream(omittedCtx.adapters, twoImageRequest())
  assert.equal('temperature' in omittedCtx.calls.upstreamStreams[0], false, 'omitted downstream temperature is not invented')
  assert.equal(omittedCtx.calls.visionStreams[0].temperature, 0)
})

/* ------------------------------------------------------------------ */
/* R17-R24: sealed-semantics regressions                               */
/* ------------------------------------------------------------------ */

test('R17 multi anchor/wire output unchanged', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(JSON.stringify(multiValid('R17')))]) })
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
  assert.ok(wire[5].text.includes('R17-1') && wire[5].text.includes('R17-2'))
  assert.ok(!hasImageRecursive(wire))
})

test('R18 renderer whitelist unchanged', () => {
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

test('R19 original messages deep-equal after success and failure (retry paths)', async () => {
  const okCtx = makeCtx({
    visionResponder: queueResponder([
      chunksOf(leadingArtifact(multiValid('FIRST-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
    ]),
  })
  applyBridge(okCtx.ctx)
  const okRequest = twoImageRequest()
  const okSnapshot = JSON.parse(JSON.stringify(okRequest))
  await stream(okCtx.adapters, okRequest)
  assert.deepEqual(okRequest, okSnapshot, 'durable input unchanged after retry success')

  const failCtx = makeCtx({ visionResponder: queueResponder([chunksOf('bad {'), chunksOf('bad again {')]) })
  applyBridge(failCtx.ctx)
  const failRequest = twoImageRequest()
  const failSnapshot = JSON.parse(JSON.stringify(failRequest))
  await assert.rejects(stream(failCtx.adapters, failRequest), /retry exhausted/)
  assert.deepEqual(failRequest, failSnapshot, 'durable input unchanged after retry exhaustion')
})

test('R20 downstream recursive ImageBlock count = 0 after successful retry', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(leadingArtifact(multiValid('FIRST-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
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
  assert.ok(!hasImageRecursive(wireOf(calls)), 'zero ImageBlock at every depth after retry success')
  assert.ok(wireOf(calls).some((b) => b.text?.includes('[Image 1]')), 'top-level anchors present')
})

test('R21 failed parse attempts never populate the Evidence cache', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf('bad {'), chunksOf('bad again {')]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest('sess-r21')), /retry exhausted/)
  assert.equal(calls.visionStreams.length, 2)
  await assert.rejects(stream(adapters, twoImageRequest('sess-r21')), /retry exhausted/)
  assert.equal(calls.visionStreams.length, 4, 'no cache entry after failed attempts: fresh attempts ran')
})

test('R22 retry uses the same image refs and the same image order', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(leadingArtifact(multiValid('FIRST-JUNK'))),
      chunksOf(JSON.stringify(multiValid('SECOND-OK'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2)
  assert.deepEqual(attachmentsOf(calls.visionStreams[0]), ['att-a', 'att-b'], 'attempt 1 order')
  assert.deepEqual(attachmentsOf(calls.visionStreams[1]), ['att-a', 'att-b'], 'attempt 2: identical refs, identical order')
})

test('R23 retry receives no first-attempt malformed text/context', async () => {
  const junk = leadingArtifact(multiValid('FIRST-JUNK'))
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(junk), chunksOf(JSON.stringify(multiValid('SECOND-OK')))]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2)
  assert.deepEqual(calls.visionStreams[1].messages, calls.visionStreams[0].messages, 'attempt 2 request is byte-identical to attempt 1')
  const content = calls.visionStreams[1].messages[0].content
  assert.deepEqual(content.map((b) => b.type), ['text', 'image', 'image'], 'prompt text + images only')
  const allText = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(!allText.includes('FIRST-JUNK'), 'malformed first output never fed back to the model')
  assert.ok(!allText.includes('Here is the requested analysis'), 'no first-attempt artifact reaches attempt 2')
})

test('R24 single-image valid/fenced/parser regressions remain green', async () => {
  const validCtx = makeCtx({ visionResponder: queueResponder([chunksOf(JSON.stringify(single('S-OK')))]) })
  applyBridge(validCtx.ctx)
  const request = {
    provider: WRAPPER, model: 't1',
    messages: [{ role: 'user', content: [imageBlock('att-single')] }],
  }
  await stream(validCtx.adapters, request)
  assert.equal(validCtx.calls.visionStreams.length, 1)
  assert.ok(wireOf(validCtx.calls).some((b) => b.text?.includes('S-OK')))

  const fencedCtx = makeCtx({ visionResponder: queueResponder([chunksOf(fenced(single('S-FENCED')))]) })
  applyBridge(fencedCtx.ctx)
  await stream(fencedCtx.adapters, request)
  assert.equal(fencedCtx.calls.visionStreams.length, 1, 'fence compatibility retained on the single path')

  const brokenCtx = makeCtx({ visionResponder: queueResponder([chunksOf('nope {')]) })
  applyBridge(brokenCtx.ctx)
  await assert.rejects(stream(brokenCtx.adapters, request), (error) => {
    assert.match(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON:/)
    assert.doesNotMatch(error.message, /retry exhausted/)
    return true
  })
  assert.equal(brokenCtx.calls.visionStreams.length, 1, 'single-image parser failure: no retry')
})

/* ------------------------------------------------------------------ */
/* Dedicated parse-error discriminator tests (section 19)             */
/* ------------------------------------------------------------------ */

test('discriminator: invalid JSON -> parse-exhausted classification (observable via message)', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf('bad {'), chunksOf('bad again {')]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON \(retry exhausted\):/, 'stable parse-failure classification observable via message')
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'exactly one retry was triggered by the parse classification alone')
})

test('discriminator: valid JSON with schema failure -> validation-exhausted, NOT parse', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(JSON.stringify({ images: [{ index: 1, ...single('SCHEMA-JUNK-1') }], relations: [] })), // wrong length for N=2
      chunksOf(JSON.stringify({ images: [{ index: 1, ...single('SCHEMA-JUNK-2') }], relations: [] })), // wrong length again
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/, 'schema failure is not classified as parse failure')
    assert.match(error.message, /vision evidence failed validation \(retry exhausted\)/)
    assert.match(error.message, /images\.length/)
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'schema failure consumes the shared budget; exhaustion after exactly 2 calls')
})

test('discriminator: provider error -> NOT a parse error', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'down', code: 'DOWN' } } }
    })(),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/)
    assert.match(error.message, /vision stream error/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
})

test('discriminator: missing finish -> NOT a parse error', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
    })(),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/)
    assert.match(error.message, /ended without a finish/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
})

test('discriminator: tool-call finish -> NOT a parse error', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })(),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/)
    assert.match(error.message, /tool-calls/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
})

test('discriminator: empty Vision text -> NOT a parse error', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.doesNotMatch(error.message, /^\[dsh-vision-bridge\] vision output is not valid JSON/)
    assert.match(error.message, /produced no text/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
})
