// v0.2.1 U+200B envelope-noise disposition tests (E-N1-E-N12 + abuse matrix).
// Approved design: bounded leading U+200B tolerance, anchored at position 0 of
// the post-envelope parse input, exactly once, immediately before JSON.parse.
// v0.2.1-v0.2.4: MULTI-IMAGE ONLY. v0.2.5 candidate: the tolerance is extended
// to the SINGLE-IMAGE path (real-provider evidence: intermittent leading
// U+200B envelope on single-image Vision output — 2026-08-18, 4 consecutive
// user-session failures). Single-image keeps NO retry, NO forced temperature.
// All deterministic mock-ctx tests — no provider.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  renderMultiEvidence,
  validateMultiEvidence,
} from '../dist/index.js'

const ZWSP = '\u200B'

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

const singleImageRequest = () => ({
  provider: WRAPPER,
  model: 't1',
  messages: [{ role: 'user', content: [imageBlock('att-single')] }],
})

/** One complete deterministic text reply as a chunk list. */
const chunksOf = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const fenced = (json) => `\`\`\`json\n${json}\n\`\`\``

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

const PARSE_EXHAUSTED = /^\[dsh-vision-bridge\] vision output is not valid JSON \(retry exhausted\):/
const VALIDATION_EXHAUSTED = /^\[dsh-vision-bridge\] vision evidence failed validation \(retry exhausted\):/
const SINGLE_PARSE = /^\[dsh-vision-bridge\] vision output is not valid JSON:/

/* ------------------------------------------------------------------ */
/* E-N1-E-N8: multi envelope tolerance                                 */
/* ------------------------------------------------------------------ */

test('E-N1 U+200B + valid multi JSON -> 1 Vision call -> success -> semantics preserved', async () => {
  const plain = JSON.stringify(multiValid('EN1'))
  const withZwsp = ZWSP + plain
  const zwspCtx = makeCtx({ visionResponder: queueResponder([chunksOf(withZwsp)]) })
  applyBridge(zwspCtx.ctx)
  await stream(zwspCtx.adapters, twoImageRequest())
  assert.equal(zwspCtx.calls.visionStreams.length, 1, 'tolerance: no retry consumed')
  assert.equal(zwspCtx.calls.upstreamStreams.length, 1, 'downstream once')

  // Semantics preservation: the canonical rendered Evidence must be identical
  // to a control run whose provider emitted the same JSON without the prefix.
  const plainCtx = makeCtx({ visionResponder: queueResponder([chunksOf(plain)]) })
  applyBridge(plainCtx.ctx)
  await stream(plainCtx.adapters, twoImageRequest())
  assert.equal(wireOf(zwspCtx.calls).at(-1).text, wireOf(plainCtx.calls).at(-1).text, 'canonical Evidence deep-equal to the no-ZWSP control')
  assert.ok(!hasImageRecursive(wireOf(zwspCtx.calls)))
})

test('E-N2 U+200B + invalid JSON (both attempts) -> 2 calls -> parse exhausted -> downstream 0', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(ZWSP + 'not json {'), chunksOf(ZWSP + 'not json again {')]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'tolerance cannot repair malformed JSON; retry consumed, then exhausted')
  assert.equal(calls.upstreamStreams.length, 0, 'downstream 0')
})

test('E-N3 envelope tolerance cannot bypass schema: attempt1 ZWSP+valid JSON+invalid N=2 schema, attempt2 valid -> 2 calls, success', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(ZWSP + JSON.stringify(mergedEntry('EN3-JUNK'))),
      chunksOf(JSON.stringify(multiValid('EN3-OK'))),
    ]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2, 'attempt 1 parsed (tolerance) but failed schema -> schema retry')
  assert.equal(calls.upstreamStreams.length, 1)
  const wire = wireOf(calls)
  assert.ok(wire.at(-1).text.includes('EN3-OK-1') && wire.at(-1).text.includes('EN3-OK-2'))
  assert.ok(!wire.at(-1).text.includes('EN3-JUNK'), 'schema-invalid attempt never downstream')
})

test('E-N3 exhaustion variant: ZWSP+valid JSON+invalid schema twice -> 2 calls -> validation exhausted -> downstream 0', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(ZWSP + JSON.stringify(mergedEntry('EN3B-JUNK-1'))),
      chunksOf(ZWSP + JSON.stringify(mergedEntry('EN3B-JUNK-2'))),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, VALIDATION_EXHAUSTED)
    assert.match(error.message, /images\.length/)
    return true
  })
  assert.equal(calls.visionStreams.length, 2)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N4 U+200B inside a quoted Evidence string is preserved exactly', () => {
  const inner = `A${ZWSP}B`
  const value = {
    images: [
      { index: 1, ...single('EN4-1'), summary: `s${inner}e`, ocr: { full_text: `t${inner}e`, lines: [{ text: `t${inner}e` }] } },
      { index: 2, ...single('EN4-2') },
    ],
    relations: [],
  }
  const check = validateMultiEvidence(JSON.parse(JSON.stringify(value)), 2)
  assert.equal(check.ok, true)
  assert.equal(check.value.images[0].summary, `s${inner}e`, 'string content preserved by code-point equality')
  assert.equal(check.value.images[0].ocr.full_text, `t${inner}e`)
  const rendered = renderMultiEvidence(check.value)
  assert.ok(rendered.includes(inner), 'renderer preserves the internal ZWSP as content')
})

test('E-N4b U+200B inside a quoted string survives the full multi bridge path', async () => {
  const inner = `x${ZWSP}y`
  const payload = {
    images: [
      { index: 1, ...single('EN4B-1'), summary: `sum${inner}m` },
      { index: 2, ...single('EN4B-2') },
    ],
    relations: [],
  }
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(JSON.stringify(payload))]) })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 1)
  assert.ok(wireOf(calls).at(-1).text.includes(`sum${inner}m`), 'internal ZWSP reaches downstream as literal Evidence content')
})

test('E-N5 valid JSON + trailing U+200B -> parse fail -> exhausted (no trailing tolerance)', async () => {
  const trailing = JSON.stringify(multiValid('EN5')) + ZWSP
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(trailing), chunksOf(trailing)]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N6 arbitrary text + U+200B + valid JSON -> parse fail (no extraction)', async () => {
  const prose = `Here is the analysis:\n${ZWSP}${JSON.stringify(multiValid('EN6'))}`
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(prose), chunksOf(prose)]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N6b garbage + {valid JSON} -> parse fail (no "find first {" extraction)', async () => {
  const garbage = `garbage prefix {"images": "fake"}`
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(garbage), chunksOf(garbage)]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2)
})

test('E-N7 fence + inner leading U+200B -> sealed fence unwrap, then strip, then parse success', async () => {
  const inner = ZWSP + JSON.stringify(multiValid('EN7'))
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(fenced(inner))]) })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 1, 'existing fence tolerance + new leading strip compose once')
  assert.equal(calls.upstreamStreams.length, 1)
  assert.ok(wireOf(calls).at(-1).text.includes('EN7-1'))
})

test('E-N7b fenced content containing prose remains invalid', async () => {
  const prose = fenced('Here is the requested analysis, not JSON')
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(prose), chunksOf(prose)]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2)
})

test('E-N8 shared-budget interaction: [ZWSP+VALID] -> 1 call', async () => {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(ZWSP + JSON.stringify(multiValid('EN8A')))]) })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 1)
})

test('E-N8 shared-budget interaction: [ZWSP+INVALID_JSON, VALID] -> 2 calls -> success', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(ZWSP + 'still not json {'), chunksOf(JSON.stringify(multiValid('EN8B')))]),
  })
  applyBridge(ctx)
  await stream(adapters, twoImageRequest())
  assert.equal(calls.visionStreams.length, 2)
  assert.equal(calls.upstreamStreams.length, 1)
})

test('E-N8 shared-budget interaction: [ZWSP+INVALID_JSON, ZWSP+INVALID_JSON, SPARE] -> 2 calls exhausted, spare never consumed', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(ZWSP + 'nope {'),
      chunksOf(ZWSP + 'nope again {'),
      chunksOf(JSON.stringify(multiValid('EN8-SPARE'))),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'third scripted response never consumed')
  assert.equal(calls.upstreamStreams.length, 0)
})

/* ------------------------------------------------------------------ */
/* E-N9: single-image scope regression                                 */
/* ------------------------------------------------------------------ */

test('E-N9 single-image U+200B + valid Evidence -> ACCEPTED: 1 call, no retry, no forced temperature, semantics preserved', async () => {
  const plain = JSON.stringify(single('EN9'))
  const zwspCtx = makeCtx({
    visionResponder: queueResponder([chunksOf(ZWSP + plain)]),
  })
  applyBridge(zwspCtx.ctx)
  await stream(zwspCtx.adapters, singleImageRequest())
  assert.equal(zwspCtx.calls.visionStreams.length, 1, 'tolerance: no retry consumed')
  assert.equal('temperature' in zwspCtx.calls.visionStreams[0], false, 'single-image Vision gets NO forced temperature')
  assert.equal(zwspCtx.calls.upstreamStreams.length, 1, 'downstream once')

  // Semantics preservation: the canonical rendered Evidence must be identical
  // to a control run whose provider emitted the same JSON without the prefix.
  const plainCtx = makeCtx({ visionResponder: queueResponder([chunksOf(plain)]) })
  applyBridge(plainCtx.ctx)
  await stream(plainCtx.adapters, singleImageRequest())
  assert.equal(wireOf(zwspCtx.calls).at(-1).text, wireOf(plainCtx.calls).at(-1).text, 'canonical Evidence deep-equal to the no-ZWSP control')
})

test('E-N9b single fence + inner leading U+200B -> fence unwrap, then strip, then parse success', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(fenced(ZWSP + JSON.stringify(single('EN9B'))))]),
  })
  applyBridge(ctx)
  await stream(adapters, singleImageRequest())
  assert.equal(calls.visionStreams.length, 1, 'existing fence tolerance + leading strip compose once')
  assert.equal(calls.upstreamStreams.length, 1)
  assert.ok(wireOf(calls).at(-1).text.includes('EN9B'))
})

test('E-N9c single prose + U+200B + valid JSON -> parse fail (no extraction, fail closed)', async () => {
  const prose = `Here is the analysis:\n${ZWSP}${JSON.stringify(single('EN9C'))}`
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(prose)]) })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, singleImageRequest()), (error) => {
    assert.match(error.message, SINGLE_PARSE)
    assert.doesNotMatch(error.message, /retry exhausted/, 'single-image never retries')
    return true
  })
  assert.equal(calls.visionStreams.length, 1, 'tolerance cannot extract JSON from prose')
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N9d single valid JSON + trailing U+200B -> parse fail (no trailing tolerance)', async () => {
  const trailing = JSON.stringify(single('EN9D')) + ZWSP
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(trailing)]) })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, singleImageRequest()), (error) => {
    assert.match(error.message, SINGLE_PARSE)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N9e single U+2060 + valid JSON -> parse fail (only U+200B is tolerated)', async () => {
  const wordJoiner = `\u2060${JSON.stringify(single('EN9E'))}`
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(wordJoiner)]) })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, singleImageRequest()), (error) => {
    assert.match(error.message, SINGLE_PARSE)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N9f single U+200B + malformed JSON -> parse fail, no retry (tolerance cannot repair)', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(ZWSP + 'not json {')]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, singleImageRequest()), (error) => {
    assert.match(error.message, SINGLE_PARSE)
    assert.doesNotMatch(error.message, /retry exhausted/, 'single-image parse failure never retries')
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N9g single U+200B + schema-invalid JSON -> validation failure (schema stays authoritative)', async () => {
  const invalid = { ...single('EN9G'), summary: undefined }
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(ZWSP + JSON.stringify(invalid))]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, singleImageRequest()), (error) => {
    assert.match(error.message, /^\[dsh-vision-bridge\] vision evidence failed validation:/)
    assert.match(error.message, /summary/)
    return true
  })
  assert.equal(calls.visionStreams.length, 1, 'tolerance cannot bypass the schema')
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N9h single multiple JSON objects -> parse fail (only ONE complete JSON value)', async () => {
  const doubled = `${JSON.stringify(single('EN9H-A'))}${JSON.stringify(single('EN9H-B'))}`
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(doubled)]) })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, singleImageRequest()), (error) => {
    assert.match(error.message, SINGLE_PARSE)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N9i single U+200B + valid JSON + trailing U+200B -> parse fail (envelope must be leading-only)', async () => {
  const both = ZWSP + JSON.stringify(single('EN9I')) + ZWSP
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(both)]) })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, singleImageRequest()), (error) => {
    assert.match(error.message, SINGLE_PARSE)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N9j single fence containing prose remains invalid', async () => {
  const prose = fenced('Here is the requested analysis, not JSON')
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(prose)]) })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, singleImageRequest()), (error) => {
    assert.match(error.message, SINGLE_PARSE)
    return true
  })
  assert.equal(calls.visionStreams.length, 1)
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N10 no Attempt 3 with ZWSP sequences and a spare third response', async () => {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([
      chunksOf(ZWSP + 'bad one {'),
      chunksOf(ZWSP + 'bad two {'),
      chunksOf(JSON.stringify(multiValid('EN10-SPARE'))),
    ]),
  })
  applyBridge(ctx)
  await assert.rejects(stream(adapters, twoImageRequest()), (error) => {
    assert.match(error.message, PARSE_EXHAUSTED)
    return true
  })
  assert.equal(calls.visionStreams.length, 2, 'MAX_MULTI_ATTEMPTS = 2 still bounds the loop')
  assert.equal(calls.upstreamStreams.length, 0)
})

test('E-N12 provider/transport failures remain non-retryable under the new tolerance', async () => {
  const providerFail = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'vision route down', code: 'DOWN' } } }
    })(),
  })
  applyBridge(providerFail.ctx)
  await assert.rejects(stream(providerFail.adapters, twoImageRequest()), (error) => {
    assert.match(error.message, /vision stream error/)
    return true
  })
  assert.equal(providerFail.calls.visionStreams.length, 1, 'provider error: no output-contract retry')

  const missingFinish = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
    })(),
  })
  applyBridge(missingFinish.ctx)
  await assert.rejects(stream(missingFinish.adapters, twoImageRequest()), /ended without a finish/)
  assert.equal(missingFinish.calls.visionStreams.length, 1)

  const toolCalls = makeCtx({
    visionResponder: () => (async function* () {
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })(),
  })
  applyBridge(toolCalls.ctx)
  await assert.rejects(stream(toolCalls.adapters, twoImageRequest()), /tool-calls/)
  assert.equal(toolCalls.calls.visionStreams.length, 1)
})

/* ------------------------------------------------------------------ */
/* Abuse-case matrix (design review §7)                                 */
/* ------------------------------------------------------------------ */

/**
 * Run one multi request against the given raw candidate text (same text for
 * both attempts) and return observable outcomes.
 */
async function probeMulti(rawText) {
  const { ctx, calls, adapters } = makeCtx({
    visionResponder: queueResponder([chunksOf(rawText), chunksOf(rawText)]),
  })
  applyBridge(ctx)
  let error = null
  try {
    await stream(adapters, twoImageRequest())
  } catch (caught) {
    error = caught
  }
  return {
    error: error === null ? null : String(error.message),
    visionCalls: calls.visionStreams.length,
    upstreamCalls: calls.upstreamStreams.length,
    wire: calls.upstreamStreams.length > 0 ? wireOf(calls).map((b) => b.text ?? '').join('\n') : null,
  }
}

/** Run one single-image request against the given raw candidate text. */
async function probeSingle(rawText) {
  const { ctx, calls, adapters } = makeCtx({ visionResponder: queueResponder([chunksOf(rawText)]) })
  applyBridge(ctx)
  let error = null
  try {
    await stream(adapters, singleImageRequest())
  } catch (caught) {
    error = caught
  }
  return {
    error: error === null ? null : String(error.message),
    visionCalls: calls.visionStreams.length,
    upstreamCalls: calls.upstreamStreams.length,
  }
}

const MULTI_ACCEPT = (r) => ({ accept: r.error === null && r.visionCalls === 1 && r.upstreamCalls === 1, probe: r })
const MULTI_REJECT = (r) => ({ accept: r.error !== null && r.visionCalls === 2 && r.upstreamCalls === 0, probe: r })
const SINGLE_ACCEPT = (r) => ({ accept: r.error === null && r.visionCalls === 1 && r.upstreamCalls === 1, probe: r })
const SINGLE_REJECT = (r) => ({ accept: r.error !== null && r.visionCalls === 1 && r.upstreamCalls === 0, probe: r })

const MATRIX = [
  {
    name: 'U+200B + valid JSON',
    rawMulti: ZWSP + JSON.stringify(multiValid('MATRIX-1')),
    rawSingle: ZWSP + JSON.stringify(single('MATRIX-1')),
    multi: MULTI_ACCEPT, single: SINGLE_ACCEPT,
  },
  {
    name: 'U+200B U+200B + valid JSON',
    rawMulti: ZWSP + ZWSP + JSON.stringify(multiValid('MATRIX-2')),
    rawSingle: ZWSP + ZWSP + JSON.stringify(single('MATRIX-2')),
    multi: MULTI_ACCEPT, single: SINGLE_ACCEPT,
  },
  {
    name: 'space + U+200B + valid JSON',
    rawMulti: ` ${ZWSP}${JSON.stringify(multiValid('MATRIX-3'))}`,
    rawSingle: ` ${ZWSP}${JSON.stringify(single('MATRIX-3'))}`,
    multi: MULTI_ACCEPT, single: SINGLE_ACCEPT,
  },
  {
    name: 'U+200B outside a Markdown fence (strip must not compose with fence unwrap)',
    rawMulti: ZWSP + fenced(JSON.stringify(multiValid('MATRIX-F1'))),
    rawSingle: ZWSP + fenced(JSON.stringify(single('MATRIX-F1'))),
    multi: MULTI_REJECT, single: SINGLE_REJECT,
  },
  {
    name: 'U+FEFF + valid JSON (existing trim behavior)',
    rawMulti: `\uFEFF${JSON.stringify(multiValid('MATRIX-4'))}`,
    rawSingle: `\uFEFF${JSON.stringify(single('MATRIX-4'))}`,
    multi: MULTI_ACCEPT, single: SINGLE_ACCEPT,
  },
  {
    name: 'U+2060 + valid JSON',
    rawMulti: `\u2060${JSON.stringify(multiValid('MATRIX-5'))}`,
    rawSingle: `\u2060${JSON.stringify(single('MATRIX-5'))}`,
    multi: MULTI_REJECT, single: SINGLE_REJECT,
  },
  {
    name: 'U+200B inside a JSON string',
    rawMulti: JSON.stringify({
      images: [
        { index: 1, ...single(`M6${ZWSP}A`) },
        { index: 2, ...single('M6-B') },
      ],
      relations: [],
    }),
    rawSingle: JSON.stringify(single(`M6${ZWSP}A`)),
    multi: (r) => ({ accept: r.error === null && r.visionCalls === 1 && r.upstreamCalls === 1 && (r.wire ?? '').includes(ZWSP), probe: r }),
    single: (r) => ({ accept: r.error === null && r.visionCalls === 1 && r.upstreamCalls === 1, probe: r }),
  },
  {
    name: 'U+200B between JSON tokens',
    rawMulti: JSON.stringify(multiValid('MATRIX-7')).replace('{', `{${ZWSP}`),
    rawSingle: JSON.stringify(single('MATRIX-7')).replace('{', `{${ZWSP}`),
    multi: MULTI_REJECT, single: SINGLE_REJECT,
  },
  {
    name: 'valid JSON + trailing U+200B',
    rawMulti: JSON.stringify(multiValid('MATRIX-8')) + ZWSP,
    rawSingle: JSON.stringify(single('MATRIX-8')) + ZWSP,
    multi: MULTI_REJECT, single: SINGLE_REJECT,
  },
  {
    name: 'prose + U+200B + valid JSON',
    rawMulti: `hello ${ZWSP}${JSON.stringify(multiValid('MATRIX-9'))}`,
    rawSingle: `hello ${ZWSP}${JSON.stringify(single('MATRIX-9'))}`,
    multi: MULTI_REJECT, single: SINGLE_REJECT,
  },
  {
    name: 'garbage + {valid JSON}',
    rawMulti: `garbage ${JSON.stringify(multiValid('MATRIX-10'))}`,
    rawSingle: `garbage ${JSON.stringify(single('MATRIX-10'))}`,
    multi: MULTI_REJECT, single: SINGLE_REJECT,
  },
]

for (const row of MATRIX) {
  test(`abuse matrix: ${row.name}`, async () => {
    const multiResult = row.multi(await probeMulti(row.rawMulti))
    assert.equal(multiResult.accept, true, `multi path wrong for "${row.name}": ${JSON.stringify(multiResult.probe)}`)
    const singleResult = row.single(await probeSingle(row.rawSingle))
    assert.equal(singleResult.accept, true, `single path wrong for "${row.name}": ${JSON.stringify(singleResult.probe)}`)
  })
}
