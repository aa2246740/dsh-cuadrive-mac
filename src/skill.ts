import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { LOG } from './argv.ts'
import type { ResolvedConfig } from './config.ts'
import { parseFrontmatter } from './parse.ts'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VENDORED_SKILL_DIR = join(PLUGIN_ROOT, 'skill')

const DSH_TRANSPORT = `# DeepSeek Harness transport (dsh-cuadrive-mac)

This skill is **DSH-only** and **macOS-only**. It is not the shared \`cua-driver\` skill other agents may install. Other Codex/Claude/OpenClaw cua-driver copies are not this plugin and do not share this daemon. Windows and Linux are not supported.

The markdown below this banner is the official Cua Driver skill body for the **same release as this machine's CuaDriver.app**, vendored inside this plugin. Platform companions in this skill's resource directory are unmodified: MACOS.md, WINDOWS.md, LINUX.md, BROWSER.md, RECORDING.md, EMBEDDING.md, README.md.

On DeepSeek Harness:

- Call \`cua_<tool>\` with the same JSON fields the official skill documents. Examples: \`cua_click\`, \`cua_get_window_state\`, \`cua_set_window_frame\`.
- Only tools returned by \`cua_list_tools\` exist on this DSH daemon. Do not invent names from a newer skill than \`cua_list_tools\`.
- \`cua_call\` invokes a **listed** driver tool by raw name. Unknown names are rejected here; they are not forwarded.
- \`cua_status\` / \`cua_list_tools\` / \`cua_describe\` inspect this plugin's cua-driver without going through bash.
- The private driver binary is **pinned** in this plugin's \`runtime-lock.json\` (plugin version + driver version + checksum). Do **not** run \`cua-driver update\` and do not use another agent's cua-driver.
- First start downloads that pinned tarball in the background (resumable). Watch it with \`cua_status\` (tool card shows percent), or open \`$DSH_HOME/dsh-cuadrive-mac/status.json\` and \`download.log\`. If GitHub is blocked, set HTTPS_PROXY / ALL_PROXY / plugin config \`proxy\` (梯子) and retry — partial files resume. Or drop the exact GitHub asset on \`runtime.manualCachePath\`.
- On first launch this plugin requests **Accessibility** and **Screen Recording for the process that launched dsh** (DSH.app, or Terminal/IDE if the user runs \`dsh web\` with no app pack), then probes capture so the System Settings row exists before any GUI task. Grant **that host**, not CuaDriver.app. Do not run \`cua-driver permissions grant\`. CLI dsh without DSH.app still works.
- If a \`cua_*\` call returns \`reason: "runtime_not_ready"\`, show the user the percent, hint, and paths from that payload. Do not shell out a download yourself.
- Do **not** run \`cua-driver\` through bash/shell. Do **not** use \`open\`, \`osascript\`, or \`cliclick\` to drive the GUI.
- When the official skill writes \`click(...)\` or \`cua-driver click '{...}'\`, call the DSH tool \`cua_click\` with the same object.
- Screenshots from \`get_window_state\`, \`get_desktop_state\`, and \`zoom\` are returned as image blocks on the tool result.
- DeepSeek Harness starts a **private** CuaDriver serve on a DSH-only socket when this plugin loads, and stops **that** serve when DSH unloads. It does not stop other agents' cua-driver daemons.
- A process-lifetime cua session (default id \`dsh\`) lives on that private daemon. You do not need \`start_session\` for long GUI tasks.
- Read a companion file from the skill resource directory with the filesystem \`read\` tool when the task needs that OS, browser, or recording path.

`

const PROMPT_TEXT = [
  'When the user wants to operate a native desktop or GUI app (click, type, read a window, drive Slack/Finder/browser chrome, etc.), use the already-registered cua_* tools yourself — do not wait for the user to name Cua, computer use, or a skill.',
  'Typical loop: cua_list_apps or cua_launch_app → cua_get_window_state(pid, window_id) → cua_click / cua_type_text / cua_set_value on a fresh element_token → verify with another snapshot.',
  'If cua_* returns runtime_not_ready, call cua_status, tell the user the download percent and whether they need a proxy (梯子) or to drop the tarball at manualCachePath, and keep polling cua_status. Do not run curl/cua-driver update yourself.',
  'If cua_status says Accessibility or Screen Recording is missing, tell the user to allow the host named in hostPermissions.hostLabel (DSH.app, or the terminal/IDE if they run CLI dsh with no app pack) in System Settings — not CuaDriver.app — and restart dsh. Do not run cua-driver permissions grant.',
  'The dsh-cuadrive-mac skill in the session catalog is this macOS-only DSH plugin\'s contract; load it with the skill tool when you need the long loop. Tools work without that load.',
  'Do not shell out to cua-driver, open, osascript, or cliclick. Do not use another agent\'s cua-driver socket or skill.',
].join(' ')

/** Register the DSH-owned skill plus a short standing transport note. */
export function registerCuaSkill(ctx: Context, config: ResolvedConfig): void {
  const dir = resolveSkillDir(config)
  const official = readOfficialSkill(dir)
  const skills = ctx.get('skills')
  if (skills) {
    skills.register({
      name: 'dsh-cuadrive-mac',
      description: official.description,
      source: 'runtime',
      content: `${DSH_TRANSPORT}${official.body}`,
      path: join(dir, 'SKILL.md'),
      resourceBase: { kind: 'directory', path: dir },
    })
    console.log(`${LOG} DSH skill dsh-cuadrive-mac from ${dir}`)
  } else {
    ctx.logger.warn(`${LOG} ctx.skills is not mounted; DSH skill was not registered`)
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    systemPrompt.section({
      name: 'tool:dsh-cuadrive-mac',
      order: 118,
      text: PROMPT_TEXT,
    })
  }
}

/** Always the plugin-vendored pack unless config.skillDir is set. Never `cua-driver skills path`. */
export function resolveSkillDir(config: ResolvedConfig): string {
  if (config.skillDir.length > 0 && existsSync(join(config.skillDir, 'SKILL.md'))) {
    return config.skillDir
  }
  return VENDORED_SKILL_DIR
}

function readOfficialSkill(dir: string): { name: string, description: string, body: string } {
  const path = join(dir, 'SKILL.md')
  if (!existsSync(path)) {
    throw new Error(`dsh-cuadrive-mac skill pack missing SKILL.md at ${path}`)
  }
  const parsed = parseFrontmatter(readFileSync(path, 'utf8'))
  return {
    name: 'dsh-cuadrive-mac',
    description: parsed.description ?? 'Drive a native GUI app with DSH\'s dedicated Cua Driver plugin.',
    body: parsed.body,
  }
}
