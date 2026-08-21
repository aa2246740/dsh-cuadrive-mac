[中文](README.md) · [English](README.en.md)

# 给 DeepSeek Harness 自己的电脑操作运行时

装上之后，DSH 里的 agent 就能点窗口、读屏幕、操作 App。底层是官方 [`cua-driver`](https://github.com/trycua/cua) **0.20.0**（写死在 `runtime-lock.json`），跑在插件自己的私有 socket 上。机器上已经装着的 Cua 它不会去停、不会去改、也不会去劫持。

只做 macOS。Windows / Linux 上它会加载，但只给你状态工具，老实告诉你：这是 macOS-only。非官方插件。

包名是 `dsh-cua-drive`。仓库还叫 `dsh-cuadrive-mac`，是为了让已经下过的包、权限、socket、会话不用搬家。

![在 Linux Cloud 上加载插件：computer-use 没有启动，私有 socket 闲置](docs/screenshots/linux-status.gif)

上面这段是 **Linux Cloud** 上的真机回放，不是 Mac 桌面，也不是效果图。GitHub 用 GIF 第一帧当封面：插件已经 loaded，并写出 `macOS only — computer-use is not started on linux`。接着调用 `cua_status`，它直接拒绝：`supports macOS only (got linux/x64)`。

## 安装

钉死一个 commit，重启 DSH，开一个**新**对话。DSH.app 和命令行 `dsh web` 都能用。仓库里已经带着编好的 `lib/`，GitHub 安装不会跑 `prepare`。

```sh
dsh plugin --profile web add github:aa2246740/dsh-cuadrive-mac#593da95209f755a9bfa43ab002c504f67f07c2cd
```

第一次在 Mac 上启动需要联网一次（GitHub Releases），把钉死的 darwin-universal 包拉到 `$DSH_HOME/dsh-cuadrive-mac/vendor/`。下不动就设 `HTTPS_PROXY` / `ALL_PROXY` / 插件配置 `proxy`，或者把一模一样的 tarball 放到 `runtime.manualCachePath`。不要跑 `cua-driver update`。

从旧的 `my-plugins` 说明升级的：先把 profile 里 `cordis.patch.yml` 中的 `dsh-cuadrive-mac` 那一行删掉。现在由 Bundle 自己占 Loader，留两份会在启动时报重复 id。

## 这些图是在哪拍的

这台机器是 Linux Cloud（`linux/x64`），没有 Mac 桌面，所以也没有假装出来的 macOS 窗口。下面每张都是本仓库在这台机器上跑出来的：插件加载、`cua_status`、Linux 上仅有的 host tools、钉死的 runtime lock、以及「非 darwin 直接拒绝」的测试。

![插件加载：macOS only，computer-use 未启动，私有 socket 闲置](docs/screenshots/01-plugin-load.png)

加载之后只报 macOS-only。私有 socket 路径已经算好（`$DSH_HOME/dsh-cuadrive-mac/run/driver.sock`），但这台机器上不会 `serve`。

![cua_status 在 Linux 上拒绝：supports macOS only (got linux/x64)](docs/screenshots/02-cua-status.png)

`cua_status` 是 Windows / Linux 上真正会留下来的那把工具。这里它抛出插件自己的平台错误，并带上 host TCC 的提示：权限对话框也是 macOS-only。

![Linux 上只注册 cua_status / cua_list_tools / cua_describe / cua_call](docs/screenshots/03-host-tools.png)

host tools 还在：`cua_status`、`cua_list_tools`、`cua_describe`、`cua_call`。真正的 driver tools（`cua_click`、`cua_get_window_state` …）不会注册。

![runtime-lock.json：cua-driver 0.20.0，只有 darwin-universal 产物](docs/screenshots/04-runtime-lock.png)

锁文件只认 darwin-universal。plugin / driver / skill 版本和 sha256 绑在一起，Linux / Windows 没有对应产物。

![测试通过：releaseArtifact 在 linux/win32 上按设计抛错](docs/screenshots/05-linux-refuse-test.png)

这不是装坏了。`releaseArtifact` 在 `linux` / `win32` 上按设计抛错，测试也是这么写的。

## 第一次在 Mac 上

运行时起来之后，插件会用**真正拉起 dsh 的那个进程**去要辅助功能、屏幕录制：

| 你怎么跑 dsh | 系统设置里要勾谁 |
|---|---|
| **DSH.app** | **DSH** |
| **CLI**（`dsh web`，没有 app 包） | **Terminal / iTerm / Cursor / VS Code** —— 父进程那个 App |

不要跑 `cua-driver permissions grant`，那会去拉 `/Applications/CuaDriver.app`。看 `cua_status.hostPermissions.hostLabel`，勾那个名字。

DSH 启动不等 GitHub。host tools 马上就能调。tarball 在后台用 `curl -C -` 续传。进度看 `cua_status` 的卡片标题（`Cua runtime 42%`），或者打开 `$DSH_HOME/dsh-cuadrive-mac/status.json` 和 `download.log`。

## 它怎么跟机器上的 Cua 分开

```
$DSH_HOME/dsh-cuadrive-mac/
  vendor/<driver>/   # 这份插件私有的 cua-driver
  cache/             # 可续传的 tarball
  status.json
  download.log
  permissions.json
  run/driver.sock    # 只给 DSH 用，不是 ~/.local/bin 那份
```

关掉 DSH，停的只是这个 socket。别的 agent 各自的 cua-driver 还在。`skill/` 是跟锁版本对齐的官方 skill 包；目录名仍是 `dsh-cuadrive-mac`，给模型的工具名仍是 `cua_*`。

为什么不只塞 `@deepseek-ai/dsh-mcp-client`：那个客户端会丢掉截图 image block。这份插件走私有的 `cua-driver --socket … call`，再把 PNG 挂回 `ctx.attachments`。

## 配置

| key | 默认 | 干什么 |
|---|---|---|
| `binary` | （空） | 绝对路径覆盖；空就用插件 vendor 目录 |
| `ownDaemon` | `true` | 私有 DSH socket |
| `socketPath` | `$DSH_HOME/dsh-cuadrive-mac/run/driver.sock` | 只给 DSH 的 serve |
| `autoStart` | `true` | socket 没起来就下载并 `serve --embedded` |
| `proxy` | （空） | 拉 GitHub 时用的 HTTP(S) 代理 |
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

MIT。非官方，跟 DeepSeek、Cua 都没有合作关系。
