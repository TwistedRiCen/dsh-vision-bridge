/**
 * Narrow structural interfaces for the exact DSH runtime surface this plugin
 * consumes — llm only. The production plugin never reads raw attachment bytes:
 * ImageBlocks are passed through to the configured vision route, whose own
 * adapter resolves bytes via the attachment service.
 *
 * Every interface below was verified against DSH checkout commit
 * 47f943859bef60e4160492346772ded9b24f765a:
 * - LlmRuntime methods:  packages/llm/llm/src/index.ts
 *     registerAdapter (338), listModels (581), resolveModelInfo (619), stream (913)
 * - LlmAdapter contract: packages/llm/llm/src/index.ts (180-233)
 * - GenerateOptions / LlmModelInfo / LlmResolvedModelInfo / LlmProviderInfo /
 *   ContentBlock vocabulary / StreamChunk:
 *     packages/llm/llm/src/types.ts (53-105, 143-149, 233-281, 291-356)
 *
 * Deliberately NOT cloned: the full DSH type system. Only the consumed shape.
 */

export type ModelModality = 'text' | 'image'

export interface LlmProviderInfoLike {
  id: string
  name: string
}

export interface LlmModelInfoLike {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly ModelModality[]
}

export interface LlmResolvedModelInfoLike extends LlmModelInfoLike {
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: { efforts: readonly { id: string; name: string }[]; defaultEffort?: string }
}

/** DSH ImageBlock: `{ type:'image'; attachment: ImageAttachmentRef }`. The
 * attachment ref is opaque to this plugin and is only ever passed through. */
export interface ImageBlockLike {
  type: 'image'
  attachment: unknown
}

export interface TextBlockLike {
  type: 'text'
  text: string
}

export interface ToolResultBlockLike {
  type: 'tool-result'
  toolCallId?: string
  content: ContentBlockLike[]
  isError?: boolean
}

/** Merge-extensible content vocabulary; unknown block types pass through. */
export type ContentBlockLike = TextBlockLike | ImageBlockLike | ToolResultBlockLike | { type: string; [key: string]: unknown }

export interface MessageLike {
  role: string
  content: ContentBlockLike[]
  [key: string]: unknown
}

export interface GenerateOptionsLike {
  provider: string
  model: string
  messages: MessageLike[]
  system?: string
  tools?: unknown[]
  signal?: AbortSignal
  [key: string]: unknown
}

/** StreamChunk union per packages/llm/llm/src/types.ts (291-303). */
export type StreamChunkLike =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlockLike }
  | { type: 'usage'; usage: unknown }
  | {
    type: 'finish'
    reason:
      | { kind: 'stop' }
      | { kind: 'tool-calls' }
      | { kind: 'aborted'; failure: { message: string; code?: string } }
      | { kind: 'error'; failure: { message: string; code?: string } }
  }

/** The adapter this plugin registers (duck-typed LlmAdapter plain object). */
export interface LlmAdapterLike {
  providerInfo(provider: string): LlmProviderInfoLike
  providerRetryPolicy(provider: string): unknown
  listModels(provider: string): Promise<readonly LlmModelInfoLike[]>
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfoLike>
  stream(options: GenerateOptionsLike): AsyncIterable<StreamChunkLike>
}

/** registerAdapter returns a disposer handle; the DSH registry already binds
 * the registration to the calling fiber (ctx.effect), so the handle is kept
 * for symmetry but disposal rides fiber teardown. */
export type AdapterRegistrationHandleLike = (() => void) & { replace?: (providers: string[]) => void }

/** The llm service subset consumed (verified against index.ts anchors above). */
export interface LlmRuntimeLike {
  registerAdapter(providers: string[], adapter: LlmAdapterLike): AdapterRegistrationHandleLike
  /** Describe registered provider routes in registration order (synchronous). */
  listProviders(): LlmProviderInfoLike[]
  listModels(provider: string): Promise<LlmModelInfoLike[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfoLike>
  stream(options: GenerateOptionsLike): AsyncIterable<StreamChunkLike>
}

/** cordis context shape consumed by apply(). */
export interface BridgeContextLike {
  llm: LlmRuntimeLike
}
