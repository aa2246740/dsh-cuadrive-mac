/** Parsers for cua-driver CLI text and a DSH-safe JSON Schema subset. */

export interface ListedTool {
  name: string
  summary: string
}

export interface DescribedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface Frontmatter {
  name?: string
  description?: string
  body: string
}

const SCHEMA_KEEP = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

/** Split `cua-driver list-tools` `name: summary` lines. */
export function parseListTools(text: string): ListedTool[] {
  const tools: ListedTool[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue
    const name = trimmed.slice(0, colon).trim()
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) continue
    tools.push({ name, summary: trimmed.slice(colon + 1).trim() })
  }
  return tools
}

/** Parse `cua-driver describe <tool>` into name, prose, and input JSON Schema. */
export function parseDescribe(text: string): DescribedTool {
  const nameMatch = /^name:\s*(\S+)\s*$/m.exec(text)
  const name = nameMatch?.[1]
  if (name === undefined) throw new Error('cua-driver describe: missing name')
  const schemaMatch = /^input_schema:\s*$/m.exec(text)
  if (schemaMatch === null || schemaMatch.index === undefined) {
    throw new Error(`cua-driver describe ${name}: missing input_schema`)
  }
  const descriptionBlock = text.slice(0, schemaMatch.index)
  const description = descriptionBlock.replace(/^name:\s*\S+\s*/m, '').replace(/^description:\s*/m, '').trim()
  const schemaText = text.slice(schemaMatch.index + schemaMatch[0].length)
  const inputSchema = asSchemaObject(extractJson(schemaText), name)
  return { name, description, inputSchema }
}

/** Strip YAML frontmatter used by the official cua-driver SKILL.md. */
export function parseFrontmatter(raw: string): Frontmatter {
  if (!raw.startsWith('---')) return { body: raw }
  const newline = raw.indexOf('\n')
  if (newline < 0) return { body: raw }
  const rest = raw.slice(newline + 1)
  const end = rest.search(/\n---[ \t]*\r?\n/)
  if (end < 0) return { body: raw }
  const fm = rest.slice(0, end)
  const body = rest.slice(end).replace(/^\n---[ \t]*\r?\n/, '')
  return {
    name: matchField(fm, 'name'),
    description: matchField(fm, 'description'),
    body,
  }
}

/** Parse the first JSON value in `text`, ignoring leading prose. */
export function extractJson(text: string): unknown {
  const start = text.search(/[\[{]/)
  if (start < 0) throw new Error('expected JSON object or array')
  const slice = text.slice(start)
  try {
    return JSON.parse(slice)
  } catch {
    return JSON.parse(sliceFirstJson(slice))
  }
}

/**
 * Drop JSON Schema keywords DSH's tool registry does not enforce
 * (`minimum`, `pattern`, nested `additionalProperties` objects, …).
 */
export function sanitizeJsonSchema(input: unknown): Record<string, unknown> {
  if (!isPlainObject(input)) return { type: 'object', additionalProperties: true }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!SCHEMA_KEEP.has(key)) continue
    if (key === 'properties' && isPlainObject(value)) {
      const properties: Record<string, unknown> = {}
      for (const [name, node] of Object.entries(value)) {
        properties[name] = sanitizeJsonSchema(node)
      }
      out.properties = properties
    } else if (key === 'items') {
      out.items = sanitizeJsonSchema(value)
    } else if (key === 'oneOf' && Array.isArray(value) && value.length >= 2) {
      out.oneOf = value.map(item => sanitizeJsonSchema(item))
    } else if (key === 'additionalProperties') {
      out.additionalProperties = typeof value === 'boolean' ? value : true
    } else if (key === 'required' && Array.isArray(value) && value.every(item => typeof item === 'string')) {
      out.required = value
    } else {
      out[key] = value
    }
  }
  if (isPlainObject(out.properties) && Array.isArray(out.required)) {
    const declared = new Set(Object.keys(out.properties))
    out.required = (out.required as string[]).filter(name => declared.has(name))
  }
  return out
}

function matchField(fm: string, field: string): string | undefined {
  const match = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(fm)
  const value = match?.[1]?.trim()
  return value && value.length > 0 ? value : undefined
}

function asSchemaObject(value: unknown, tool: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error(`cua-driver describe ${tool}: input_schema is not an object`)
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sliceFirstJson(text: string): string {
  const open = text[0]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escape = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escape) {
        escape = false
      } else if (char === '\\') {
        escape = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === open) depth++
    else if (char === close) {
      depth--
      if (depth === 0) return text.slice(0, index + 1)
    }
  }
  throw new Error('unterminated JSON')
}
