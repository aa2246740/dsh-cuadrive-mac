import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { JsonSchemaNode, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { imageRefFromValue, type CuaImageValue } from './images.ts'

/** Canonical value every cua_* driver call returns. */
export interface CuaCallValue {
  tool: string
  text: string
  data: JsonValue
  images: CuaImageValue[]
}

const IMAGE_PROPERTIES = {
  attachmentId: { type: 'string' as const, required: true },
  mediaType: {
    type: 'string' as const,
    enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
    required: true,
  },
  bytes: { type: 'integer' as const, required: true },
  width: { type: 'integer' as const, required: true },
  height: { type: 'integer' as const, required: true },
  name: { type: 'string' as const },
} as const

/** defineTool DSL for host tools (`cua_call`). */
export const CUA_OUTPUT_DSL = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    tool: { type: 'string' as const, required: true as const },
    text: { type: 'string' as const, required: true as const },
    data: { type: 'json' as const, required: true as const },
    images: {
      type: 'array' as const,
      required: true as const,
      items: {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: IMAGE_PROPERTIES,
      },
    },
  },
} as const satisfies ValueSchemaSpec

/** Raw JSON Schema for `ctx.tools.register` (assertSupportedJsonSchema). */
export const CUA_OUTPUT_JSON: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'text', 'data', 'images'],
  properties: {
    tool: { type: 'string' },
    text: { type: 'string' },
    data: {},
    images: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          name: { type: 'string' },
        },
      },
    },
  },
}

/** Native/model projection: JSON text plus any committed screenshots. */
export function renderCuaValue(_args: unknown, value: CuaCallValue): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
  for (const image of value.images) {
    blocks.push({ type: 'image', attachment: imageRefFromValue(image) })
  }
  return blocks
}

/** Build the canonical call value from driver JSON plus optional notes/images. */
export function cuaCallValue(
  tool: string,
  data: unknown,
  extras: { images?: CuaImageValue[], notes?: string[] } = {},
): CuaCallValue {
  const images = extras.images ?? []
  const json = asJsonValue(data)
  const parts = [typeof json === 'string' ? json : JSON.stringify(json, null, 2)]
  if (extras.notes && extras.notes.length > 0) parts.push(extras.notes.join('\n'))
  return { tool, text: parts.join('\n'), data: json, images }
}

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
