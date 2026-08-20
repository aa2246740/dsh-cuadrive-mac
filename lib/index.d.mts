import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/config.d.ts
/** Plugin configuration resolved before `apply`. */
interface Config {
  /** Absolute override for the private cua-driver binary. Empty uses the plugin vendor dir. */
  binary?: string;
  /** Start a DSH-owned CuaDriver serve when our socket is down. Default true. */
  autoStart?: boolean;
  /** Per-call deadline in milliseconds. Default 90000. */
  timeoutMs?: number;
  /** Register every driver tool as `cua_<name>`. Default true. */
  registerDriverTools?: boolean;
  /** Skill pack directory. Empty uses the plugin-vendored official pack only. */
  skillDir?: string;
  /** Plugin-hosted cua session id on the DSH-owned daemon. Default `dsh`. Empty disables hosting. */
  sessionId?: string;
  /** How often to refresh the hosted session idle TTL. Default 60000. */
  heartbeatMs?: number;
  /** Isolate from other agents' cua-driver daemons. Default true. */
  ownDaemon?: boolean;
  /** Unix socket for the DSH-owned daemon. Empty uses `$DSH_HOME/dsh-cuadrive-mac/run/driver.sock`. */
  socketPath?: string;
  /** HTTP(S) proxy for the lock-pinned GitHub download (梯子). Empty uses HTTPS_PROXY / ALL_PROXY / DSH_CUA_DRIVE_PROXY. */
  proxy?: string;
  /** On first DSH launch, prompt macOS for Accessibility + Screen Recording as DSH (not CuaDriver.app). Default true. */
  promptPermissions?: boolean;
}
/** Schemastery schema so Cordis fills defaults before `apply`. */
declare const Config: z<Config>;
//#endregion
//#region src/dsh-cuadrive-mac.d.ts
declare const name = "dsh-cuadrive-mac";
declare const inject: string[];
/**
 * DSH-owned Cua Driver: private daemon, first-class `cua_*` tools, DSH skill.
 * `defineTool` stays in this entry so `dshx check` sees a tool plugin.
 * apply() never spawnSync-downloads — host tools (including cua_status) register immediately.
 */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=index.d.mts.map