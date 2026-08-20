# CUA Drive for DeepSeek Harness

**macOS-only** DeepSeek Harness plugin that gives the in-host agent its own computer-use runtime.

| | |
|---|---|
| Platform | **macOS only** (Apple Silicon and Intel) |
| License | MIT |
| Driver | official `cua-driver` **0.20.0**, pinned in `runtime-lock.json` |

Windows and Linux are not supported. On those OSes the plugin loads `cua_status` and explains it is macOS-only; it does not download a driver or start a daemon.

The installable package is named `dsh-cua-drive`. The repository and private
runtime state keep the legacy name `dsh-cuadrive-mac` so existing downloads,
permissions, sockets, and sessions continue working without migration.

The plugin can be installed directly from GitHub:

- **No Cua install on the machine:** first DSH start downloads the lock-pinned official `cua-driver` into `$DSH_HOME/dsh-cuadrive-mac/vendor/` and runs it.
- **Cua already installed:** this plugin still uses that private copy and a **private socket**. It does not `stop` the default daemon, does not write to `/Applications`, `~/.local/bin`, or `cua-driver skills install`.

Other agents keep their own cua-driver. Closing DSH only stops `$DSH_HOME/dsh-cuadrive-mac/run/driver.sock`.

## Install

```sh
dsh plugin --profile web add github:aa2246740/dsh-cuadrive-mac#<commit>
```

The repository commits its built `lib/` output, so a GitHub install does not run
an install-time `prepare` script. Pin a commit SHA as shown above, restart DSH,
and open a **new** chat. It works with **DSH.app** and CLI `dsh web`.

For local development, clone anywhere outside the Harness repository and install
the checkout from its own directory:

```sh
npm ci
npm test
npm run typecheck
npm run build
dsh plugin --profile web add .
```

If upgrading from the old `my-plugins` instructions, first remove the
`dsh-cuadrive-mac` insert from the profile's `cordis.patch.yml`. The Bundle now
owns that Loader row; keeping both copies causes a duplicate Loader id at boot.

First boot needs network once (GitHub Releases) unless you drop the exact tarball at `runtime.manualCachePath`.

## First-launch permissions (macOS)

On first launch after the runtime is ready, the plugin requests Accessibility and Screen Recording as **whatever launched dsh**:

| How you run dsh | Who macOS lists / who to grant |
|---|---|
| **DSH.app** | **DSH** |
| **CLI** (`dsh web`, no app pack) | **Terminal / iTerm / Cursor / VS Code** — the parent app |

Do **not** run `cua-driver permissions grant` (that launches `/Applications/CuaDriver.app`). `cua_status.hostPermissions.hostLabel` is the name to enable in System Settings.

## First-run download

DSH boot does **not** wait on GitHub. Host tools (`cua_status`, `cua_call`, …) register immediately. The tarball downloads in the background with `curl -C -`.

| Where | What you see |
|---|---|
| **`cua_status`** | Tool card title `Cua runtime 42%`. JSON has percent, proxy, paths. |
| `$DSH_HOME/dsh-cuadrive-mac/status.json` | Same live object on disk. |
| `$DSH_HOME/dsh-cuadrive-mac/download.log` | curl progress and errors. |

If GitHub is blocked, set `HTTPS_PROXY` / `ALL_PROXY` / plugin config `proxy`, or drop the exact GitHub asset at `runtime.manualCachePath`. Do **not** run `cua-driver update`.

## Layout

```
$DSH_HOME/dsh-cuadrive-mac/
  vendor/<driver>/   # private cua-driver, stamped to this plugin version
  cache/             # resumable tarball
  status.json
  download.log
  permissions.json
  run/driver.sock
```

Skill files under `skill/` are the official pack for the locked driver. The catalog name is `dsh-cuadrive-mac`. Agent tools stay `cua_*`.

## Config

| key | default | meaning |
|---|---|---|
| `binary` | (empty) | absolute override; empty = plugin vendor dir |
| `ownDaemon` | `true` | private DSH socket |
| `socketPath` | `$DSH_HOME/dsh-cuadrive-mac/run/driver.sock` | DSH-only serve socket |
| `autoStart` | `true` | download + `serve --embedded` when the socket is down |
| `proxy` | (empty) | HTTP(S) proxy for the GitHub download |
| `promptPermissions` | `true` | first launch prompts Accessibility + Screen Recording as the dsh host |
| `timeoutMs` | `90000` | per-call deadline |
| `sessionId` | `dsh` | hosted session on the private daemon |

## Tests

From this repository:

```sh
npm test
npm run typecheck
npm run build
```

## Why not `@deepseek-ai/dsh-mcp-client` alone?

That client discards screenshot image blocks. This plugin calls the private `cua-driver --socket … call` and re-attaches PNGs through `ctx.attachments`.
