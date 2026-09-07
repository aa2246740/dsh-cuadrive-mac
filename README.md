[中文](README.md) · [English](README.en.md)

# dsh-cua-drive

只做 macOS。装上之后，DSH 里的 agent 用一份私有、钉死的 [`cua-driver`](https://github.com/trycua/cua) **0.20.0**（写在 `runtime-lock.json`）点窗口、读屏幕、操作 App。跑在插件自己的 socket 上，不会停、改或劫持机器上已有的 Cua。

第一次启动会向拉起 dsh 的那个进程要辅助功能和屏幕录制。DSH.app 勾 DSH。命令行 `dsh web` 勾 Terminal / iTerm / Cursor / VS Code。Windows / Linux 只加载 `cua_status`，说明这是 macOS-only，不会下载驱动，也不会启动 computer-use。

包名是 `dsh-cua-drive`。仓库还叫 `dsh-cuadrive-mac`，已经下过的包、权限、socket、会话不用搬家。

## 安装

钉死一个 commit，重启 DSH，开一个新对话。仓库里已经带着编好的 `lib/`，GitHub 安装不会跑 `prepare`。

```sh
dsh plugin --profile web add github:aa2246740/dsh-cuadrive-mac#593da95209f755a9bfa43ab002c504f67f07c2cd
```

第一次在 Mac 上启动需要联网一次，把钉死的 darwin-universal 包拉到 `$DSH_HOME/dsh-cuadrive-mac/vendor/`。下不动就设 `HTTPS_PROXY` / `ALL_PROXY` / 插件配置 `proxy`，或者把一模一样的 tarball 放到 `runtime.manualCachePath`。不要跑 `cua-driver update`。

从旧的 `my-plugins` 说明升级的：先把 profile 里 `cordis.patch.yml` 中的 `dsh-cuadrive-mac` 那一行删掉。现在由 Bundle 自己占 Loader，留两份会在启动时报重复 id。

## 第一次在 Mac 上

| 你怎么跑 dsh | 系统设置里要勾谁 |
|---|---|
| DSH.app | DSH |
| CLI `dsh web`，没有 app 包 | Terminal / iTerm / Cursor / VS Code，父进程那个 App |

不要跑 `cua-driver permissions grant`，那会去拉 `/Applications/CuaDriver.app`。看 `cua_status.hostPermissions.hostLabel`，勾那个名字。

进度看 `cua_status` 的卡片标题，或 `$DSH_HOME/dsh-cuadrive-mac/status.json` 和 `download.log`。

Windows / Linux 只加载状态工具：

![Linux 上调用 cua_status：supports macOS only](docs/screenshots/linux-cua-status.png)

私有运行时在 `$DSH_HOME/dsh-cuadrive-mac/`。关掉 DSH，停的只是 `run/driver.sock`。给模型的工具名仍是 `cua_*`。

## 配置

| key | 默认 | 干什么 |
|---|---|---|
| `binary` | 空 | 绝对路径覆盖；空就用插件 vendor 目录 |
| `ownDaemon` | `true` | 私有 DSH socket |
| `socketPath` | `$DSH_HOME/dsh-cuadrive-mac/run/driver.sock` | 只给 DSH 的 serve |
| `autoStart` | `true` | socket 没起来就下载并 `serve --embedded` |
| `proxy` | 空 | 拉 GitHub 时用的 HTTP(S) 代理 |
| `promptPermissions` | `true` | 第一次用拉起 dsh 的那个 host 去要权限 |
| `timeoutMs` | `90000` | 单次调用时限 |
| `sessionId` | `dsh` | 私有 daemon 上的 hosted session |

## 本地开发

克隆到 Harness 仓库外面，在插件自己的目录里：

```sh
npm ci
npm test
npm run typecheck
npm run build
dsh plugin --profile web add .
```

MIT。
