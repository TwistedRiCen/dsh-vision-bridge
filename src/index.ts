/**
 * dsh-vision-bridge — DSH-native vision bridge.
 *
 * Production plugin owns exactly three things: the Vision Wrapper (synthetic
 * adapter), the Vision Analyzer orchestration (image-capable DSH LLM calls
 * per content-container work unit), and the Evidence Transformer (validated
 * evidence rendered as an explicitly-untrusted text block for the downstream
 * text-only provider).
 *
 * Stage 1/1R (sealed baseline): one Vision invocation per encountered
 * ImageBlock occurrence, single-image Evidence.
 *
 * Stage 3A (multi-image): content-container batch work units. Every content
 * array is grouped by the same recursive algorithm (tool-result is a
 * boundary; maximal consecutive runs of non-tool-result blocks). A run with
 * one image keeps the exact sealed single-image behavior; a run with two or
 * more images becomes ONE Vision call carrying all images in traversal order,
 * and the wire copy replaces each ImageBlock in place with a `[Image n]`
 * anchor plus one appended batch Evidence block. Work units run SERIALly in
 * traversal order; the upstream dispatch happens only after the whole
 * outgoing message set converted successfully.
 *
 * v0.2.1 (robustness patch): the multi-image Vision analyzer now hardens its
 * prompt envelope and attachment-separation rules (VISION_PROMPT_MULTI),
 * forces temperature 0 on MULTI-IMAGE Vision attempts ONLY (single-image and
 * the downstream text request keep v0.2.0 GenerateOptions behavior), and
 * applies ONE SHARED retry budget (MAX_MULTI_ATTEMPTS = 2 total Vision
 * invocations per multi work unit) across strict JSON parse failure and
 * multi Evidence validation failure — parser and validator semantics stay
 * strict, no normalization/repair. EVIDENCE_POLICY_VERSION is 3.
 *
 * v0.2.3 candidate (multi-image cardinality fix): the multi Vision request
 * interleaves per-attachment boundary labels ("Image i of N:") before each
 * ImageBlock (anti-merge request construction); EVIDENCE_POLICY_VERSION is 4.
 *
 * Consumed DSH runtime service: llm ONLY. The bridge never reads raw image
 * bytes — ImageBlocks ({type:'image', attachment: ref}) are passed through to
 * the configured vision route; resolving bytes via ctx.attachments.readImage
 * is the vision-provider adapter's responsibility.
 *
 * Verified against DSH commit 47f943859bef60e4160492346772ded9b24f765a —
 * see src/types.ts for per-interface anchors.
 *
 * Provenance (Class B, adapted): recursive ImageBlock/tool-result traversal
 * and evidence projection adapted from @liustack/modlens v3.16.6 dsh/index.js
 * (MIT, (c) Leon Liu); behavior modified — failures THROW (fail closed)
 * instead of degrading to explanatory text. The Stage 3A content-container
 * batching semantics go beyond ModLens's per-image design; this is not a
 * clean-room origin. See THIRD_PARTY_NOTICES.md.
 */

import type {
  BridgeContextLike,
  ContentBlockLike,
  GenerateOptionsLike,
  ImageBlockLike,
  LlmAdapterLike,
  LlmModelInfoLike,
  LlmResolvedModelInfoLike,
  MessageLike,
  StreamChunkLike,
  ToolResultBlockLike,
} from './types.js'
import { EVIDENCE_BOUNDARY, renderEvidence, renderMultiEvidence, VISION_PROMPT, VISION_PROMPT_MULTI } from './prompt.js'
import { validateEvidence, validateMultiEvidence, type MultiVisionEvidence } from './schema.js'
import { buildEvidenceCacheKey, createEvidenceCache, isCacheEligible, type EvidenceCache } from './cache.js'

export { EVIDENCE_BOUNDARY, MULTI_EVIDENCE_BOUNDARY, VISION_PROMPT, VISION_PROMPT_MULTI, renderEvidence, renderMultiEvidence } from './prompt.js'
export { EVIDENCE_POLICY_VERSION, validateEvidence, validateMultiEvidence } from './schema.js'
export { EVIDENCE_CACHE_CAPACITY, buildEvidenceCacheKey, createEvidenceCache, deepFreezeJson, isCacheEligible } from './cache.js'

export const name = 'dsh-vision-bridge'
/** llm only: the production plugin consumes no other DSH service. */
export const inject = ['llm'] as const

export interface BridgeConfig {
  /** The explicit text-only reasoning provider route to wrap. */
  upstreamProvider: string
  /** The DSH route that serves an image-capable vision model. */
  visionProvider: string
  /** The image-capable model id on the vision route. */
  visionModel: string
  /** Synthetic wrapper provider id (defaults to `<upstreamProvider>-vision-bridge`). */
  providerId?: string
}

/**
 * Validate raw patch config. Throws on anything unusable — including the
 * synthetic-route recursion guards (the wrapper id must never equal the
 * upstream or vision route). upstreamProvider === visionProvider is ALLOWED:
 * one DSH route may serve a text reasoning model and an image-capable vision
 * model; recursion is only reachable through the synthetic route id.
 */
export function validateConfig(raw: BridgeConfig): Required<BridgeConfig> {
  const stringOr = (value: unknown, key: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`[dsh-vision-bridge] config "${key}" must be a non-empty string, got ${JSON.stringify(value)}`)
    }
    return value.trim()
  }
  const upstreamProvider = stringOr(raw?.upstreamProvider, 'upstreamProvider')
  const visionProvider = stringOr(raw?.visionProvider, 'visionProvider')
  const visionModel = stringOr(raw?.visionModel, 'visionModel')
  const providerId = raw?.providerId === undefined ? `${upstreamProvider}-vision-bridge` : stringOr(raw.providerId, 'providerId')
  if (providerId === upstreamProvider) {
    throw new Error(`[dsh-vision-bridge] synthetic providerId "${providerId}" must not equal upstreamProvider (wrapper would wrap itself)`)
  }
  if (providerId === visionProvider) {
    throw new Error(`[dsh-vision-bridge] synthetic providerId "${providerId}" must not equal visionProvider (vision calls would recurse into the wrapper)`)
  }
  return { upstreamProvider, visionProvider, visionModel, providerId }
}

/** Positively-confirmed text-only: declares text, does not declare image. */
export function isPositivelyTextOnly(info: Pick<LlmModelInfoLike, 'inputModalities'>): boolean {
  const m = info.inputModalities
  return Array.isArray(m) && m.includes('text') && !m.includes('image')
}

/** Image-capable: positively declares image input. */
export function isImageCapable(info: Pick<LlmResolvedModelInfoLike, 'inputModalities'>): boolean {
  const m = info.inputModalities
  return Array.isArray(m) && m.includes('image')
}

export function apply(ctx: BridgeContextLike, rawConfig: BridgeConfig = {} as BridgeConfig): void {
  const config = validateConfig(rawConfig)
  const { upstreamProvider, visionProvider, visionModel, providerId } = config
  // Stage 3B: fiber-local completed-value Evidence cache. The closure dies
  // with this apply, so config reload / disable / remove naturally destroy it.
  const cache = createEvidenceCache()

  const adapter: LlmAdapterLike = {
    providerInfo(provider) {
      return { id: provider, name: 'Vision Bridge' }
    },
    providerRetryPolicy() {
      return undefined
    },
    /**
     * Discovery path: catalog unavailability is NOT an execution failure.
     * If the upstream route is currently unavailable, log a diagnostic and
     * return an empty catalog (load-order tolerance, no re-sweep/polling).
     */
    async listModels(provider) {
      let upstreamModels: LlmModelInfoLike[]
      try {
        upstreamModels = await ctx.llm.listModels(upstreamProvider)
      } catch (error) {
        console.error(
          `[dsh-vision-bridge] upstream route "${upstreamProvider}" unavailable during catalog discovery: ${errText(error)}; catalog is empty until the route registers`,
        )
        return []
      }
      return upstreamModels.filter(isPositivelyTextOnly).map((model) => ({
        ...model,
        provider,
        name: `${model.name} (vision bridge)`,
        inputModalities: ['text', 'image'] as const,
      }))
    },
    /** Execution path: fail closed. Only positively-confirmed text-only wraps. */
    async resolveModel(provider, model, signal) {
      let info: LlmResolvedModelInfoLike
      try {
        info = await ctx.llm.resolveModelInfo(upstreamProvider, model, signal)
      } catch (error) {
        throw new Error(
          `[dsh-vision-bridge] upstream route "${upstreamProvider}" cannot resolve model "${model}": ${errText(error)}`,
        )
      }
      if (!isPositivelyTextOnly(info)) {
        throw new Error(
          `[dsh-vision-bridge] upstream model "${model}" is not positively-confirmed text-only (inputModalities=${JSON.stringify(info.inputModalities ?? null)}); wrapping refused`,
        )
      }
      return {
        ...info,
        provider,
        id: model,
        name: `${info.name} (vision bridge)`,
        inputModalities: ['text', 'image'] as const,
      }
    },
    stream(options) {
      return bridgeStream(ctx, options, { upstreamProvider, visionProvider, visionModel }, cache)
    },
  }

  // DUPLICATE_ADAPTER or invalid metadata throws here — loud, by design.
  ctx.llm.registerAdapter([providerId], adapter)
}

async function* bridgeStream(
  ctx: BridgeContextLike,
  options: GenerateOptionsLike,
  routes: { upstreamProvider: string; visionProvider: string; visionModel: string },
  cache: EvidenceCache,
): AsyncGenerator<StreamChunkLike> {
  const signal = options.signal
  throwIfAborted(signal)
  const messages: MessageLike[] = []
  // Stage 3A: work units are analyzed SERIALly in traversal order (one
  // Vision call at a time — no Promise.all, no overlap). The upstream
  // dispatch happens only after the whole outgoing message set converted
  // successfully, so no partially transformed request ever reaches upstream.
  // Stage 3B: the Evidence cache is session-partitioned by options.sessionId;
  // missing/invalid sessionId bypasses the cache entirely.
  const state: ConversionState = { cache, sessionId: options.sessionId }
  for (const message of options.messages) {
    throwIfAborted(signal)
    const content = await convertContent(ctx, routes, state, message.content, signal)
    messages.push({ ...message, content })
  }
  throwIfAborted(signal)
  yield* ctx.llm.stream({ ...options, provider: routes.upstreamProvider, messages })
}

/** Shared per-request conversion state (lazy vision-route verification + cache). */
interface ConversionState {
  visionInfo?: LlmResolvedModelInfoLike
  cache: EvidenceCache
  sessionId: unknown
}

/** Opaque durable attachment identity: the complete string, never parsed. */
function imageAttachmentId(block: ImageBlockLike): string | undefined {
  const id = (block?.attachment as { attachmentId?: unknown } | undefined)?.attachmentId
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}

/** Fail closed on vision route unavailable / unknown / text-only. */
async function resolveVisionRoute(
  ctx: BridgeContextLike,
  routes: { visionProvider: string; visionModel: string },
  signal?: AbortSignal,
): Promise<LlmResolvedModelInfoLike> {
  let info: LlmResolvedModelInfoLike
  try {
    info = await ctx.llm.resolveModelInfo(routes.visionProvider, routes.visionModel, signal)
  } catch (error) {
    throw new Error(
      `[dsh-vision-bridge] vision route "${routes.visionProvider}" cannot resolve model "${routes.visionModel}": ${errText(error)}`,
    )
  }
  if (!isImageCapable(info)) {
    throw new Error(
      `[dsh-vision-bridge] vision model "${routes.visionModel}" on route "${routes.visionProvider}" is not positively-confirmed image-capable (inputModalities=${JSON.stringify(info.inputModalities ?? null)}); failing closed`,
    )
  }
  return info
}

/**
 * Stage 3A recursive content-array transformation (pure, non-mutating).
 * Grouping algorithm — every content array is processed with the same rules:
 * 1. walk blocks in array order;
 * 2. a tool-result block is a boundary: flush the preceding ordinary run,
 *    recursively transform the tool-result's own content array with this same
 *    algorithm, and clone the outer block (type/toolCallId/isError preserved);
 * 3. nested tool-results are never flattened and never merged across
 *    boundaries or messages;
 * 4. each maximal consecutive run of non-tool-result blocks is a container:
 *    0 images → passed through; 1 image → sealed single-image conversion;
 *    >= 2 images → one multi-image batch (atomic analyze-then-build).
 */
async function convertContent(
  ctx: BridgeContextLike,
  routes: { upstreamProvider: string; visionProvider: string; visionModel: string },
  state: ConversionState,
  blocks: ContentBlockLike[],
  signal?: AbortSignal,
): Promise<ContentBlockLike[]> {
  const out: ContentBlockLike[] = []
  let run: ContentBlockLike[] = []
  const flush = async (): Promise<void> => {
    if (run.length === 0) return
    const images = run.filter((block) => block?.type === 'image') as ImageBlockLike[]
    if (images.length === 0) {
      out.push(...run)
    } else {
      // Stage 3B: cache key covers the whole work unit; eligibility is a
      // performance condition — ineligible units simply bypass the cache.
      const attachmentIds = images.map(imageAttachmentId)
      const eligible = attachmentIds.every((id) => id !== undefined)
        && isCacheEligible(state.sessionId, attachmentIds as string[])
      const key = eligible
        ? buildEvidenceCacheKey({
          sessionId: state.sessionId as string,
          visionProvider: routes.visionProvider,
          visionModel: routes.visionModel,
          orderedAttachmentIds: attachmentIds as string[],
        })
        : undefined
      if (images.length === 1) {
        const block = images[0]!
        const cached = key === undefined ? undefined : state.cache.get(key)
        let evidence: unknown
        if (cached !== undefined) {
          evidence = cached
        } else {
          if (state.visionInfo === undefined) {
            state.visionInfo = await resolveVisionRoute(ctx, routes, signal)
          }
          evidence = await analyzeSingleEvidence(ctx, routes, block, signal)
          if (key !== undefined) state.cache.insertIfAbsent(key, evidence)
        }
        // Sealed Stage 1/1R single-image path: replace the image in place
        // with the single Evidence block. No anchors — on HIT or MISS.
        for (const block of run) {
          if (block?.type === 'image') {
            out.push(singleEvidenceBlock(evidence))
          } else {
            out.push(block)
          }
        }
      } else {
        out.push(...await analyzeMultiImageRun(ctx, routes, state, run, images, signal, key))
      }
    }
    run = []
  }
  for (const block of blocks) {
    throwIfAborted(signal)
    if (block?.type === 'tool-result') {
      await flush()
      const toolResult = block as ToolResultBlockLike
      const content = await convertContent(ctx, routes, state, toolResult.content, signal)
      out.push({ ...toolResult, content })
    } else {
      run.push(block)
    }
  }
  await flush()
  return out
}

/**
 * Sealed Stage 1/1R single-image analysis: one Vision invocation for one
 * ImageBlock occurrence, strict JSON Evidence contract. Returns the
 * validated canonical Evidence (Stage 3B caches this exact value).
 */
async function analyzeSingleEvidence(
  ctx: BridgeContextLike,
  routes: { visionProvider: string; visionModel: string },
  block: ImageBlockLike,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal)
  const text = await collectChunks(
    ctx.llm.stream({
      provider: routes.visionProvider,
      model: routes.visionModel,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: VISION_PROMPT }, block],
        },
      ],
      signal,
    }),
    signal,
  )
  const parsed = parseJsonStrict(text)
  const check = validateEvidence(parsed)
  if (!check.ok) {
    throw new Error(`[dsh-vision-bridge] vision evidence failed validation: ${check.violations.join(', ')}`)
  }
  return check.value
}

/** Sealed single-image evidence block (boundary + whitelist projection). */
function singleEvidenceBlock(evidence: unknown): ContentBlockLike {
  return {
    type: 'text',
    text: `${EVIDENCE_BOUNDARY}\n\n${renderEvidence(evidence as { summary: string; ocr?: { full_text?: string }; uncertainty?: string[] })}`,
  }
}

/**
 * v0.2.1 schema robustness: ONE shared multi output-contract retry budget.
 * The total number of multi Vision invocations per work unit is bounded by
 * this constant — strict JSON parse failure and multi Evidence validation
 * failure both consume the SAME budget. There is no separate parse budget
 * and schema budget, and no structural path to a third attempt.
 */
const MAX_MULTI_ATTEMPTS = 2

/**
 * Internal typed classification of ONE completed multi attempt. A completed
 * attempt is one whose provider stream finished normally (finish stop,
 * non-empty text) — provider/transport/stream failures never produce an
 * outcome; they THROW out of collectMultiAttempt unchanged. Retry branching
 * is decided on this discriminated union, never on exception message text.
 */
type MultiAttemptOutcome =
  | { kind: 'valid'; evidence: MultiVisionEvidence }
  | { kind: 'parse-failure'; error: VisionJsonParseError }
  | { kind: 'validation-failure'; violations: string[] }

/**
 * Stage 3A multi-image PHASE A (v0.2.1 schema robustness): bounded
 * MAX_MULTI_ATTEMPTS loop with ONE shared output-contract retry budget. Each
 * iteration is a COMPLETELY FRESH observation: same prompt, same images,
 * same order, same route/model, same AbortSignal, temperature 0. Attempt
 * text is strictly parsed and strictly validated; invalid attempt output is
 * discarded wholesale and NEVER fed into a later attempt.
 *
 * - provider/transport/stream failure -> throws immediately, never retried
 * - strict parse failure              -> consumes the shared budget
 * - multi Evidence validation failure -> consumes the SAME shared budget
 * - valid                             -> returns canonical Evidence immediately
 * - final-attempt failure             -> throws the matching exhausted error
 *   (VisionJsonParseError or VisionEvidenceValidationError)
 *
 * There is no Attempt 3: the loop is bounded by MAX_MULTI_ATTEMPTS and every
 * terminal branch returns or throws at the final iteration. Any failure
 * means nothing downstream is built and nothing is cached.
 */
async function analyzeMultiEvidence(
  ctx: BridgeContextLike,
  routes: { visionProvider: string; visionModel: string },
  images: ImageBlockLike[],
  signal?: AbortSignal,
): Promise<MultiVisionEvidence> {
  for (let attempt = 1; attempt <= MAX_MULTI_ATTEMPTS; attempt++) {
    // Runs before Attempt 1 AND between a failed attempt and the next one —
    // a caller abort after Attempt 1 prevents Attempt 2 from ever starting.
    throwIfAborted(signal)
    const outcome = await collectMultiOutcome(ctx, routes, images, signal)
    if (outcome.kind === 'valid') return outcome.evidence
    if (attempt === MAX_MULTI_ATTEMPTS) {
      if (outcome.kind === 'parse-failure') {
        throw new VisionJsonParseError(
          `[dsh-vision-bridge] vision output is not valid JSON (retry exhausted): ${errText(outcome.error.cause ?? outcome.error)}`,
          { cause: outcome.error, retryExhausted: true },
        )
      }
      throw new VisionEvidenceValidationError(outcome.violations)
    }
    // attempt < MAX_MULTI_ATTEMPTS: discard this attempt completely and make
    // one fresh observation with the shared budget's remaining allowance.
  }
  // Unreachable by construction — every terminal branch above either returns
  // or throws at the final iteration of the bounded loop.
  throw new Error('[dsh-vision-bridge] internal error: multi retry loop exited without a classification')
}

/**
 * v0.2.1 multi-image attempt abstraction: ONE Vision invocation carrying all
 * images of the run in traversal order, temperature 0 (MULTI ONLY — the
 * sealed single-image path never forces temperature), consumed to exact
 * text. Stream-level failures (aborted/error/tool-calls/missing finish/empty)
 * throw their existing errors unchanged — they are NOT output-contract
 * failures and never trigger the shared retry budget.
 *
 * v0.2.3 candidate (multi-image cardinality root-cause fix): the message
 * content interleaves an explicit per-attachment boundary label ("Image i of
 * N:") immediately BEFORE each ImageBlock. Real-provider evidence (v021
 * real-gate capture) showed the vision model intermittently merging two
 * visually-adjacent same-class attachments (e.g. two dock screenshots) into
 * ONE images[] entry — "images.length (expected 2, got 1)" — even though
 * every layer forwards both ImageBlocks. The labels anchor each attachment
 * as a separate input so the model no longer reads adjacent images as one
 * composite. Image order, the one-call batching contract, temperature 0,
 * and the retry/validation semantics are unchanged; the single-image path
 * is untouched.
 */
async function collectMultiAttempt(
  ctx: BridgeContextLike,
  routes: { visionProvider: string; visionModel: string },
  images: ImageBlockLike[],
  signal?: AbortSignal,
): Promise<string> {
  const content: ContentBlockLike[] = [{ type: 'text', text: VISION_PROMPT_MULTI }]
  for (const [index, block] of images.entries()) {
    content.push({ type: 'text', text: `Image ${index + 1} of ${images.length}:` }, block)
  }
  return collectChunks(
    ctx.llm.stream({
      provider: routes.visionProvider,
      model: routes.visionModel,
      temperature: 0,
      messages: [{ role: 'user', content }],
      signal,
    }),
    signal,
  )
}

/**
 * Strict-parse one MULTI attempt's text (v0.2.1). Returns the parsed value or
 * the typed parse failure — the parse outcome is distinguishable from every
 * other failure class (schema, provider, transport, cancellation, finish
 * state). This is the ONLY call site that enables the design-reviewed
 * multi-only leading-U+200B envelope tolerance; the sealed single-image path
 * keeps the default (no tolerance).
 */
function tryParseStrict(text: string): unknown | VisionJsonParseError {
  try {
    return parseJsonStrict(text, { tolerateLeadingZwsp: true })
  } catch (error) {
    if (error instanceof VisionJsonParseError) return error
    throw error
  }
}

/**
 * Collect, strictly parse, and strictly validate ONE fresh multi attempt,
 * classifying the result as a typed outcome. Never throws for output-contract
 * violations (parse/validation) — those become typed outcomes; it only
 * propagates provider/transport/stream/cancellation errors from the collect
 * phase unchanged.
 */
async function collectMultiOutcome(
  ctx: BridgeContextLike,
  routes: { visionProvider: string; visionModel: string },
  images: ImageBlockLike[],
  signal?: AbortSignal,
): Promise<MultiAttemptOutcome> {
  const text = await collectMultiAttempt(ctx, routes, images, signal)
  const parsed = tryParseStrict(text)
  if (parsed instanceof VisionJsonParseError) {
    return { kind: 'parse-failure', error: parsed }
  }
  const check = validateMultiEvidence(parsed, images.length)
  if (check.ok) return { kind: 'valid', evidence: check.value }
  return { kind: 'validation-failure', violations: check.violations }
}

/**
 * Stage 3A multi-image PHASE B: construct the transformed run from
 * validated canonical Evidence — non-image blocks keep their value and
 * relative order, every ImageBlock is replaced IN PLACE by a `[Image n]`
 * anchor (n = 1-based traversal position, shared with Vision input order
 * and Evidence indexes), and exactly ONE rendered batch Evidence block is
 * appended at the end of the run. Identical on cache HIT and MISS.
 */
function buildMultiWire(run: ContentBlockLike[], evidence: MultiVisionEvidence): ContentBlockLike[] {
  let n = 0
  const out: ContentBlockLike[] = []
  for (const block of run) {
    if (block?.type === 'image') {
      n += 1
      out.push({ type: 'text', text: `[Image ${n}]` })
    } else {
      out.push(block)
    }
  }
  out.push({ type: 'text', text: renderMultiEvidence(evidence) })
  return out
}

/**
 * Stage 3A/3B multi-image work unit (content-container batch).
 * HIT: skip Vision entirely and run the SAME PHASE B wire transformation
 * with the cached canonical Multi Evidence. MISS: PHASE A (Vision → parse →
 * validate) then insert-if-absent (first successful completed insert wins;
 * a redundant concurrent completion never overwrites) and use the caller's
 * OWN validated Evidence for the current request. Failures and cancellations
 * never reach the insert.
 */
async function analyzeMultiImageRun(
  ctx: BridgeContextLike,
  routes: { visionProvider: string; visionModel: string },
  state: ConversionState,
  run: ContentBlockLike[],
  images: ImageBlockLike[],
  signal?: AbortSignal,
  key?: string,
): Promise<ContentBlockLike[]> {
  throwIfAborted(signal)
  const cached = key === undefined ? undefined : state.cache.get(key)
  let evidence: MultiVisionEvidence
  if (cached !== undefined) {
    evidence = cached as MultiVisionEvidence
  } else {
    if (state.visionInfo === undefined) {
      state.visionInfo = await resolveVisionRoute(ctx, routes, signal)
    }
    evidence = await analyzeMultiEvidence(ctx, routes, images, signal)
    if (key !== undefined) state.cache.insertIfAbsent(key, evidence)
  }
  return buildMultiWire(run, evidence)
}

/**
 * Recursive traversal (adapted from ModLens): image blocks convert; images
 * nested inside tool-result content convert too; everything else passes
 * through. Failures THROW — no explanatory-text continuation.
 */
export function contentHasImage(blocks: unknown): blocks is ContentBlockLike[] {
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (b) =>
        b?.type === 'image' ||
        (b?.type === 'tool-result' && contentHasImage((b as { content?: unknown }).content)),
    )
  )
}

/* ------------------------------------------------------------------ */
/* StreamChunk accumulator contract (final rules)                       */
/*                                                                      */
/* Per index: deltaBuffer + seenTextDelta. ensureIndex() registers       */
/* first-observed order on block-start, text-delta, and block-end —      */
/* block-start is NEVER assumed to arrive first.                         */
/*                                                                      */
/* - text-delta:  ensureIndex, seenTextDelta=true, append               */
/* - block-end:   ensureIndex; non-text blocks contribute nothing;       */
/*                text blocks contribute block.text ONLY when no delta   */
/*                was seen for that index (assembled-block fallback)     */
/* - reasoning-delta / tool-call-delta / usage: ignored                 */
/* - finish:      stop -> assemble; aborted -> throw; error -> throw;    */
/*                tool-calls -> throw (vision route must not tool-call)  */
/* - stream end without finish -> throw                                 */
/* - assembled empty text -> throw (empty response fails closed)        */
/* ------------------------------------------------------------------ */

interface IndexState {
  deltaBuffer: string
  seenTextDelta: boolean
}

export async function collectChunks(
  stream: AsyncIterable<StreamChunkLike>,
  signal?: AbortSignal,
): Promise<string> {
  const order: number[] = []
  const states = new Map<number, IndexState>()
  const ensureIndex = (index: number): IndexState => {
    let state = states.get(index)
    if (state === undefined) {
      state = { deltaBuffer: '', seenTextDelta: false }
      states.set(index, state)
      order.push(index)
    }
    return state
  }

  let finish:
    | { kind: 'stop' }
    | { kind: 'tool-calls' }
    | { kind: 'aborted'; failure: { message: string } }
    | { kind: 'error'; failure: { message: string } }
    | undefined

  for await (const chunk of stream) {
    throwIfAborted(signal)
    switch (chunk.type) {
      case 'block-start': {
        ensureIndex(chunk.index)
        break
      }
      case 'text-delta': {
        const state = ensureIndex(chunk.index)
        state.seenTextDelta = true
        state.deltaBuffer += chunk.text
        break
      }
      case 'block-end': {
        const state = ensureIndex(chunk.index)
        const block = chunk.block as { type?: string; text?: unknown } | undefined
        if (block?.type === 'text' && !state.seenTextDelta) {
          state.deltaBuffer = typeof block.text === 'string' ? block.text : ''
        }
        break
      }
      case 'reasoning-delta':
      case 'tool-call-delta':
      case 'usage':
        break
      case 'finish': {
        finish = chunk.reason
        break
      }
      default:
        // Merge-extensible chunk types: ignore.
        break
    }
  }

  if (finish === undefined) {
    if (signal?.aborted) {
      throw abortError(signal)
    }
    throw new Error('[dsh-vision-bridge] vision stream ended without a finish chunk; failing closed')
  }
  switch (finish.kind) {
    case 'stop':
      break
    case 'aborted':
      throw new Error(`[dsh-vision-bridge] vision stream aborted: ${finish.failure.message}`)
    case 'error':
      throw new Error(`[dsh-vision-bridge] vision stream error: ${finish.failure.message}`)
    case 'tool-calls':
      throw new Error('[dsh-vision-bridge] vision stream finished with tool-calls; the vision route must not call tools; failing closed')
  }

  const text = order.map((index) => states.get(index)!.deltaBuffer).join('')
  if (text.trim() === '') {
    throw new Error('[dsh-vision-bridge] vision stream produced no text; failing closed')
  }
  return text
}

/**
 * Internal parse-failure discriminator (v0.2.1). Thrown ONLY when strict
 * JSON parsing fails (parseJsonStrict → JSON.parse) after the Vision stream
 * completed normally at the provider/stream level. Multi-attempt branching
 * is decided on `instanceof` this class or the MultiAttemptOutcome union —
 * never on message-text matching. Internal ONLY: not exported, not part of
 * the public plugin API contract (public v0.2.0 never exported it);
 * deterministic tests observe the stable message prefix and the
 * retry-exhaustion marker instead of class identity.
 */
class VisionJsonParseError extends Error {
  /** True when BOTH attempts failed strict parsing (retry exhausted). */
  readonly retryExhausted: boolean
  constructor(message: string, options: { cause?: unknown; retryExhausted?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'VisionJsonParseError'
    this.retryExhausted = options.retryExhausted ?? false
  }
}

/**
 * Internal multi-Evidence validation-failure discriminator (v0.2.1 schema
 * robustness). Thrown ONLY when the FINAL multi attempt parsed successfully
 * but failed validateMultiEvidence — by construction a multi validation
 * failure can only surface after the shared retry budget is exhausted, so
 * retryExhausted is always true and scope is always 'multi'. Internal ONLY:
 * not exported; deterministic tests observe the stable message substring
 * ("vision evidence failed validation") and the exhaustion marker. The
 * sealed single-image path keeps its plain-Error validation failure.
 */
class VisionEvidenceValidationError extends Error {
  readonly scope = 'multi' as const
  readonly retryExhausted = true as const
  /** Machine-readable validator violation paths (internal diagnostics). */
  readonly violations: readonly string[]
  constructor(violations: readonly string[]) {
    super(`[dsh-vision-bridge] vision evidence failed validation (retry exhausted): ${violations.join(', ')}`)
    this.name = 'VisionEvidenceValidationError'
    this.violations = violations
  }
}

/**
 * Sealed strict parser policy (v0.2.0, retained verbatim): trim whitespace,
 * tolerate ONE existing outer Markdown code fence, JSON.parse. No
 * normalization, no repair, no prefix/ellipsis/prose stripping, no regex
 * extraction, no JSON5. Failures throw the typed {@link VisionJsonParseError}
 * with the v0.2.0-compatible message prefix.
 *
 * v0.2.1 U+200B envelope-noise disposition (design-reviewed): the MULTI-image
 * path additionally enables ONE bounded syntactic envelope tolerance — strip
 * a leading run of U+200B ZERO WIDTH SPACE from the parse input, exactly once,
 * after the existing trim + fence handling and immediately before JSON.parse.
 * The justification is POSITION-BOUND: U+200B is removed only when it occurs
 * outside the JSON value, at position 0 of the post-envelope parse input; a
 * U+200B inside the JSON value (strings/tokens) is never touched. The
 * remaining input must still be ONE complete JSON value accepted by strict
 * JSON.parse, and the sealed Evidence validator remains authoritative. This
 * is syntactic envelope tolerance, NOT semantic Evidence repair. The
 * single-image path keeps tolerateLeadingZwsp at its default (false) — the
 * sealed Stage 1/1R behavior is unchanged.
 */
function parseJsonStrict(
  text: string,
  options: { tolerateLeadingZwsp?: boolean } = {},
): unknown {
  const trimmed = text.trim()
  let candidate = trimmed
  if (candidate.startsWith('```')) {
    const firstNewline = candidate.indexOf('\n')
    const fenceEnd = candidate.lastIndexOf('```')
    if (firstNewline !== -1 && fenceEnd > firstNewline) {
      candidate = candidate.slice(firstNewline + 1, fenceEnd).trim()
    }
  }
  if (options.tolerateLeadingZwsp === true) {
    // Multi-only bounded envelope tolerance (U+200B only, leading run only,
    // exactly once). Anchored at position 0 of the post-envelope candidate:
    // it can never alter U+200B inside the JSON value.
    candidate = candidate.replace(/^\u200B+/, '')
  }
  try {
    return JSON.parse(candidate)
  } catch (error) {
    throw new VisionJsonParseError(`[dsh-vision-bridge] vision output is not valid JSON: ${errText(error)}`, { cause: error })
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  if (reason !== undefined) return new Error(String(reason))
  return new Error('[dsh-vision-bridge] request aborted')
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
