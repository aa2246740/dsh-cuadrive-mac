import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { LOG } from './argv.ts'
import type { ResolvedConfig } from './config.ts'
import {
  callDriverTool,
  describeDriverTool,
  listDriverTools,
} from './driver.ts'
import { compactListAppsData } from './compact-apps.ts'
import { collectImages, prepareScreenshotFile, wantsScreenshotFile } from './images.ts'
import { sanitizeJsonSchema } from './parse.ts'
import { CUA_OUTPUT_DSL, CUA_OUTPUT_JSON, cuaCallValue, renderCuaValue, type CuaCallValue } from './result.ts'
import {
  ensureRuntime,
  formatBytes,
  readRuntimeStatus,
  runtimeAvailable,
} from './runtime.ts'
import { attachPluginSession, endedSessionId, sessionToRefresh } from './session-revive.ts'
import { buildCuaStatus } from './status.ts'
import { boundWindowStateArgs, compactWindowStateData, shouldRetryWindowState } from './window-state.ts'

const HOST_TOOLS = new Set(['cua_status', 'cua_list_tools', 'cua_describe', 'cua_call'])

/** Host diagnostics + cua_call, always registered via defineTool. */
export function registerHostTools(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'cua_status',
    description: 'Report the lock-pinned cua-driver download (percent, status.json, download.log, proxy/ladder, manual cache path), first-launch DSH Accessibility/Screen Recording grants (not CuaDriver.app), private daemon, and skill pack. Call this to watch the first-run download or when computer-use fails.',
    parameters: {},
    timeoutMs: config.timeoutMs,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(_args, exec) {
      if (config.autoStart && !runtimeAvailable(config)) void ensureRuntime(config)
      return buildCuaStatus(config, exec.signal)
    },
    presentCall: () => {
      const status = readRuntimeStatus()
      const title = status.phase === 'ready'
        ? 'Cua status'
        : `Cua runtime ${status.percent}%`
      return { card: 'generic', title, kind: 'read' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'cua_list_tools',
    description: 'List every Cua Driver tool name and one-line summary from the installed cua-driver binary.',
    parameters: {},
    timeoutMs: config.timeoutMs,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute() {
      const blocked = runtimeNotReady(config, 'list_tools')
      if (blocked) {
        return Promise.resolve({
          tools: [],
          reason: 'runtime_not_ready',
          runtime: readRuntimeStatus(),
          text: blocked.text,
        })
      }
      return Promise.resolve({ tools: listDriverTools(config) })
    },
    presentCall: () => ({ card: 'generic', title: 'Cua list tools', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_describe',
    description: 'Print one Cua Driver tool\'s official description and input JSON Schema from `cua-driver describe`.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Raw driver tool name, e.g. click or get_window_state' },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args) {
      const blocked = runtimeNotReady(config, 'describe')
      if (blocked) {
        return Promise.resolve({
          reason: 'runtime_not_ready',
          runtime: readRuntimeStatus(),
          text: blocked.text,
        })
      }
      const described = describeDriverTool(config, args.tool)
      return Promise.resolve({
        name: described.name,
        dsh_tool: publicName(described.name),
        description: described.description,
        input_schema: described.inputSchema,
      })
    },
    presentCall: args => ({ card: 'generic', title: `Cua describe ${args.tool}`, kind: 'read', rawInput: args.tool }),
  }))

  ctx.tools.register(defineTool({
    name: 'cua_call',
    description: 'Call any Cua Driver tool by raw name with a JSON arguments object. Prefer the first-class cua_<name> tool when it exists. Screenshots are returned as image blocks.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Raw driver tool name, e.g. click' },
      arguments: {
        type: 'object',
        additionalProperties: true,
        description: 'JSON object matching `cua_describe` for that tool',
      },
    },
    timeoutMs: config.timeoutMs,
    output: {
      schema: CUA_OUTPUT_DSL,
      render: renderCuaValue,
    },
    execute(args, exec) {
      const toolArgs = isPlainObject(args.arguments) ? args.arguments : {}
      return invokeCuaTool(ctx, config, args.tool, toolArgs, exec.signal)
    },
    presentCall: args => ({ card: 'generic', title: `Cua ${args.tool}`, kind: actionKind(args.tool), rawInput: args }),
  }))
}

/** Register every tool the installed binary lists as `cua_<name>`. */
export function registerDriverTools(ctx: Context, config: ResolvedConfig): string[] {
  const registered: string[] = []
  for (const listed of listDriverTools(config)) {
    const name = publicName(listed.name)
    if (HOST_TOOLS.has(name)) continue
    try {
      const described = describeDriverTool(config, listed.name)
      ctx.tools.register(driverToolDefinition(ctx, config, described.name, described.description, described.inputSchema))
      registered.push(name)
    } catch (error: unknown) {
      ctx.logger.warn(`${LOG} skip ${listed.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return registered
}

function driverToolDefinition(
  ctx: Context,
  config: ResolvedConfig,
  rawName: string,
  description: string,
  inputSchema: Record<string, unknown>,
): ToolDefinition {
  return {
    name: publicName(rawName),
    description: `${description}\n\nCua Driver tool \`${rawName}\`. Snapshot before element-indexed actions. Do not shell out to cua-driver.`,
    parameters: sanitizeJsonSchema(inputSchema) as ToolDefinition['parameters'],
    timeoutMs: config.timeoutMs,
    output: {
      schema: CUA_OUTPUT_JSON,
      render: (args, value) => renderCuaValue(args, value as CuaCallValue),
    },
    execute(args, exec) {
      const toolArgs = isPlainObject(args) ? args : {}
      return invokeCuaTool(ctx, config, rawName, toolArgs, exec.signal)
    },
    presentCall(args) {
      return { card: 'generic', title: `Cua ${rawName}`, kind: actionKind(rawName), rawInput: args }
    },
  }
}

/** Exported so live tests can run the same path the model hits. */
export async function invokeCuaTool(
  ctx: Context,
  config: ResolvedConfig,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CuaCallValue> {
  const blocked = runtimeNotReady(config, tool)
  if (blocked) return blocked
  assertKnownDriverTool(config, tool)
  const firstArgs = tool === 'get_window_state'
    ? attachPluginSession(boundWindowStateArgs(args), config.sessionId)
    : attachPluginSession(args, config.sessionId)
  let screenshot: Awaited<ReturnType<typeof prepareScreenshotFile>> | undefined
  try {
    await refreshSession(config, firstArgs, signal)
    if (wantsScreenshotFile(tool, firstArgs)) screenshot = await prepareScreenshotFile()
    let data = await callDriverToolReviving(config, tool, firstArgs, {
      signal,
      ...screenshot ? { screenshotOutFile: screenshot.path } : {},
    })
    if (tool === 'get_window_state' && shouldRetryWindowState(args, data)) {
      const retryArgs = attachPluginSession(boundWindowStateArgs(args, true), config.sessionId)
      data = await callDriverToolReviving(config, tool, retryArgs, {
        signal,
        ...screenshot ? { screenshotOutFile: screenshot.path } : {},
      })
    }
    if (tool === 'get_window_state') data = compactWindowStateData(data)
    if (tool === 'list_apps') data = compactListAppsData(data)
    const collected = await collectImages(ctx, tool, data, screenshot?.path)
    return cuaCallValue(tool, data, collected)
  } finally {
    await screenshot?.cleanup()
  }
}

async function refreshSession(
  config: ResolvedConfig,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  const session = sessionToRefresh(args)
  if (session === undefined) return
  await callDriverTool(config, 'start_session', { session }, { signal })
}

async function callDriverToolReviving(
  config: ResolvedConfig,
  tool: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal, screenshotOutFile?: string },
): Promise<unknown> {
  try {
    return await callDriverTool(config, tool, args, options)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const session = endedSessionId(message)
    if (session === undefined) throw error
    await callDriverTool(config, 'start_session', { session }, { signal: options.signal })
    return await callDriverTool(config, tool, args, options)
  }
}

function assertKnownDriverTool(config: ResolvedConfig, tool: string): void {
  const known = listDriverTools(config).some(listed => listed.name === tool)
  if (known) return
  throw new Error(
    `${LOG} unknown driver tool '${tool}'. This DSH plugin only forwards tools from its own cua-driver list-tools. Call cua_list_tools.`,
  )
}

function runtimeNotReady(config: ResolvedConfig, tool: string): CuaCallValue | undefined {
  if (runtimeAvailable(config)) return undefined
  if (config.autoStart) void ensureRuntime(config)
  const status = readRuntimeStatus()
  const notes = [
    status.message,
    `${status.percent}% — ${formatBytes(status.bytes)} / ${formatBytes(status.total)}`,
    status.error ? `error: ${status.error}` : '',
    status.hint,
    `status: ${status.statusPath}`,
    `log: ${status.logPath}`,
  ].filter(part => part.length > 0)
  return cuaCallValue(tool, {
    ok: false,
    reason: 'runtime_not_ready',
    runtime: JSON.parse(JSON.stringify(status)) as Record<string, unknown>,
  }, { notes })
}

function publicName(raw: string): string {
  return `cua_${raw.replace(/[^A-Za-z0-9_]/g, '_')}`
}

function actionKind(tool: string): 'read' | 'other' {
  return /^(get_|list_|check_|health_|describe)/.test(tool) ? 'read' : 'other'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
