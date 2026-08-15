/**
 * Stage 3B completed-value Evidence cache: fiber-local, in-memory,
 * session-partitioned, bounded LRU. No shared promises, no single-flight,
 * no request coalescing, no persistence. Only successfully parsed and
 * validated Evidence is ever inserted; failures and cancellations are
 * never cached. Cached Evidence remains UNTRUSTED OBSERVED DATA — the
 * sealed renderer and trust boundary still apply on every hit.
 *
 * @module dsh-vision-bridge/cache
 */

import { EVIDENCE_POLICY_VERSION } from './schema.js'

/** Internal completed-work-unit capacity (max-entries only in this MVP). */
export const EVIDENCE_CACHE_CAPACITY = 32

export interface EvidenceCacheKeyInput {
  /** DSH GenerateOptions.sessionId — cache sharing is session-scoped. */
  sessionId: string
  visionProvider: string
  visionModel: string
  /** Durable attachment ids in work-unit traversal order; order is semantic. */
  orderedAttachmentIds: string[]
}

/**
 * Collision-safe structural key encoding: a JSON array, never delimiter
 * concatenation. Order is semantic ([A,B] != [B,A]) and attachment ids are
 * treated as opaque strings (their internals are never parsed).
 */
export function buildEvidenceCacheKey(input: EvidenceCacheKeyInput): string {
  return JSON.stringify([
    EVIDENCE_POLICY_VERSION,
    input.sessionId,
    input.visionProvider,
    input.visionModel,
    input.orderedAttachmentIds,
  ])
}

/**
 * Cache eligibility. A work unit is eligible only with a valid non-empty
 * sessionId and valid non-empty attachment ids for every image. Any
 * ineligibility BYPASSES the cache (normal Vision analysis, no lookup, no
 * insert) — cache inability is a performance condition, never a Vision
 * correctness failure.
 */
export function isCacheEligible(sessionId: unknown, attachmentIds: readonly unknown[]): sessionId is string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return false
  if (attachmentIds.length === 0) return false
  return attachmentIds.every((id) => typeof id === 'string' && id.trim() !== '')
}

/**
 * Recursive deep-freeze for JSON-compatible values (acyclic by construction).
 * No dependency: validated Evidence is ordinary parsed JSON.
 */
export function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const key of Object.keys(value as object)) {
    deepFreezeJson((value as Record<string, unknown>)[key])
  }
  return value
}

export interface EvidenceCache {
  /** Return the frozen canonical value for key, refreshing recency; undefined on miss. */
  get(key: string): unknown
  /** Insert only when absent (first successful completed insert wins). Returns true when inserted. */
  insertIfAbsent(key: string, value: unknown): boolean
  clear(): void
  size(): number
}

/**
 * Bounded Map-based LRU of completed Evidence. `get` refreshes recency;
 * `insertIfAbsent` deep-freezes the value, never overwrites an existing
 * entry, and evicts the least-recently-used entry when full. The cache is
 * created inside the Bridge apply closure, so it becomes unreachable when
 * the Bridge fiber is unloaded (config reload / disable / remove).
 */
export function createEvidenceCache(capacity: number = EVIDENCE_CACHE_CAPACITY): EvidenceCache {
  const entries = new Map<string, unknown>()
  const get = (key: string): unknown => {
    const value = entries.get(key)
    if (value === undefined) return undefined
    entries.delete(key)
    entries.set(key, value)
    return value
  }
  const insertIfAbsent = (key: string, value: unknown): boolean => {
    if (entries.has(key)) return false
    const frozen = deepFreezeJson(value)
    if (entries.size >= capacity) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) entries.delete(oldest)
    }
    entries.set(key, frozen)
    return true
  }
  const clear = (): void => {
    entries.clear()
  }
  const size = (): number => entries.size
  return { get, insertIfAbsent, clear, size }
}
