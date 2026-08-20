import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'

export interface CuaImageValue {
  attachmentId: string
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
}

export interface PreparedScreenshot {
  path: string
  cleanup: () => Promise<void>
}

const SCREENSHOT_TOOLS = new Set([
  'get_window_state',
  'get_desktop_state',
  'zoom',
  'verify_state',
])

/** Whether this driver tool should write a screenshot sidecar. */
export function wantsScreenshotFile(tool: string, args: Record<string, unknown>): boolean {
  if (args.include_screenshot === false) return false
  if (typeof args.screenshot_out_file === 'string' && args.screenshot_out_file.length > 0) return false
  return SCREENSHOT_TOOLS.has(tool)
}

/** Create a temp PNG path the CLI can write into. */
export async function prepareScreenshotFile(): Promise<PreparedScreenshot> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cua-'))
  const path = join(dir, `${randomUUID()}.png`)
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

/** Commit a screenshot file (or inline MCP image blocks) through `ctx.attachments`. */
export async function collectImages(
  ctx: Context,
  tool: string,
  data: unknown,
  screenshotPath: string | undefined,
): Promise<{ images: CuaImageValue[], notes: string[] }> {
  const images: CuaImageValue[] = []
  const notes: string[] = []

  if (screenshotPath !== undefined) {
    try {
      const bytes = await readFile(screenshotPath)
      if (bytes.byteLength > 0) {
        const committed = await commitBytes(ctx, bytes, mimeFromBytes(bytes), `${tool}.png`)
        if (committed.image) images.push(committed.image)
        if (committed.note) notes.push(committed.note)
      }
    } catch (error: unknown) {
      // AX timeout / include_screenshot:false leaves no file. Do not surface ENOENT.
      if (!isMissingPath(error)) {
        notes.push(`screenshot file unreadable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  if (images.length === 0) {
    for (const inline of inlineImages(data)) {
      const committed = await commitBytes(ctx, inline.bytes, inline.mediaType, `${tool}-inline.png`)
      if (committed.image) images.push(committed.image)
      if (committed.note) notes.push(committed.note)
    }
  }

  return { images, notes }
}

/** Re-brand a canonical image for a model-facing `image` block. */
export function imageRefFromValue(image: CuaImageValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

async function commitBytes(
  ctx: Context,
  data: Uint8Array,
  mediaType: ImageMediaType,
  name: string,
): Promise<{ image?: CuaImageValue, note?: string }> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    const path = join(tmpdir(), name)
    await writeFile(path, data)
    return { note: `no attachment service; screenshot written to ${path} — use read_image on that path` }
  }
  try {
    const ref = await attachments.saveImage({ data, mediaType, name })
    return {
      image: {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...ref.name === undefined ? {} : { name: ref.name },
      },
    }
  } catch (error: unknown) {
    return { note: `saveImage failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function inlineImages(data: unknown): { bytes: Uint8Array, mediaType: ImageMediaType }[] {
  if (!data || typeof data !== 'object') return []
  const record = data as Record<string, unknown>
  const blocks = Array.isArray(record.content) ? record.content : []
  const found: { bytes: Uint8Array, mediaType: ImageMediaType }[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const item = block as Record<string, unknown>
    if (item.type !== 'image' || typeof item.data !== 'string') continue
    try {
      const bytes = Buffer.from(item.data, 'base64')
      const mediaType = mimeFromName(typeof item.mimeType === 'string' ? item.mimeType : undefined) ?? mimeFromBytes(bytes)
      found.push({ bytes, mediaType })
    } catch {
      // skip malformed
    }
  }
  return found
}

function isMissingPath(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT'
}

function mimeFromName(value: string | undefined): ImageMediaType | undefined {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value
  return undefined
}

function mimeFromBytes(bytes: Uint8Array): ImageMediaType {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return 'image/png'
}
