/**
 * Evidence contract for Stage 1 — retains the ModLens v2 concepts:
 * summary, ocr, layout, semantics, visual, uncertainty.
 * bbox and numeric confidence MUST NOT be introduced (models fabricate them).
 *
 * Provenance (Class B, adapted): field contract per
 * @liustack/modlens v3.16.6 `dsh/vision-schema.json` / `src/schema.ts`
 * (MIT, (c) Leon Liu), re-authored as a local TypeScript constant; the
 * validator walk is the same idea, re-implemented against this constant.
 * See THIRD_PARTY_NOTICES.md.
 */

/**
 * Stage 3B Evidence cache policy version. Participates in every cache key.
 * BUMP when Vision Evidence semantics change, including: VISION_PROMPT /
 * VISION_PROMPT_MULTI wording, the Evidence schema, validator/tolerance
 * semantics, image ordering/index semantics, or any future question-context
 * policy. Do NOT bump for renderer wording/projection-only changes, anchor
 * wording, config/lifecycle changes, build tooling, or package-version-only
 * changes. Never use the package.json version as cache identity.
 *
 * v0.2.1: bumped 1 -> 2 — VISION_PROMPT_MULTI output-envelope hardening and
 * the multi-only generation policy (temperature: 0) intentionally change the
 * canonical multi-image Evidence.
 * v0.2.1 schema robustness: bumped 2 -> 3 — VISION_PROMPT_MULTI now mandates
 * attachment-local Evidence (exactly one images[] entry per DISTINCT
 * attachment; cross-attachment merging explicitly forbidden), changing the
 * canonical multi-image Evidence semantics again. A retry-policy-only change
 * would NOT bump; this prompt semantic change does.
 *
 * v0.2.3 candidate: bumped 3 -> 4 — the multi Vision request now interleaves
 * an explicit per-attachment boundary label ("Image i of N:") immediately
 * before each ImageBlock, changing what the vision model receives for the
 * same attachment set (anti-merge request construction), so canonical
 * multi-image Evidence semantics change.
 *
 * v0.2.5 candidate: bumped 4 -> 5 — the bounded leading-U+200B parse
 * tolerance (previously multi-only) is now also enabled on the single-image
 * path, changing the tolerance semantics under which single-image Evidence
 * can be accepted and cached.
 */
export const EVIDENCE_POLICY_VERSION = 5

/** The sealed single-image Evidence contract (Stage 1/1R). */
export interface VisionEvidence {
  summary: string
  ocr: {
    full_text: string
    lines: Array<{ text: string; language?: string }>
  }
  layout: {
    regions: Array<{ type: string; reading_order: number; text: string }>
  }
  semantics: {
    scene: string
    intent?: string
    entities: Array<{ name: string; type: string; evidence?: string }>
    relations?: Array<{ subject: string; predicate: string; object: string }>
  }
  visual: {
    dominant_colors?: string[]
    style?: string
    notes?: string[]
  }
  uncertainty: string[]
}

/** A normalized evidence value: null optionals dropped, required fields typed. */
export type ValidatedEvidence = VisionEvidence

export type EvidenceValidation =
  | { ok: true; value: ValidatedEvidence }
  | { ok: false; violations: string[] }

interface SchemaNode {
  type: 'object' | 'array' | 'string' | 'number'
  properties?: Record<string, SchemaNode>
  required?: readonly string[]
  items?: SchemaNode
}

/**
 * The local contract. Additional unknown properties are tolerated (forward
 * compatible); only declared fields are checked. Required fields match the
 * ModLens v2 contract exactly.
 */
const SCHEMA: SchemaNode = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    ocr: {
      type: 'object',
      properties: {
        full_text: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              language: { type: 'string' },
            },
            required: ['text'],
          },
        },
      },
      required: ['full_text', 'lines'],
    },
    layout: {
      type: 'object',
      properties: {
        regions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              reading_order: { type: 'number' },
              text: { type: 'string' },
            },
            required: ['type', 'reading_order', 'text'],
          },
        },
      },
      required: ['regions'],
    },
    semantics: {
      type: 'object',
      properties: {
        scene: { type: 'string' },
        intent: { type: 'string' },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              evidence: { type: 'string' },
            },
            required: ['name', 'type'],
          },
        },
        relations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              predicate: { type: 'string' },
              object: { type: 'string' },
            },
            required: ['subject', 'predicate', 'object'],
          },
        },
      },
      required: ['scene', 'entities'],
    },
    visual: {
      type: 'object',
      properties: {
        dominant_colors: { type: 'array', items: { type: 'string' } },
        style: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'ocr', 'layout', 'semantics', 'visual', 'uncertainty'],
}

/**
 * Validate one parsed evidence object. Returns the normalized value (null on
 * optional fields dropped — absent and null mean the same thing) or the list
 * of violated paths. Invalid evidence MUST NOT reach the downstream provider.
 */
export function validateEvidence(raw: unknown): EvidenceValidation {
  // Normalize first (null on optional fields dropped), then walk — absent and
  // null mean the same thing, while null on a required field still fails.
  const normalized = dropEmptyOptionals(raw, SCHEMA)
  const violations = walk(SCHEMA, normalized, '(root)')
  if (violations.length > 0) return { ok: false, violations }
  return { ok: true, value: normalized as ValidatedEvidence }
}

function walk(schema: SchemaNode, value: unknown, path: string): string[] {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [path]
      const record = value as Record<string, unknown>
      const violations: string[] = []
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        const childPath = path === '(root)' ? key : `${path}.${key}`
        const required = schema.required?.includes(key) ?? false
        if (!(key in record) || record[key] === undefined) {
          if (required) violations.push(childPath)
          continue
        }
        violations.push(...walk(child, record[key], childPath))
      }
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) return [path]
      if (!schema.items) return []
      return value.flatMap((item, index) => walk(schema.items!, item, `${path}[${index}]`))
    }
    case 'string':
      return typeof value === 'string' ? [] : [path]
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [path]
  }
}

/** Drop null on optional fields so "absent" and "null" mean the same thing. */
function dropEmptyOptionals(value: unknown, schema: SchemaNode): unknown {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const record = value as Record<string, unknown>
    const cleaned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      const child = schema.properties?.[key]
      const required = schema.required?.includes(key) ?? false
      if (entry === null && !required) continue
      cleaned[key] = child ? dropEmptyOptionals(entry, child) : entry
    }
    return cleaned
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    return value.map((item) => dropEmptyOptionals(item, schema.items!))
  }
  return value
}

/**
 * Stage 3A multi-image Evidence. `images[i].index` equals the 1-based
 * traversal position shared with the Vision input order, the `[Image n]`
 * anchors, and `relations[].imageIndexes`. The per-image fields are exactly
 * the sealed single-image contract; no bbox/confidence/coordinates.
 */
export interface MultiImageEvidenceEntry extends VisionEvidence {
  index: number
}

export interface CrossImageRelation {
  imageIndexes: number[]
  description: string
}

export interface MultiVisionEvidence {
  images: MultiImageEvidenceEntry[]
  relations: CrossImageRelation[]
}

export type MultiEvidenceValidation =
  | { ok: true; value: MultiVisionEvidence }
  | { ok: false; violations: string[] }

/**
 * Validate one complete multi-image batch Evidence against the expected input
 * image count N. Reuses the sealed single-image validator for every
 * `images[i]` entry (unknown extra fields follow the existing tolerance
 * policy), plus the multi invariants:
 * - images.length === N
 * - images[i].index === i + 1 (no missing, duplicate, or extra entries)
 * - relations may be []; each imageIndexes is an array of >= 2 distinct
 *   integers within 1..N; description is a non-empty string.
 * Any violation fails the whole batch closed.
 */
export function validateMultiEvidence(raw: unknown, imageCount: number): MultiEvidenceValidation {
  const violations: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, violations: ['(root)'] }
  }
  const record = raw as Record<string, unknown>
  const images = record.images
  if (!Array.isArray(images)) {
    return { ok: false, violations: ['images'] }
  }
  if (images.length !== imageCount) {
    violations.push(`images.length (expected ${imageCount}, got ${images.length})`)
  }
  const normalizedEntries: MultiImageEvidenceEntry[] = []
  images.forEach((entry, i) => {
    const expected = i + 1
    const entryCheck = validateEvidence(entry)
    if (!entryCheck.ok) {
      violations.push(...entryCheck.violations.map((violation) => `images[${i}].${violation}`))
      return
    }
    const value = entryCheck.value as VisionEvidence & { index?: unknown }
    if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index !== expected) {
      violations.push(`images[${i}].index (expected ${expected}, got ${JSON.stringify(value.index)})`)
      return
    }
    normalizedEntries.push({ ...value, index: value.index })
  })
  const relations = record.relations
  if (relations !== undefined && !Array.isArray(relations)) {
    violations.push('relations')
  }
  const normalizedRelations: CrossImageRelation[] = []
  if (Array.isArray(relations)) {
    relations.forEach((relation, i) => {
      if (typeof relation !== 'object' || relation === null || Array.isArray(relation)) {
        violations.push(`relations[${i}]`)
        return
      }
      const entry = relation as Record<string, unknown>
      const indexes = entry.imageIndexes
      const validIndexes = Array.isArray(indexes)
        && indexes.length >= 2
        && indexes.every((index) => typeof index === 'number' && Number.isInteger(index) && index >= 1 && index <= imageCount)
        && new Set(indexes.map(Number)).size === indexes.length
      if (!validIndexes) {
        violations.push(`relations[${i}].imageIndexes (needs >= 2 distinct integers within 1..${imageCount})`)
        return
      }
      if (typeof entry.description !== 'string' || entry.description.trim() === '') {
        violations.push(`relations[${i}].description`)
        return
      }
      normalizedRelations.push({ imageIndexes: indexes.map(Number), description: entry.description })
    })
  }
  if (violations.length > 0) return { ok: false, violations }
  return { ok: true, value: { images: normalizedEntries, relations: normalizedRelations } }
}
