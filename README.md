# dsh-cuadrive-mac

**macOS-only** DeepSeek Harness plugin that gives the in-host agent its own computer-use runtime.

| | |
|---|---|
| Platform | **macOS only** (Apple Silicon and Intel) |
| License | MIT |
| Driver | official `cua-driver` **0.20.0**, pinned in `runtime-lock.json` |

Windows and Linux are not supported. On those OSes the plugin loads `cua_status` and explains it is macOS-only; it does not download a driver or start a daemon.

It is meant to be cloned into a Harness checkout and used as-is:

- **No Cua install on the machine:** first DSH start downloads the lock-pinned official `cua-driver` into `$DSH_HOME/dsh-cuadrive-mac/vendor/` and runs it.
- **Cua already installed:** this plugin still uses that private copy and a **private socket**. It does not `stop` the default daemon, does not write to `/Applications`, `~/.local/bin`, or `cua-driver skills install`.

Other agents keep their own cua-driver. Closing DSH only stops `$DSH_HOME/dsh-cuadrive-mac/run/driver.sock`.

## Install

```sh
cd <harness>/my-plugins
git clone https://github.com/aa2246740/dsh-cuadrive-mac.git
cd ..
pnpm dshx check dsh-cuadrive-mac
pnpm dshx start web dsh-cuadrive-mac
```

Works with **DSH.app** and with CLI `dsh web` / `dshx start` (no app pack). Then restart DSH and open a **new** chat. Do not Continue a session that already 400'd.

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

From a DeepSeek Harness checkout:

```sh
node --import tsx/esm --test --test-concurrency=1 my-plugins/dsh-cuadrive-mac/tests/*.spec.ts
```

## Why not `@deepseek-ai/dsh-mcp-client` alone?

That client discards screenshot image blocks. This plugin calls the private `cua-driver --socket … call` and re-attaches PNGs through `ctx.attachments`.
