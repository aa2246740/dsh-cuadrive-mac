[中文](README.md) · [English](README.en.md)

# A computer-use runtime that belongs to DeepSeek Harness

On a Mac, this gives the in-host agent its own hands: click windows, read the screen, drive apps. The engine is official [`cua-driver`](https://github.com/trycua/cua) **0.20.0**, pinned in `runtime-lock.json`, served on a **private socket**. It will not stop, rewrite, or hijack a machine-wide Cua install.

macOS only. Unofficial. The installable package is `dsh-cua-drive`. The repo stays `dsh-cuadrive-mac` so existing downloads, permissions, sockets, and sessions do not have to migrate.

## Mac shot TBD

**Mac shot TBD: one `cua_click` / screen attachment inside DSH.app.**

This docs environment is Linux Cloud. There is no Mac desktop here, so this slot stays empty. A real Mac recapture will land separately. Do not fill this slot with the Linux refuse still.

## Install

Pin a commit, restart DSH, open a **new** chat. Works with **DSH.app** and CLI `dsh web`. The repo ships built `lib/`, so a GitHub install does not run `prepare`.

```sh
dsh plugin --profile web add github:aa2246740/dsh-cuadrive-mac#593da95209f755a9bfa43ab002c504f67f07c2cd
```

First Mac boot needs network once (GitHub Releases) to drop the pinned darwin-universal tarball into `$DSH_HOME/dsh-cuadrive-mac/vendor/`. If GitHub is blocked, set `HTTPS_PROXY` / `ALL_PROXY` / plugin config `proxy`, or put the exact asset at `runtime.manualCachePath`. Do not run `cua-driver update`.

Upgrading from the old `my-plugins` notes: delete the `dsh-cuadrive-mac` insert from the profile's `cordis.patch.yml`. The Bundle now owns that Loader row; keeping both copies duplicates the Loader id at boot.

## Windows / Linux

Windows and Linux load only the status tools. Computer-use does not start.

![cua_status on Linux: supports macOS only (got linux/x64)](docs/screenshots/linux-cua-status.png)

That still is Linux Cloud, not the product hero. The Mac `cua_click` / screen-attachment shot belongs in the empty slot above.

## First launch on a Mac

Once the runtime is ready, the plugin asks for Accessibility and Screen Recording as **whatever launched dsh**:

| How you run dsh | Who macOS lists / who to grant |
|---|---|
| **DSH.app** | **DSH** |
| **CLI** (`dsh web`, no app pack) | **Terminal / iTerm / Cursor / VS Code** — the parent app |

Do not run `cua-driver permissions grant` (that launches `/Applications/CuaDriver.app`). `cua_status.hostPermissions.hostLabel` is the name to enable in System Settings.

DSH boot does not wait on GitHub. Host tools register immediately. The tarball downloads in the background with `curl -C -`. Watch `cua_status` (card title `Cua runtime 42%`), or open `$DSH_HOME/dsh-cuadrive-mac/status.json` and `download.log`.

## It stays off the machine-wide Cua

```
$DSH_HOME/dsh-cuadrive-mac/
  vendor/<driver>/   # private cua-driver, stamped to this plugin version
  cache/             # resumable tarball
  status.json
  download.log
  permissions.json
  run/driver.sock    # DSH-only; not ~/.local/bin
```

Closing DSH only stops this socket. Other agents keep their own cua-driver. Files under `skill/` are the official pack for the locked driver. The catalog name stays `dsh-cuadrive-mac`. Agent tools stay `cua_*`.

Why not `@deepseek-ai/dsh-mcp-client` alone? That client discards screenshot image blocks. This plugin calls the private `cua-driver --socket … call` and re-attaches PNGs through `ctx.attachments`.

## Config

| key | default | meaning |
|---|---|---|
| `binary` | (empty) | absolute override; empty = plugin vendor dir |
| `ownDaemon` | `true` | private DSH socket |
| `socketPath` | `$DSH_HOME/dsh-cuadrive-mac/run/driver.sock` | DSH-only serve socket |
| `autoStart` | `true` | download + `serve --embedded` when the socket is down |
| `proxy` | (empty) | HTTP(S) proxy for the GitHub download |
| `promptPermissions` | `true` | first launch prompts as the dsh host |
| `timeoutMs` | `90000` | per-call deadline |
| `sessionId` | `dsh` | hosted session on the private daemon |

## Local development

Clone anywhere outside the Harness repository and install from this directory:

```sh
npm ci
npm test
npm run typecheck
npm run build
dsh plugin --profile web add .
```

MIT. Unofficial — not affiliated with DeepSeek or Cua.
