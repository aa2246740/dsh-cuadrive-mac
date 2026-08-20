import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendFileSync, chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
//#region src/argv.ts
const PLUGIN_ID = "dsh-cuadrive-mac";
const LOG = `[my-plugins/${PLUGIN_ID}]`;
const LEGACY_HOME_NAME = "dsh-cua-drive";
function isMacOS() {
	return process.platform === "darwin";
}
function dshHomeDir() {
	return process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
}
/** Private plugin state: vendor binary, socket, pid. Not the shared cua-driver cache. */
function pluginHome() {
	const home = join(dshHomeDir(), PLUGIN_ID);
	migrateLegacyHome(home);
	return home;
}
/** DSH-only cua-driver socket. Never `~/Library/Caches/cua-driver`. */
function defaultSocketPath() {
	return join(pluginHome(), "run", "driver.sock");
}
/** Prefix every CLI invocation with `--socket` when this plugin owns a daemon. */
function cliArgs(config, args) {
	if (!config.ownDaemon) return [...args];
	const socket = config.socketPath.trim();
	if (socket.length === 0) throw new Error(`${LOG} ownDaemon is on but socketPath is empty; refusing to talk to the shared cua-driver socket`);
	return [
		"--socket",
		socket,
		...args
	];
}
function migrateLegacyHome(home) {
	const legacy = join(dshHomeDir(), LEGACY_HOME_NAME);
	if (existsSync(home) || !existsSync(legacy)) return;
	mkdirSync(home, { recursive: true });
	for (const name of [
		"vendor",
		"cache",
		"bin",
		"permissions.json",
		"status.json",
		"download.log"
	]) {
		const from = join(legacy, name);
		const to = join(home, name);
		if (!existsSync(from) || existsSync(to)) continue;
		cpSync(from, to, { recursive: true });
	}
}
//#endregion
//#region src/config.ts
/** Schemastery schema so Cordis fills defaults before `apply`. */
const Config = z.object({
	binary: z.string().default(""),
	autoStart: z.boolean().default(true),
	timeoutMs: z.number().min(1e3).default(9e4),
	registerDriverTools: z.boolean().default(true),
	skillDir: z.string().default(""),
	sessionId: z.string().default("dsh"),
	heartbeatMs: z.number().min(5e3).default(6e4),
	ownDaemon: z.boolean().default(true),
	socketPath: z.string().default(""),
	proxy: z.string().default(""),
	promptPermissions: z.boolean().default(true)
});
/** Fill defaults for programmatic callers that skip Schemastery. */
function resolveConfig(config = {}) {
	const ownDaemon = config.ownDaemon ?? true;
	return {
		binary: config.binary?.trim() || "",
		autoStart: config.autoStart ?? true,
		timeoutMs: config.timeoutMs ?? 9e4,
		registerDriverTools: config.registerDriverTools ?? true,
		skillDir: config.skillDir?.trim() ?? "",
		sessionId: config.sessionId?.trim() || "dsh",
		heartbeatMs: config.heartbeatMs ?? 6e4,
		ownDaemon,
		socketPath: config.socketPath?.trim() || (ownDaemon ? defaultSocketPath() : ""),
		proxy: config.proxy?.trim() || "",
		promptPermissions: config.promptPermissions ?? true
	};
}
//#endregion
//#region src/runtime.ts
const LOCK_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime-lock.json");
const PID_NAME = "download.pid";
let installJob;
let downloadChild;
function loadRuntimeLock(path = LOCK_PATH) {
	const raw = JSON.parse(readFileSync(path, "utf8"));
	if (typeof raw.plugin !== "string" || typeof raw.driver !== "string" || typeof raw.driverTag !== "string") throw new Error(`${LOG} runtime-lock.json is missing plugin/driver pins`);
	if (typeof raw.skill !== "string") throw new Error(`${LOG} runtime-lock.json is missing skill pin`);
	if (!raw.artifacts || typeof raw.artifacts !== "object") throw new Error(`${LOG} runtime-lock.json is missing artifacts`);
	return raw;
}
function releaseArtifact(platform = process.platform, arch = process.arch, lock = loadRuntimeLock()) {
	const key = artifactKey(platform, arch);
	const item = lock.artifacts[key];
	if (!item) throw new Error(`${LOG} runtime-lock.json has no artifact ${key}`);
	return {
		...item,
		url: `https://github.com/trycua/cua/releases/download/${lock.driverTag}/${item.name}`
	};
}
function artifactKey(platform, arch) {
	if (platform === "darwin") return "darwin-universal-binary";
	throw new Error(`${LOG} dsh-cuadrive-mac supports macOS only (got ${platform}/${arch})`);
}
function vendorDir(lock = loadRuntimeLock()) {
	return join(pluginHome(), "vendor", lock.driver);
}
function cacheDir() {
	return join(pluginHome(), "cache");
}
function statusPath() {
	return join(pluginHome(), "status.json");
}
function downloadLogPath() {
	return join(pluginHome(), "download.log");
}
function manualCachePath(lock = loadRuntimeLock()) {
	return join(cacheDir(), releaseArtifact(process.platform, process.arch, lock).name);
}
function detectedProxy() {
	return (process.env.DSH_CUA_DRIVE_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "").trim();
}
function resolvedProxy(config = {}) {
	return (config.proxy?.trim() || detectedProxy()).trim();
}
function proxyHint(lock = loadRuntimeLock()) {
	const artifact = releaseArtifact(process.platform, process.arch, lock);
	return [
		`GitHub Releases is required (${artifact.url}).`,
		"If you need a proxy (梯子), set plugin config `proxy`, or env HTTPS_PROXY / ALL_PROXY / DSH_CUA_DRIVE_PROXY (example: http://127.0.0.1:7890), restart DSH, then call cua_status — the download resumes from the partial file.",
		`Or copy the exact file ${artifact.name} to ${manualCachePath(lock)} (sha256 must match runtime-lock.json).`,
		`Progress: ${statusPath()} and ${downloadLogPath()}.`
	].join(" ");
}
function curlDownloadArgs(url, dest, proxy = detectedProxy()) {
	const args = [
		"-L",
		"--fail",
		"--retry",
		"3",
		"--retry-delay",
		"2",
		"--retry-all-errors",
		"--connect-timeout",
		"15",
		"--progress-bar",
		"-C",
		"-",
		"-o",
		dest,
		url
	];
	if (proxy.length > 0) args.splice(0, 0, "-x", proxy);
	return args;
}
function vendorStampBody(lock, sha256) {
	return `${lock.plugin} ${lock.driver} ${sha256}`;
}
function findVendorBinary(lock = loadRuntimeLock()) {
	const root = vendorDir(lock);
	if (!existsSync(root)) return void 0;
	if (!vendorStampValid(root, lock, releaseArtifact(process.platform, process.arch, lock).sha256)) return void 0;
	const hit = walkForFile(root, process.platform === "win32" ? ["cua-driver.exe", "cua-driver"] : ["cua-driver"]);
	return hit && existsSync(hit) ? hit : void 0;
}
function runtimeAvailable(config) {
	const configured = config.binary.trim();
	if (configured.includes("/") || configured.includes("\\")) return existsSync(configured);
	return findVendorBinary() !== void 0;
}
function formatBytes(n) {
	if (!Number.isFinite(n) || n <= 0) return "0 B";
	if (n < 1024) return `${Math.round(n)} B`;
	if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1048576).toFixed(1)} MB`;
}
function parseCurlProgress(text) {
	const last = [...text.matchAll(/(\d{1,3}(?:\.\d+)?)%/g)].at(-1)?.[1];
	if (last === void 0) return 0;
	const value = Number(last);
	return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}
function classifyDownloadError(detail) {
	if (/407|proxy/i.test(detail)) return "Proxy rejected the request. Check plugin config `proxy` / HTTPS_PROXY / ALL_PROXY.";
	if (/timed out|timeout|Could not resolve|Failed to connect|Connection reset|Could not handshake|SSL|Connection refused/i.test(detail)) return proxyHint();
	if (/404|Not Found/i.test(detail)) return `Pinned artifact missing on GitHub. This plugin lock wants ${loadRuntimeLock().driverTag}.`;
	return proxyHint();
}
function readRuntimeStatus(lock = loadRuntimeLock()) {
	const artifact = releaseArtifact(process.platform, process.arch, lock);
	const vendor = findVendorBinary(lock);
	const fallback = baseStatus(lock, artifact, vendor);
	if (!existsSync(statusPath())) return fallback;
	try {
		const parsed = JSON.parse(readFileSync(statusPath(), "utf8"));
		if (vendor) return {
			...fallback,
			...parsed,
			...baseStatus(lock, artifact, vendor)
		};
		const bytes = Number.isFinite(parsed.bytes) ? Number(parsed.bytes) : fallback.bytes;
		const total = Number.isFinite(parsed.total) ? Number(parsed.total) : artifact.bytes;
		const percent = Number.isFinite(parsed.percent) ? Number(parsed.percent) : fallback.percent;
		return {
			...fallback,
			...parsed,
			plugin: lock.plugin,
			driver: lock.driver,
			skill: lock.skill,
			manualCachePath: manualCachePath(lock),
			artifactName: artifact.name,
			artifactUrl: artifact.url,
			statusPath: statusPath(),
			logPath: downloadLogPath(),
			percent,
			bytes,
			total,
			error: parsed.error ?? "",
			proxy: parsed.proxy ?? detectedProxy(),
			resumable: true,
			hint: parsed.hint || fallback.hint,
			message: parsed.message || fallback.message,
			phase: isPhase(parsed.phase) ? parsed.phase : fallback.phase
		};
	} catch {
		return fallback;
	}
}
function writeRuntimeStatus(patch) {
	const current = readRuntimeStatus();
	const next = JSON.parse(JSON.stringify({
		...current,
		...patch,
		plugin: current.plugin,
		driver: current.driver,
		skill: current.skill,
		manualCachePath: current.manualCachePath,
		artifactName: current.artifactName,
		artifactUrl: current.artifactUrl,
		statusPath: current.statusPath,
		logPath: current.logPath,
		resumable: true,
		error: patch.error ?? current.error ?? "",
		proxy: patch.proxy ?? current.proxy ?? detectedProxy(),
		percent: Number.isFinite(patch.percent) ? patch.percent : current.percent,
		bytes: Number.isFinite(patch.bytes) ? patch.bytes : current.bytes,
		total: Number.isFinite(patch.total) ? patch.total : current.total
	}));
	mkdirSync(pluginHome(), { recursive: true });
	writeFileSync(statusPath(), `${JSON.stringify(next, null, 2)}\n`);
	return next;
}
function baseStatus(lock, artifact, vendor) {
	const ready = vendor !== void 0;
	return {
		phase: ready ? "ready" : "missing",
		plugin: lock.plugin,
		driver: lock.driver,
		skill: lock.skill,
		percent: ready ? 100 : 0,
		bytes: ready ? artifact.bytes : existingBytes(manualCachePath(lock)),
		total: artifact.bytes,
		message: ready ? `Ready: cua-driver ${lock.driver} (plugin ${lock.plugin})` : `Need cua-driver ${lock.driver} for plugin ${lock.plugin}`,
		hint: ready ? "Private runtime is ready. Driver version is pinned to this plugin in runtime-lock.json." : proxyHint(lock),
		manualCachePath: manualCachePath(lock),
		artifactName: artifact.name,
		artifactUrl: artifact.url,
		statusPath: statusPath(),
		logPath: downloadLogPath(),
		proxy: detectedProxy(),
		error: "",
		resumable: true
	};
}
function isPhase(value) {
	return value === "missing" || value === "downloading" || value === "verifying" || value === "extracting" || value === "ready" || value === "error";
}
function existingBytes(path) {
	try {
		return existsSync(path) ? statSync(path).size : 0;
	} catch {
		return 0;
	}
}
/** Return the vendor binary if this plugin version already installed it. Never downloads. */
function ensureRuntimeSync(config = {
	binary: "",
	proxy: ""
}) {
	const configured = config.binary.trim();
	if (configured.includes("/") || configured.includes("\\")) {
		if (!existsSync(configured)) throw new Error(`${LOG} configured binary not found: ${configured}`);
		return configured;
	}
	const existing = findVendorBinary();
	if (existing) {
		writeRuntimeStatus({
			phase: "ready",
			percent: 100,
			message: `Ready: cua-driver ${loadRuntimeLock().driver} (plugin ${loadRuntimeLock().plugin})`,
			hint: "Private runtime is ready. Driver version is pinned to this plugin in runtime-lock.json.",
			error: ""
		});
		return existing;
	}
	const lock = loadRuntimeLock();
	throw new Error(`${LOG} runtime is not installed. Call cua_status. The plugin downloads cua-driver ${lock.driver} (locked to plugin ${lock.plugin}) into $DSH_HOME/dsh-cuadrive-mac/vendor.`);
}
/** Install the lock-pinned binary in the background. Safe to call from apply() — does not spawnSync a download. */
function ensureRuntime(config = {
	binary: "",
	proxy: ""
}) {
	try {
		const configured = config.binary.trim();
		if (configured.includes("/") || configured.includes("\\")) return Promise.resolve(ensureRuntimeSync(config));
		if (findVendorBinary()) return Promise.resolve(ensureRuntimeSync(config));
	} catch (error) {
		return Promise.reject(error);
	}
	installJob ??= installVendor(resolvedProxy(config)).finally(() => {
		installJob = void 0;
	});
	return installJob;
}
function abortRuntimeInstall() {
	const child = downloadChild;
	downloadChild = void 0;
	if (!child?.pid) return;
	try {
		child.kill("SIGTERM");
	} catch {}
}
async function installVendor(proxy) {
	const lock = loadRuntimeLock();
	const artifact = releaseArtifact(process.platform, process.arch, lock);
	mkdirSync(vendorDir(lock), { recursive: true });
	mkdirSync(cacheDir(), { recursive: true });
	const archive = join(cacheDir(), artifact.name);
	const other = otherDownloaderPid();
	if (other !== void 0) {
		appendDownloadLog(`waiting for pid ${other} to finish downloading ${artifact.name}`);
		const waited = await waitForOtherDownloader(other);
		if (waited) return waited;
	}
	if (!archiveChecksumOk(archive, artifact.sha256)) {
		writeRuntimeStatus({
			phase: "downloading",
			percent: percentOf(existingBytes(archive), artifact.bytes),
			bytes: existingBytes(archive),
			total: artifact.bytes,
			message: `Downloading cua-driver ${lock.driver} (${artifact.name})`,
			hint: proxyHint(lock),
			proxy,
			error: ""
		});
		writeDownloadPid();
		try {
			await downloadResumable(artifact.url, archive, artifact.bytes, proxy);
		} catch (error) {
			clearDownloadPid();
			throw error;
		}
		clearDownloadPid();
	}
	writeRuntimeStatus({
		phase: "verifying",
		message: `Verifying ${artifact.name}`,
		percent: 99,
		bytes: existingBytes(archive),
		total: artifact.bytes,
		proxy,
		error: ""
	});
	const digest = sha256File(archive);
	if (digest !== artifact.sha256) {
		try {
			unlinkSync(archive);
		} catch {}
		const error = `checksum mismatch for ${artifact.name}: expected ${artifact.sha256}, got ${digest}`;
		writeRuntimeStatus({
			phase: "error",
			error,
			message: error,
			hint: proxyHint(lock),
			percent: 0,
			bytes: 0
		});
		throw new Error(`${LOG} ${error}`);
	}
	writeRuntimeStatus({
		phase: "extracting",
		message: `Extracting ${artifact.name}`,
		percent: 99,
		proxy,
		error: ""
	});
	const binary = extractVendor(archive, lock, artifact.sha256);
	removeOtherVendorVersions(lock.driver);
	writeRuntimeStatus({
		phase: "ready",
		percent: 100,
		bytes: artifact.bytes,
		total: artifact.bytes,
		message: `Ready: cua-driver ${lock.driver} (plugin ${lock.plugin})`,
		hint: "Private runtime is ready. Driver version is pinned to this plugin in runtime-lock.json.",
		error: "",
		proxy
	});
	return binary;
}
function extractVendor(archive, lock, sha256) {
	const dest = vendorDir(lock);
	const tmp = `${dest}.new`;
	rmSync(tmp, {
		recursive: true,
		force: true
	});
	mkdirSync(tmp, { recursive: true });
	try {
		extractArchive(archive, tmp);
		const names = process.platform === "win32" ? ["cua-driver.exe", "cua-driver"] : ["cua-driver"];
		const binary = walkForFile(tmp, names);
		if (!binary) {
			const error = `extracted cua-driver binary was not found under ${tmp}`;
			writeRuntimeStatus({
				phase: "error",
				error,
				message: error,
				hint: proxyHint(lock)
			});
			throw new Error(`${LOG} ${error}`);
		}
		if (process.platform !== "win32") chmodSync(binary, 493);
		writeVendorStamp(tmp, lock, sha256);
		rmSync(dest, {
			recursive: true,
			force: true
		});
		renameSync(tmp, dest);
		const installed = walkForFile(dest, names);
		if (!installed) throw new Error(`${LOG} extracted cua-driver binary was not found under ${dest}`);
		return installed;
	} catch (error) {
		rmSync(tmp, {
			recursive: true,
			force: true
		});
		throw error;
	}
}
function downloadResumable(url, dest, total, proxy) {
	mkdirSync(dirname(dest), { recursive: true });
	if (existingBytes(dest) > total && total > 0) try {
		unlinkSync(dest);
	} catch {}
	appendDownloadLog(`download ${url} -> ${dest} resume=${formatBytes(existingBytes(dest))} / ${formatBytes(total)} proxy=${proxy || "none"}`);
	return new Promise((resolve, reject) => {
		const args = curlDownloadArgs(url, dest, proxy);
		const log = createWriteStream(downloadLogPath(), { flags: "a" });
		const child = spawn("curl", args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		downloadChild = child;
		let stderr = "";
		const tick = setInterval(() => {
			const bytes = existingBytes(dest);
			const bar = parseCurlProgress(stderr);
			const percent = Math.min(99, Math.round(Math.max(percentOf(bytes, total), bar)));
			writeRuntimeStatus({
				phase: "downloading",
				bytes,
				total,
				percent,
				message: `Downloading cua-driver ${loadRuntimeLock().driver} — ${formatBytes(bytes)} / ${formatBytes(total)} (${percent}%)`,
				hint: proxyHint(),
				proxy,
				error: ""
			});
		}, 500);
		child.stdout?.on("data", (chunk) => {
			log.write(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stderr += text;
			if (stderr.length > 32768) stderr = stderr.slice(-16384);
			log.write(chunk);
		});
		child.once("error", (error) => {
			clearInterval(tick);
			log.end();
			downloadChild = void 0;
			const detail = error.message;
			failDownload(dest, total, `${detail}. ${error.message.includes("ENOENT") || error.code === "ENOENT" ? "curl is not installed on PATH" : classifyDownloadError(detail)}`, proxy);
			reject(/* @__PURE__ */ new Error(`${LOG} failed to download ${url}: ${detail}`));
		});
		child.once("close", (code, signal) => {
			clearInterval(tick);
			log.end();
			downloadChild = void 0;
			const bytes = existingBytes(dest);
			writeRuntimeStatus({
				phase: code === 0 ? "verifying" : "error",
				bytes,
				total,
				percent: percentOf(bytes, total),
				proxy
			});
			if (code === 0) {
				resolve();
				return;
			}
			const detail = (stderr.trim() || `curl exit ${String(code)}${signal ? ` signal ${signal}` : ""}`).slice(-2e3);
			if (signal === "SIGTERM") {
				const error = `Download paused at ${percentOf(bytes, total)}% (${formatBytes(bytes)} / ${formatBytes(total)}). It will resume on next DSH start or cua_status.`;
				writeRuntimeStatus({
					phase: "error",
					error,
					message: error,
					hint: proxyHint(),
					bytes,
					total,
					percent: percentOf(bytes, total),
					proxy
				});
				reject(/* @__PURE__ */ new Error(`${LOG} ${error}`));
				return;
			}
			failDownload(dest, total, `${`download failed: ${detail}`} ${classifyDownloadError(detail)}`, proxy);
			reject(/* @__PURE__ */ new Error(`${LOG} failed to download ${url}: ${detail}`));
		});
	});
}
function failDownload(dest, total, error, proxy) {
	const bytes = existingBytes(dest);
	writeRuntimeStatus({
		phase: "error",
		error,
		message: error,
		hint: proxyHint(),
		bytes,
		total,
		percent: percentOf(bytes, total),
		proxy
	});
	appendDownloadLog(`ERROR ${error}`);
}
function percentOf(bytes, total) {
	if (!(total > 0) || !(bytes >= 0)) return 0;
	return Math.min(99, Math.round(100 * bytes / total));
}
function extractArchive(archive, dest) {
	mkdirSync(dest, { recursive: true });
	const tar = spawnSync("tar", [
		"-xf",
		archive,
		"-C",
		dest
	], { encoding: "utf8" });
	if (tar.status === 0) return;
	if (archive.endsWith(".zip")) {
		const unzip = spawnSync("unzip", [
			"-o",
			archive,
			"-d",
			dest
		], { encoding: "utf8" });
		if (unzip.status === 0) return;
		throw new Error(`${LOG} failed to extract ${archive}: ${(unzip.stderr || unzip.stdout || unzip.error?.message || `exit ${String(unzip.status)}`).trim()}`);
	}
	throw new Error(`${LOG} failed to extract ${archive}: ${(tar.stderr || tar.stdout || tar.error?.message || `exit ${String(tar.status)}`).trim()}`);
}
function archiveChecksumOk(path, sha256) {
	if (!existsSync(path)) return false;
	try {
		return sha256File(path) === sha256;
	} catch {
		return false;
	}
}
function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function stampPath(root) {
	return join(root, ".lock");
}
function vendorStampValid(root, lock, sha256) {
	const path = stampPath(root);
	if (!existsSync(path)) return false;
	return readFileSync(path, "utf8").trim() === vendorStampBody(lock, sha256);
}
function writeVendorStamp(root, lock, sha256) {
	mkdirSync(root, { recursive: true });
	const body = vendorStampBody(lock, sha256);
	writeFileSync(stampPath(root), `${body}\n`, "utf8");
	return body;
}
function walkForFile(root, names) {
	const entries = readdirSync(root, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isFile() && names.includes(entry.name)) return path;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const nested = walkForFile(join(root, entry.name), names);
		if (nested) return nested;
	}
}
function removeOtherVendorVersions(keep) {
	const root = join(pluginHome(), "vendor");
	if (!existsSync(root)) return;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name === keep) continue;
		rmSync(join(root, entry.name), {
			recursive: true,
			force: true
		});
	}
}
function downloadPidPath() {
	return join(cacheDir(), PID_NAME);
}
function writeDownloadPid() {
	mkdirSync(cacheDir(), { recursive: true });
	writeFileSync(downloadPidPath(), `${process.pid}\n`);
}
function clearDownloadPid() {
	try {
		unlinkSync(downloadPidPath());
	} catch {}
}
function otherDownloaderPid() {
	const path = downloadPidPath();
	if (!existsSync(path)) return void 0;
	const pid = Number(readFileSync(path, "utf8").trim());
	if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return void 0;
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		return;
	}
}
async function waitForOtherDownloader(pid) {
	const deadline = Date.now() + 9e5;
	while (Date.now() < deadline) {
		const vendor = findVendorBinary();
		if (vendor) return vendor;
		try {
			process.kill(pid, 0);
		} catch {
			return findVendorBinary();
		}
		await sleep$1(1e3);
	}
	return findVendorBinary();
}
function appendDownloadLog(line) {
	mkdirSync(pluginHome(), { recursive: true });
	appendFileSync(downloadLogPath(), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line}\n`);
}
function sleep$1(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region src/binary.ts
/**
* Resolve the plugin-private cua-driver binary.
* An absolute `configured` path is an explicit override (debug only).
* The default never searches `/Applications` or `~/.local/bin`.
*/
function resolveBinary(configured) {
	if (configured.includes("/") || configured.includes("\\")) {
		if (!existsSync(configured)) throw new Error(`${LOG} configured binary not found: ${configured}`);
		return configured;
	}
	const vendor = findVendorBinary();
	if (vendor) return vendor;
	const lock = loadRuntimeLock();
	throw new Error(`${LOG} runtime is not installed. Call cua_status. The plugin downloads cua-driver ${lock.driver} (locked to plugin ${lock.plugin}) into $DSH_HOME/dsh-cuadrive-mac/vendor.`);
}
//#endregion
//#region src/host-id.ts
/** Best-effort CFBundleIdentifier of the app that spawned this plugin. */
function detectHostBundleId() {
	return detectHost().bundleId;
}
function detectHost() {
	const envId = (process.env.CUA_DRIVER_HOST_BUNDLE_ID || process.env.DSH_APP_BUNDLE_ID || "").trim();
	const envLabel = (process.env.DSH_APP_NAME || "").trim();
	if (envId.length > 0) return {
		bundleId: envId,
		label: envLabel || labelFromBundleId(envId),
		kind: "app",
		executable: process.execPath
	};
	if (process.platform !== "darwin") return {
		bundleId: "",
		label: "this dsh process",
		kind: "cli",
		executable: process.execPath
	};
	const fromExe = identityFromExecutable(process.execPath);
	if (fromExe) return fromExe;
	let pid = process.ppid;
	for (let i = 0; i < 10 && pid > 1; i++) {
		const info = processInfo(pid);
		if (!info) break;
		const id = identityFromExecutable(info.comm);
		if (id) return id;
		pid = info.ppid;
	}
	return {
		bundleId: "",
		label: "the terminal or IDE that launched dsh",
		kind: "cli",
		executable: process.execPath
	};
}
function parsePlistBundleId(xml) {
	return parsePlistString(xml, "CFBundleIdentifier");
}
function parsePlistString(xml, key) {
	return new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>\\s*([^<]+)\\s*</string>`, "i").exec(xml)?.[1]?.trim() ?? "";
}
function identityFromExecutable(executable) {
	const normalized = executable.replace(/\\/g, "/");
	const at = normalized.toLowerCase().lastIndexOf(".app/Contents/MacOS/");
	if (at < 0) return void 0;
	const appRoot = normalized.slice(0, at + 4);
	const plist = join(appRoot, "Contents", "Info.plist");
	if (!existsSync(plist)) return {
		bundleId: "",
		label: appRoot.split("/").filter(Boolean).at(-1)?.replace(/\.app$/i, "") ?? "host app",
		kind: "app",
		executable: normalized
	};
	const bundleId = readPlistField(plist, "CFBundleIdentifier") || parsePlistBundleId(safeRead(plist));
	return {
		bundleId,
		label: readPlistField(plist, "CFBundleDisplayName") || readPlistField(plist, "CFBundleName") || parsePlistString(safeRead(plist), "CFBundleDisplayName") || parsePlistString(safeRead(plist), "CFBundleName") || labelFromBundleId(bundleId) || "host app",
		kind: "app",
		executable: normalized
	};
}
function readPlistField(plist, key) {
	const result = spawnSync("plutil", [
		"-extract",
		key,
		"raw",
		"-o",
		"-",
		plist
	], {
		encoding: "utf8",
		timeout: 2e3
	});
	if (result.status !== 0) return "";
	const value = (result.stdout || "").trim();
	if (!value || value === "(null)" || /error|could not/i.test(value)) return "";
	return value;
}
function labelFromBundleId(bundleId) {
	if (bundleId === "local.dsh.desktop") return "DSH";
	return bundleId.split(".").filter(Boolean).at(-1) || bundleId || "host app";
}
function safeRead(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
function processInfo(pid) {
	const result = spawnSync("ps", [
		"-p",
		String(pid),
		"-o",
		"ppid=,comm="
	], {
		encoding: "utf8",
		timeout: 2e3
	});
	if (result.status !== 0) return void 0;
	const split = (result.stdout || "").trim().match(/^(\d+)\s+(.+)$/);
	if (!split) return void 0;
	return {
		ppid: Number(split[1]),
		comm: split[2].trim()
	};
}
//#endregion
//#region src/daemon.ts
const DAEMON_WAIT_MS = 12e3;
let ownedChild;
/** Args/env for the DSH-owned daemon. Never `open -a CuaDriver`. */
function serveLaunch(config, binary) {
	const hostBundleId = detectHostBundleId();
	return {
		command: binary,
		args: cliArgs(config, [
			"serve",
			"--embedded",
			"--no-permissions-gate"
		]),
		env: {
			...process.env,
			CUA_DRIVER_EMBEDDED: "1",
			...hostBundleId ? { CUA_DRIVER_HOST_BUNDLE_ID: hostBundleId } : {}
		}
	};
}
/** Start a DSH-private cua-driver serve and stop only that instance on unload. */
function startOwnedDaemon(ctx, config) {
	if (!config.ownDaemon) return;
	ctx.effect(() => {
		return () => {
			stopOwnedDaemon(config);
		};
	}, "dsh-cuadrive-mac.daemon");
}
/** Restart the DSH-owned serve so it re-reads host TCC after a first-launch grant. */
async function restartOwnedDaemon(config, signal) {
	stopOwnedDaemon(config);
	await ensureOwnedDaemon(config, signal);
}
/** Bring up `serve --embedded --socket <dsh socket>` without touching the default daemon. */
async function ensureOwnedDaemon(config, signal) {
	if (!config.ownDaemon) return;
	if (ownedDaemonRunning(config)) return;
	if (!config.autoStart) throw new Error(`${LOG} DSH cua-driver daemon is not running on ${config.socketPath}.`);
	mkdirSync(dirname(config.socketPath), { recursive: true });
	unlinkStaleSocket(config.socketPath);
	startOwnedServe(config);
	const deadline = Date.now() + DAEMON_WAIT_MS;
	while (Date.now() < deadline) {
		signal?.throwIfAborted();
		await sleep(400, signal);
		if (ownedDaemonRunning(config)) return;
	}
	throw new Error(`${LOG} owned daemon did not come up on ${config.socketPath} within ${DAEMON_WAIT_MS}ms`);
}
/** Stop only the DSH socket. Never a bare `cua-driver stop`. */
function stopOwnedDaemon(config) {
	if (!config.ownDaemon || config.socketPath.trim().length === 0) return;
	const child = ownedChild;
	ownedChild = void 0;
	if (child?.pid) try {
		child.kill("SIGTERM");
	} catch {}
	try {
		const binary = resolveBinary(config.binary);
		spawnSync(binary, cliArgs(config, ["stop"]), {
			encoding: "utf8",
			timeout: 8e3,
			env: process.env
		});
	} catch {}
}
function ownedDaemonRunning(config) {
	if (!config.ownDaemon) return false;
	let binary;
	try {
		binary = resolveBinary(config.binary);
	} catch {
		return false;
	}
	const result = spawnSync(binary, cliArgs(config, ["status", "--json"]), {
		encoding: "utf8",
		timeout: 5e3,
		env: process.env
	});
	const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	return result.status === 0 && /daemon is running/i.test(text);
}
function startOwnedServe(config) {
	const launch = serveLaunch(config, resolveBinary(config.binary));
	const child = spawn(launch.command, launch.args, {
		env: launch.env,
		stdio: "ignore",
		detached: false
	});
	child.unref();
	ownedChild = child;
}
function unlinkStaleSocket(socketPath) {
	if (!existsSync(socketPath)) return;
	try {
		unlinkSync(socketPath);
	} catch {}
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(signal.reason ?? /* @__PURE__ */ new Error("aborted"));
		}, { once: true });
	});
}
//#endregion
//#region src/parse.ts
const SCHEMA_KEEP = /* @__PURE__ */ new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"examples"
]);
/** Split `cua-driver list-tools` `name: summary` lines. */
function parseListTools(text) {
	const tools = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const colon = trimmed.indexOf(":");
		if (colon <= 0) continue;
		const name = trimmed.slice(0, colon).trim();
		if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) continue;
		tools.push({
			name,
			summary: trimmed.slice(colon + 1).trim()
		});
	}
	return tools;
}
/** Parse `cua-driver describe <tool>` into name, prose, and input JSON Schema. */
function parseDescribe(text) {
	const name = /^name:\s*(\S+)\s*$/m.exec(text)?.[1];
	if (name === void 0) throw new Error("cua-driver describe: missing name");
	const schemaMatch = /^input_schema:\s*$/m.exec(text);
	if (schemaMatch === null || schemaMatch.index === void 0) throw new Error(`cua-driver describe ${name}: missing input_schema`);
	return {
		name,
		description: text.slice(0, schemaMatch.index).replace(/^name:\s*\S+\s*/m, "").replace(/^description:\s*/m, "").trim(),
		inputSchema: asSchemaObject(extractJson(text.slice(schemaMatch.index + schemaMatch[0].length)), name)
	};
}
/** Strip YAML frontmatter used by the official cua-driver SKILL.md. */
function parseFrontmatter(raw) {
	if (!raw.startsWith("---")) return { body: raw };
	const newline = raw.indexOf("\n");
	if (newline < 0) return { body: raw };
	const rest = raw.slice(newline + 1);
	const end = rest.search(/\n---[ \t]*\r?\n/);
	if (end < 0) return { body: raw };
	const fm = rest.slice(0, end);
	const body = rest.slice(end).replace(/^\n---[ \t]*\r?\n/, "");
	return {
		name: matchField(fm, "name"),
		description: matchField(fm, "description"),
		body
	};
}
/** Parse the first JSON value in `text`, ignoring leading prose. */
function extractJson(text) {
	const start = text.search(/[\[{]/);
	if (start < 0) throw new Error("expected JSON object or array");
	const slice = text.slice(start);
	try {
		return JSON.parse(slice);
	} catch {
		return JSON.parse(sliceFirstJson(slice));
	}
}
/**
* Drop JSON Schema keywords DSH's tool registry does not enforce
* (`minimum`, `pattern`, nested `additionalProperties` objects, …).
*/
function sanitizeJsonSchema(input) {
	if (!isPlainObject$1(input)) return {
		type: "object",
		additionalProperties: true
	};
	const out = {};
	for (const [key, value] of Object.entries(input)) {
		if (!SCHEMA_KEEP.has(key)) continue;
		if (key === "properties" && isPlainObject$1(value)) {
			const properties = {};
			for (const [name, node] of Object.entries(value)) properties[name] = sanitizeJsonSchema(node);
			out.properties = properties;
		} else if (key === "items") out.items = sanitizeJsonSchema(value);
		else if (key === "oneOf" && Array.isArray(value) && value.length >= 2) out.oneOf = value.map((item) => sanitizeJsonSchema(item));
		else if (key === "additionalProperties") out.additionalProperties = typeof value === "boolean" ? value : true;
		else if (key === "required" && Array.isArray(value) && value.every((item) => typeof item === "string")) out.required = value;
		else out[key] = value;
	}
	if (isPlainObject$1(out.properties) && Array.isArray(out.required)) {
		const declared = new Set(Object.keys(out.properties));
		out.required = out.required.filter((name) => declared.has(name));
	}
	return out;
}
function matchField(fm, field) {
	const value = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim();
	return value && value.length > 0 ? value : void 0;
}
function asSchemaObject(value, tool) {
	if (!isPlainObject$1(value)) throw new Error(`cua-driver describe ${tool}: input_schema is not an object`);
	return value;
}
function isPlainObject$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sliceFirstJson(text) {
	const open = text[0];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escape) escape = false;
			else if (char === "\\") escape = true;
			else if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === open) depth++;
		else if (char === close) {
			depth--;
			if (depth === 0) return text.slice(0, index + 1);
		}
	}
	throw new Error("unterminated JSON");
}
//#endregion
//#region src/driver.ts
const execFile$1 = promisify(execFile);
const MAX_BUFFER = 33554432;
/** Run cua-driver and throw the combined stderr/stdout on a non-zero exit. */
async function runDriver(config, args, options = {}) {
	const binary = resolveBinary(config.binary);
	const argv = cliArgs(config, args);
	try {
		const result = await execFile$1(binary, argv, {
			encoding: "utf8",
			maxBuffer: MAX_BUFFER,
			timeout: options.timeoutMs ?? config.timeoutMs,
			signal: options.signal,
			env: process.env
		});
		return {
			stdout: result.stdout,
			stderr: result.stderr
		};
	} catch (error) {
		throw driverError(binary, argv, error);
	}
}
/** Synchronous CLI used during `apply` (list/describe). */
function runDriverSync(config, args, timeoutMs = 15e3) {
	const binary = resolveBinary(config.binary);
	const argv = cliArgs(config, args);
	const result = spawnSync(binary, argv, {
		encoding: "utf8",
		maxBuffer: MAX_BUFFER,
		timeout: timeoutMs,
		env: process.env
	});
	if (result.error) throw driverError(binary, argv, result.error);
	if (result.status !== 0) throw new Error(formatFailure(binary, argv, result.stdout, result.stderr, result.status));
	return {
		stdout: result.stdout,
		stderr: result.stderr
	};
}
/** `cua-driver list-tools`. Does not need the daemon. */
function listDriverTools(config) {
	return parseListTools(runDriverSync({
		...config,
		ownDaemon: false,
		socketPath: ""
	}, ["list-tools"]).stdout);
}
/** `cua-driver describe <name>`. Does not need the daemon. */
function describeDriverTool(config, tool) {
	return parseDescribe(runDriverSync({
		...config,
		ownDaemon: false,
		socketPath: ""
	}, ["describe", tool]).stdout);
}
/** `cua-driver call <tool> <json>`. Requires the DSH-owned daemon. */
async function callDriverTool(config, tool, args, options = {}) {
	await ensureDaemon(config, options.signal);
	const argv = [
		"call",
		tool,
		JSON.stringify(args)
	];
	if (options.screenshotOutFile) argv.push("--screenshot-out-file", options.screenshotOutFile);
	const run = await runDriver(config, argv, { signal: options.signal });
	return normalizeDriverOutput(run.stdout.trim() || run.stderr.trim());
}
/** Timeout replies are plaintext + exit 0; success is JSON. */
function normalizeDriverOutput(text) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: true };
	try {
		return extractJson(trimmed);
	} catch {
		return { text: trimmed };
	}
}
/** Best-effort daemon probe against this plugin's socket. */
async function readDaemonStatus(config, signal) {
	try {
		const run = await runDriver(config, ["status", "--json"], {
			signal,
			timeoutMs: 8e3
		});
		const payload = safeJson(run.stdout);
		return {
			running: isRunningPayload(payload) || /daemon is running/i.test(run.stdout),
			raw: run.stdout,
			payload
		};
	} catch (error) {
		return {
			running: false,
			raw: error instanceof Error ? error.message : String(error)
		};
	}
}
/** Live TCC of the DSH host via the private daemon (`check_permissions`). Not `permissions status` (that talks to CuaDriver.app). */
async function readPermissions(config, signal) {
	try {
		const run = await runDriver(config, [
			"call",
			"check_permissions",
			JSON.stringify({ prompt: false })
		], {
			signal,
			timeoutMs: 8e3
		});
		return normalizeDriverOutput(run.stdout.trim() || run.stderr.trim());
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
/** `cua-driver doctor --json` when the flag works; otherwise doctor text. */
async function readDoctor(config, signal) {
	try {
		const run = await runDriver({
			...config,
			ownDaemon: false,
			socketPath: ""
		}, ["doctor", "--json"], {
			signal,
			timeoutMs: 12e3
		});
		return safeJson(run.stdout) ?? run.stdout;
	} catch {
		try {
			return (await runDriver({
				...config,
				ownDaemon: false,
				socketPath: ""
			}, ["doctor"], {
				signal,
				timeoutMs: 12e3
			})).stdout;
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}
}
/** First-open ScreenCaptureKit probe so macOS lists DSH in Screen Recording before a real GUI task. */
async function warmHostCapture(config, signal) {
	if (process.platform !== "darwin") return;
	try {
		await callDriverTool(config, "get_desktop_state", { ...config.sessionId ? { session: config.sessionId } : {} }, { signal });
	} catch {}
}
/** Start the DSH-owned daemon (never the shared default socket). */
async function ensureDaemon(config, signal) {
	if (config.ownDaemon) {
		await ensureOwnedDaemon(config, signal);
		return;
	}
	throw new Error("dsh-cuadrive-mac requires ownDaemon; it does not share the default cua-driver socket");
}
function isRunningPayload(payload) {
	if (!payload || typeof payload !== "object") return false;
	const record = payload;
	if (record.running === true) return true;
	if (typeof record.status === "string" && /running/i.test(record.status)) return true;
	return false;
}
function safeJson(text) {
	try {
		return extractJson(text);
	} catch {
		return;
	}
}
function driverError(binary, args, error) {
	if (isExecError(error)) return new Error(formatFailure(binary, args, error.stdout, error.stderr, error.status ?? error.code));
	if (error instanceof Error && error.code === "ENOENT") return /* @__PURE__ */ new Error(`cua-driver executable not found (${binary}). Call cua_status — dsh-cuadrive-mac vendors its own lock-pinned binary and does not use /Applications/CuaDriver.app.`);
	return error instanceof Error ? error : new Error(String(error));
}
function formatFailure(binary, args, stdout, stderr, status) {
	const detail = (stderr || stdout || "").trim() || `exit ${String(status)}`;
	return `cua-driver ${args.join(" ")} failed (bin=${binary}): ${detail}`;
}
function isExecError(error) {
	return typeof error === "object" && error !== null && ("stdout" in error || "stderr" in error);
}
//#endregion
//#region src/permissions.ts
const ACCESSIBILITY_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const SCREEN_RECORDING_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const TCC_PROMPT_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "host-tcc-prompt.c");
function permissionsStatePath() {
	return join(pluginHome(), "permissions.json");
}
function tccPromptHelperPath() {
	return join(pluginHome(), "bin", `host-tcc-prompt-${process.arch}`);
}
function tccPromptClangArgs(source = TCC_PROMPT_SOURCE, dest = tccPromptHelperPath()) {
	return [
		"-Os",
		"-framework",
		"ApplicationServices",
		"-framework",
		"CoreGraphics",
		"-framework",
		"CoreFoundation",
		"-o",
		dest,
		source
	];
}
function parseTccPromptOutput(text) {
	try {
		const parsed = JSON.parse(text.trim());
		if (typeof parsed.accessibility !== "boolean" || typeof parsed.screenRecording !== "boolean") return void 0;
		return {
			accessibility: parsed.accessibility,
			screenRecording: parsed.screenRecording
		};
	} catch {
		return;
	}
}
function readHostPermissions() {
	const fallback = emptyPermissions();
	if (!existsSync(permissionsStatePath())) return fallback;
	try {
		const parsed = JSON.parse(readFileSync(permissionsStatePath(), "utf8"));
		return JSON.parse(JSON.stringify({
			...fallback,
			...parsed,
			error: parsed.error ?? "",
			hint: parsed.hint ?? fallback.hint,
			helper: parsed.helper ?? "",
			hostBundleId: parsed.hostBundleId ?? detectHost().bundleId,
			hostLabel: parsed.hostLabel ?? detectHost().label,
			hostKind: parsed.hostKind === "cli" || parsed.hostKind === "app" ? parsed.hostKind : detectHost().kind
		}));
	} catch {
		return fallback;
	}
}
function writeHostPermissions(patch) {
	const current = readHostPermissions();
	const next = JSON.parse(JSON.stringify({
		...current,
		...patch,
		error: patch.error ?? current.error ?? ""
	}));
	mkdirSync(pluginHome(), { recursive: true });
	writeFileSync(permissionsStatePath(), `${JSON.stringify(next, null, 2)}\n`);
	return next;
}
function emptyPermissions() {
	const macos = process.platform === "darwin";
	const host = detectHost();
	return {
		platform: process.platform,
		prompted: false,
		promptedAt: "",
		accessibility: !macos,
		screenRecording: !macos,
		hostBundleId: host.bundleId,
		hostLabel: host.label,
		hostKind: host.kind,
		helper: "",
		hint: macos ? grantHint(host.label, host.kind, true, true) : "Host TCC prompts are macOS-only. CLI dsh (no app pack) works on this platform.",
		error: "",
		settingsOpened: false
	};
}
/**
* Ask macOS for Accessibility + Screen Recording as the DSH host.
* Never runs `cua-driver permissions grant` (that launches CuaDriver.app).
*/
async function ensureHostPermissions(config) {
	if (process.platform !== "darwin" || config.promptPermissions === false) return writeHostPermissions({
		prompted: false,
		accessibility: true,
		screenRecording: true,
		hint: process.platform === "darwin" ? "Permission prompting is disabled in config." : "Host TCC prompts are macOS-only."
	});
	const host = detectHost();
	const helper = ensureTccPromptHelper();
	let grants = {
		accessibility: false,
		screenRecording: false
	};
	let helperPath = helper ?? "";
	let error = "";
	if (helper) try {
		grants = await runTccPromptHelper(helper);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	else error = "could not build the DSH TCC helper (clang missing?)";
	const missing = [];
	if (!grants.accessibility) missing.push("Accessibility");
	if (!grants.screenRecording) missing.push("Screen Recording");
	let settingsOpened = readHostPermissions().settingsOpened;
	if (missing.length > 0 && !settingsOpened) {
		openPrivacySettings(!grants.accessibility, !grants.screenRecording);
		settingsOpened = true;
	}
	const hint = grantHint(host.label, host.kind, grants.accessibility, grants.screenRecording);
	return writeHostPermissions({
		prompted: true,
		promptedAt: (/* @__PURE__ */ new Date()).toISOString(),
		accessibility: grants.accessibility,
		screenRecording: grants.screenRecording,
		hostBundleId: host.bundleId,
		hostLabel: host.label,
		hostKind: host.kind,
		helper: helperPath,
		hint,
		error,
		settingsOpened
	});
}
function grantHint(label, kind, accessibility, screenRecording) {
	const who = label.trim() || (kind === "cli" ? "the terminal or IDE that launched dsh" : "the DSH host");
	const cli = kind === "cli" ? " This dsh process is CLI (no DSH.app pack). macOS lists the terminal or IDE that launched `dsh`, not a DSH icon." : "";
	if (accessibility && screenRecording) return `${who} has Accessibility and Screen Recording.${cli} Grant belongs to that host, not CuaDriver.app.`;
	return `Enable ${[...accessibility ? [] : ["Accessibility"], ...screenRecording ? [] : ["Screen Recording"]].join(" and ")} for ${who} in System Settings → Privacy & Security, then restart dsh.${cli} Do not grant CuaDriver.app for this plugin.`;
}
function permissionsHint(state) {
	if (process.platform !== "darwin") return "";
	if (state.accessibility && state.screenRecording) return state.hint;
	return state.hint;
}
function ensureTccPromptHelper() {
	const dest = tccPromptHelperPath();
	if (existsSync(dest) && existsSync(TCC_PROMPT_SOURCE)) try {
		if (statSync(dest).mtimeMs >= statSync(TCC_PROMPT_SOURCE).mtimeMs) return dest;
	} catch {}
	if (!existsSync(TCC_PROMPT_SOURCE)) return void 0;
	mkdirSync(dirname(dest), { recursive: true });
	if (spawnSync("clang", tccPromptClangArgs(TCC_PROMPT_SOURCE, dest), {
		encoding: "utf8",
		timeout: 3e4
	}).status !== 0 || !existsSync(dest)) return;
	return dest;
}
function runTccPromptHelper(helper) {
	return new Promise((resolve, reject) => {
		const child = spawn(helper, [], { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.once("close", (code) => {
			const parsed = parseTccPromptOutput(stdout);
			if (parsed) {
				resolve(parsed);
				return;
			}
			reject(/* @__PURE__ */ new Error(`${LOG} TCC helper failed (exit ${String(code)}): ${(stderr || stdout).trim() || "no output"}`));
		});
	});
}
function openPrivacySettings(accessibility, screenRecording) {
	if (accessibility) spawn("open", [ACCESSIBILITY_SETTINGS_URL], {
		stdio: "ignore",
		detached: true
	}).unref();
	if (screenRecording) spawn("open", [SCREEN_RECORDING_SETTINGS_URL], {
		stdio: "ignore",
		detached: true
	}).unref();
}
//#endregion
//#region src/session-host.ts
/** Keep the plugin-owned cua session alive for the DSH process, like Codex's MCP connection. */
function startHostedSession(ctx, config) {
	if (config.sessionId.length === 0) return;
	const tick = () => {
		callDriverTool(config, "start_session", { session: config.sessionId }).catch((error) => {
			ctx.logger.warn(`${LOG} hosted session refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	};
	tick();
	ctx.effect(() => {
		const timer = setInterval(tick, config.heartbeatMs);
		return () => clearInterval(timer);
	}, "dsh-cuadrive-mac.session-host");
}
//#endregion
//#region src/skill.ts
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED_SKILL_DIR = join(PLUGIN_ROOT, "skill");
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

`;
const PROMPT_TEXT = [
	"When the user wants to operate a native desktop or GUI app (click, type, read a window, drive Slack/Finder/browser chrome, etc.), use the already-registered cua_* tools yourself — do not wait for the user to name Cua, computer use, or a skill.",
	"Typical loop: cua_list_apps or cua_launch_app → cua_get_window_state(pid, window_id) → cua_click / cua_type_text / cua_set_value on a fresh element_token → verify with another snapshot.",
	"If cua_* returns runtime_not_ready, call cua_status, tell the user the download percent and whether they need a proxy (梯子) or to drop the tarball at manualCachePath, and keep polling cua_status. Do not run curl/cua-driver update yourself.",
	"If cua_status says Accessibility or Screen Recording is missing, tell the user to allow the host named in hostPermissions.hostLabel (DSH.app, or the terminal/IDE if they run CLI dsh with no app pack) in System Settings — not CuaDriver.app — and restart dsh. Do not run cua-driver permissions grant.",
	"The dsh-cuadrive-mac skill in the session catalog is this macOS-only DSH plugin's contract; load it with the skill tool when you need the long loop. Tools work without that load.",
	"Do not shell out to cua-driver, open, osascript, or cliclick. Do not use another agent's cua-driver socket or skill."
].join(" ");
/** Register the DSH-owned skill plus a short standing transport note. */
function registerCuaSkill(ctx, config) {
	const dir = resolveSkillDir(config);
	const official = readOfficialSkill(dir);
	const skills = ctx.get("skills");
	if (skills) {
		skills.register({
			name: "dsh-cuadrive-mac",
			description: official.description,
			source: "runtime",
			content: `${DSH_TRANSPORT}${official.body}`,
			path: join(dir, "SKILL.md"),
			resourceBase: {
				kind: "directory",
				path: dir
			}
		});
		console.log(`${LOG} DSH skill dsh-cuadrive-mac from ${dir}`);
	} else ctx.logger.warn(`${LOG} ctx.skills is not mounted; DSH skill was not registered`);
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt) systemPrompt.section({
		name: "tool:dsh-cuadrive-mac",
		order: 118,
		text: PROMPT_TEXT
	});
}
/** Always the plugin-vendored pack unless config.skillDir is set. Never `cua-driver skills path`. */
function resolveSkillDir(config) {
	if (config.skillDir.length > 0 && existsSync(join(config.skillDir, "SKILL.md"))) return config.skillDir;
	return VENDORED_SKILL_DIR;
}
function readOfficialSkill(dir) {
	const path = join(dir, "SKILL.md");
	if (!existsSync(path)) throw new Error(`dsh-cuadrive-mac skill pack missing SKILL.md at ${path}`);
	const parsed = parseFrontmatter(readFileSync(path, "utf8"));
	return {
		name: "dsh-cuadrive-mac",
		description: parsed.description ?? "Drive a native GUI app with DSH's dedicated Cua Driver plugin.",
		body: parsed.body
	};
}
//#endregion
//#region src/compact-apps.ts
/** Shrink list_apps payloads (session-6705 was 30KB of empty windows: []). */
function compactListAppsData(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) return data;
	const record = { ...data };
	if (!Array.isArray(record.apps)) return record;
	record.apps = record.apps.map((app) => {
		if (!app || typeof app !== "object" || Array.isArray(app)) return app;
		const next = { ...app };
		if (Array.isArray(next.windows) && next.windows.length === 0) delete next.windows;
		return next;
	});
	return record;
}
//#endregion
//#region src/images.ts
const SCREENSHOT_TOOLS = /* @__PURE__ */ new Set([
	"get_window_state",
	"get_desktop_state",
	"zoom",
	"verify_state"
]);
/** Whether this driver tool should write a screenshot sidecar. */
function wantsScreenshotFile(tool, args) {
	if (args.include_screenshot === false) return false;
	if (typeof args.screenshot_out_file === "string" && args.screenshot_out_file.length > 0) return false;
	return SCREENSHOT_TOOLS.has(tool);
}
/** Create a temp PNG path the CLI can write into. */
async function prepareScreenshotFile() {
	const dir = await mkdtemp(join(tmpdir(), "dsh-cua-"));
	return {
		path: join(dir, `${randomUUID()}.png`),
		cleanup: () => rm(dir, {
			recursive: true,
			force: true
		})
	};
}
/** Commit a screenshot file (or inline MCP image blocks) through `ctx.attachments`. */
async function collectImages(ctx, tool, data, screenshotPath) {
	const images = [];
	const notes = [];
	if (screenshotPath !== void 0) try {
		const bytes = await readFile(screenshotPath);
		if (bytes.byteLength > 0) {
			const committed = await commitBytes(ctx, bytes, mimeFromBytes(bytes), `${tool}.png`);
			if (committed.image) images.push(committed.image);
			if (committed.note) notes.push(committed.note);
		}
	} catch (error) {
		if (!isMissingPath(error)) notes.push(`screenshot file unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (images.length === 0) for (const inline of inlineImages(data)) {
		const committed = await commitBytes(ctx, inline.bytes, inline.mediaType, `${tool}-inline.png`);
		if (committed.image) images.push(committed.image);
		if (committed.note) notes.push(committed.note);
	}
	return {
		images,
		notes
	};
}
/** Re-brand a canonical image for a model-facing `image` block. */
function imageRefFromValue(image) {
	return {
		attachmentId: AttachmentId(image.attachmentId),
		mediaType: image.mediaType,
		bytes: image.bytes,
		width: image.width,
		height: image.height,
		...image.name === void 0 ? {} : { name: image.name }
	};
}
async function commitBytes(ctx, data, mediaType, name) {
	const attachments = ctx.get("attachments");
	if (attachments === void 0) {
		const path = join(tmpdir(), name);
		await writeFile(path, data);
		return { note: `no attachment service; screenshot written to ${path} — use read_image on that path` };
	}
	try {
		const ref = await attachments.saveImage({
			data,
			mediaType,
			name
		});
		return { image: {
			attachmentId: ref.attachmentId,
			mediaType: ref.mediaType,
			bytes: ref.bytes,
			width: ref.width,
			height: ref.height,
			...ref.name === void 0 ? {} : { name: ref.name }
		} };
	} catch (error) {
		return { note: `saveImage failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}
function inlineImages(data) {
	if (!data || typeof data !== "object") return [];
	const record = data;
	const blocks = Array.isArray(record.content) ? record.content : [];
	const found = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const item = block;
		if (item.type !== "image" || typeof item.data !== "string") continue;
		try {
			const bytes = Buffer.from(item.data, "base64");
			const mediaType = mimeFromName(typeof item.mimeType === "string" ? item.mimeType : void 0) ?? mimeFromBytes(bytes);
			found.push({
				bytes,
				mediaType
			});
		} catch {}
	}
	return found;
}
function isMissingPath(error) {
	if (!error || typeof error !== "object") return false;
	return error.code === "ENOENT";
}
function mimeFromName(value) {
	if (value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif") return value;
}
function mimeFromBytes(bytes) {
	if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return "image/gif";
	if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return "image/webp";
	return "image/png";
}
/** defineTool DSL for host tools (`cua_call`). */
const CUA_OUTPUT_DSL = {
	type: "object",
	additionalProperties: false,
	properties: {
		tool: {
			type: "string",
			required: true
		},
		text: {
			type: "string",
			required: true
		},
		data: {
			type: "json",
			required: true
		},
		images: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					attachmentId: {
						type: "string",
						required: true
					},
					mediaType: {
						type: "string",
						enum: [
							"image/png",
							"image/jpeg",
							"image/webp",
							"image/gif"
						],
						required: true
					},
					bytes: {
						type: "integer",
						required: true
					},
					width: {
						type: "integer",
						required: true
					},
					height: {
						type: "integer",
						required: true
					},
					name: { type: "string" }
				}
			}
		}
	}
};
/** Raw JSON Schema for `ctx.tools.register` (assertSupportedJsonSchema). */
const CUA_OUTPUT_JSON = {
	type: "object",
	additionalProperties: false,
	required: [
		"tool",
		"text",
		"data",
		"images"
	],
	properties: {
		tool: { type: "string" },
		text: { type: "string" },
		data: {},
		images: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: [
					"attachmentId",
					"mediaType",
					"bytes",
					"width",
					"height"
				],
				properties: {
					attachmentId: { type: "string" },
					mediaType: {
						type: "string",
						enum: [
							"image/png",
							"image/jpeg",
							"image/webp",
							"image/gif"
						]
					},
					bytes: { type: "integer" },
					width: { type: "integer" },
					height: { type: "integer" },
					name: { type: "string" }
				}
			}
		}
	}
};
/** Native/model projection: JSON text plus any committed screenshots. */
function renderCuaValue(_args, value) {
	const blocks = [{
		type: "text",
		text: value.text
	}];
	for (const image of value.images) blocks.push({
		type: "image",
		attachment: imageRefFromValue(image)
	});
	return blocks;
}
/** Build the canonical call value from driver JSON plus optional notes/images. */
function cuaCallValue(tool, data, extras = {}) {
	const images = extras.images ?? [];
	const json = asJsonValue(data);
	const parts = [typeof json === "string" ? json : JSON.stringify(json, null, 2)];
	if (extras.notes && extras.notes.length > 0) parts.push(extras.notes.join("\n"));
	return {
		tool,
		text: parts.join("\n"),
		data: json,
		images
	};
}
function asJsonValue(value) {
	if (value === void 0) return null;
	return JSON.parse(JSON.stringify(value));
}
//#endregion
//#region src/session-revive.ts
const ENDED = /session '([^']+)' has ended/i;
/** Parse cua-driver's idle-TTL rejection from session-6705. */
function endedSessionId(message) {
	return ENDED.exec(message)?.[1];
}
/**
* Named session to keep alive. Codex MCP keeps one implicit session on the
* stdio connection; CLI `call` is one-shot, so DSH must own the id.
*/
function sessionToRefresh(args) {
	if (typeof args.session !== "string") return void 0;
	const session = args.session.trim();
	return session.length > 0 ? session : void 0;
}
/** Prefer the model's session; otherwise the plugin-hosted id. */
function attachPluginSession(args, pluginSession) {
	if (sessionToRefresh(args) !== void 0) return args;
	if (pluginSession.trim().length === 0) return args;
	return {
		...args,
		session: pluginSession
	};
}
//#endregion
//#region src/status.ts
/** Same payload `cua_status` returns. Must be DSH lossless JSON (no `undefined`). */
async function buildCuaStatus(config, signal) {
	const status = readRuntimeStatus();
	const runtime = {
		...status,
		proxy: resolvedProxy(config) || status.proxy || ""
	};
	let binary = config.binary;
	try {
		binary = resolveBinary(config.binary);
	} catch {
		binary = "";
	}
	const hostPermissions = readHostPermissions();
	const [daemon, permissions, doctor] = runtimeAvailable(config) ? await Promise.all([
		readDaemonStatus(config, signal),
		readPermissions(config, signal),
		readDoctor(config, signal)
	]) : [
		{
			running: false,
			raw: runtime.message
		},
		{ error: runtime.message },
		{ error: runtime.message }
	];
	const value = {
		plugin: "dsh-cuadrive-mac",
		pluginVersion: runtime.plugin,
		lockedDriver: runtime.driver,
		lockedSkill: runtime.skill,
		runtime,
		binary,
		socketPath: config.socketPath,
		ownDaemon: config.ownDaemon,
		daemon,
		hostPermissions,
		permissions,
		doctor,
		skillDir: resolveSkillDir(config),
		hostedSession: config.sessionId,
		hint: statusHint(runtime.phase, runtime.hint, daemon.running === true, hostPermissions)
	};
	return JSON.parse(JSON.stringify(value));
}
function statusHint(phase, runtimeHint, daemonRunning, hostPermissions) {
	if (phase === "downloading" || phase === "verifying" || phase === "extracting") return runtimeHint;
	if (phase === "error" || phase === "missing") return runtimeHint;
	const permHint = permissionsHint(hostPermissions);
	if (!hostPermissions.accessibility || !hostPermissions.screenRecording) return permHint;
	if (daemonRunning) return "DSH-owned daemon is up on the private socket. Snapshot with cua_get_window_state before element-indexed actions.";
	return "Private runtime is installed. The DSH-owned daemon starts on the private socket; it does not install or stop the machine CuaDriver.app.";
}
//#endregion
//#region src/window-state.ts
/** Defaults and timeout detection for `get_window_state`. */
const AX_TIMEOUT = /timed out after\s+\d+\s*s/i;
/** True when cua-driver gave up walking a huge AX tree. */
function looksLikeAxTimeout(data) {
	if (typeof data === "string") return AX_TIMEOUT.test(data);
	if (!data || typeof data !== "object") return false;
	const record = data;
	if (typeof record.text === "string" && AX_TIMEOUT.test(record.text)) return true;
	try {
		return AX_TIMEOUT.test(JSON.stringify(data));
	} catch {
		return false;
	}
}
/**
* Notes / iCloud / Electron apps blow the driver's 20s full-tree walk.
* Fill bounds only when the caller omitted them.
*/
function boundWindowStateArgs(args, tighter = false) {
	const next = { ...args };
	if (next.max_elements === void 0) next.max_elements = tighter ? 80 : 200;
	if (next.max_depth === void 0) next.max_depth = tighter ? 6 : 8;
	return next;
}
function shouldRetryWindowState(args, data) {
	return looksLikeAxTimeout(data) && (args.max_elements === void 0 || args.max_depth === void 0);
}
const SLIM_KEYS = [
	"element_index",
	"element_token",
	"role",
	"label",
	"value",
	"frame",
	"actions"
];
/** Cut duplicate markdown so a 765-note window does not flood the next model turn. */
function compactWindowStateData(data) {
	if (!data || typeof data !== "object" || Array.isArray(data)) return data;
	const record = { ...data };
	if (Array.isArray(record.elements)) record.elements = record.elements.map(slimElement);
	if (typeof record.tree_markdown === "string" && record.tree_markdown.length > 6e3) record.tree_markdown = `${record.tree_markdown.slice(0, 6e3)}\n…[truncated; prefer elements[]]`;
	return record;
}
function slimElement(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const src = value;
	const out = {};
	for (const key of SLIM_KEYS) if (src[key] !== void 0) out[key] = src[key];
	return Object.keys(out).length > 0 ? out : value;
}
//#endregion
//#region src/tools.ts
const HOST_TOOLS = /* @__PURE__ */ new Set([
	"cua_status",
	"cua_list_tools",
	"cua_describe",
	"cua_call"
]);
/** Host diagnostics + cua_call, always registered via defineTool. */
function registerHostTools(ctx, config) {
	ctx.tools.register(defineTool({
		name: "cua_status",
		description: "Report the lock-pinned cua-driver download (percent, status.json, download.log, proxy/ladder, manual cache path), first-launch DSH Accessibility/Screen Recording grants (not CuaDriver.app), private daemon, and skill pack. Call this to watch the first-run download or when computer-use fails.",
		parameters: {},
		timeoutMs: config.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute(_args, exec) {
			if (config.autoStart && !runtimeAvailable(config)) ensureRuntime(config);
			return buildCuaStatus(config, exec.signal);
		},
		presentCall: () => {
			const status = readRuntimeStatus();
			return {
				card: "generic",
				title: status.phase === "ready" ? "Cua status" : `Cua runtime ${status.percent}%`,
				kind: "read"
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "cua_list_tools",
		description: "List every Cua Driver tool name and one-line summary from the installed cua-driver binary.",
		parameters: {},
		timeoutMs: config.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute() {
			const blocked = runtimeNotReady(config, "list_tools");
			if (blocked) return Promise.resolve(jsonObject({
				tools: [],
				reason: "runtime_not_ready",
				runtime: readRuntimeStatus(),
				text: blocked.text
			}));
			return Promise.resolve(jsonObject({ tools: listDriverTools(config) }));
		},
		presentCall: () => ({
			card: "generic",
			title: "Cua list tools",
			kind: "read"
		})
	}));
	ctx.tools.register(defineTool({
		name: "cua_describe",
		description: "Print one Cua Driver tool's official description and input JSON Schema from `cua-driver describe`.",
		parameters: { tool: {
			type: "string",
			required: true,
			description: "Raw driver tool name, e.g. click or get_window_state"
		} },
		timeoutMs: config.timeoutMs,
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		execute(args) {
			const blocked = runtimeNotReady(config, "describe");
			if (blocked) return Promise.resolve(jsonObject({
				reason: "runtime_not_ready",
				runtime: readRuntimeStatus(),
				text: blocked.text
			}));
			const described = describeDriverTool(config, args.tool);
			return Promise.resolve(jsonObject({
				name: described.name,
				dsh_tool: publicName(described.name),
				description: described.description,
				input_schema: described.inputSchema
			}));
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Cua describe ${args.tool}`,
			kind: "read",
			rawInput: args.tool
		})
	}));
	ctx.tools.register(defineTool({
		name: "cua_call",
		description: "Call any Cua Driver tool by raw name with a JSON arguments object. Prefer the first-class cua_<name> tool when it exists. Screenshots are returned as image blocks.",
		parameters: {
			tool: {
				type: "string",
				required: true,
				description: "Raw driver tool name, e.g. click"
			},
			arguments: {
				type: "object",
				additionalProperties: true,
				description: "JSON object matching `cua_describe` for that tool"
			}
		},
		timeoutMs: config.timeoutMs,
		output: {
			schema: CUA_OUTPUT_DSL,
			render: renderCuaValue
		},
		execute(args, exec) {
			const toolArgs = isPlainObject(args.arguments) ? args.arguments : {};
			return invokeCuaTool(ctx, config, args.tool, toolArgs, exec.signal);
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Cua ${args.tool}`,
			kind: actionKind(args.tool),
			rawInput: args
		})
	}));
}
/** Register every tool the installed binary lists as `cua_<name>`. */
function registerDriverTools(ctx, config) {
	const registered = [];
	for (const listed of listDriverTools(config)) {
		const name = publicName(listed.name);
		if (HOST_TOOLS.has(name)) continue;
		try {
			const described = describeDriverTool(config, listed.name);
			ctx.tools.register(driverToolDefinition(ctx, config, described.name, described.description, described.inputSchema));
			registered.push(name);
		} catch (error) {
			ctx.logger.warn(`${LOG} skip ${listed.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return registered;
}
function driverToolDefinition(ctx, config, rawName, description, inputSchema) {
	return {
		name: publicName(rawName),
		description: `${description}\n\nCua Driver tool \`${rawName}\`. Snapshot before element-indexed actions. Do not shell out to cua-driver.`,
		parameters: sanitizeJsonSchema(inputSchema),
		timeoutMs: config.timeoutMs,
		output: {
			schema: CUA_OUTPUT_JSON,
			render: (args, value) => renderCuaValue(args, value)
		},
		execute(args, exec) {
			return invokeCuaTool(ctx, config, rawName, isPlainObject(args) ? args : {}, exec.signal);
		},
		presentCall(args) {
			return {
				card: "generic",
				title: `Cua ${rawName}`,
				kind: actionKind(rawName),
				rawInput: args
			};
		}
	};
}
/** Exported so live tests can run the same path the model hits. */
async function invokeCuaTool(ctx, config, tool, args, signal) {
	const blocked = runtimeNotReady(config, tool);
	if (blocked) return blocked;
	assertKnownDriverTool(config, tool);
	const firstArgs = tool === "get_window_state" ? attachPluginSession(boundWindowStateArgs(args), config.sessionId) : attachPluginSession(args, config.sessionId);
	let screenshot;
	try {
		await refreshSession(config, firstArgs, signal);
		if (wantsScreenshotFile(tool, firstArgs)) screenshot = await prepareScreenshotFile();
		let data = await callDriverToolReviving(config, tool, firstArgs, {
			signal,
			...screenshot ? { screenshotOutFile: screenshot.path } : {}
		});
		if (tool === "get_window_state" && shouldRetryWindowState(args, data)) data = await callDriverToolReviving(config, tool, attachPluginSession(boundWindowStateArgs(args, true), config.sessionId), {
			signal,
			...screenshot ? { screenshotOutFile: screenshot.path } : {}
		});
		if (tool === "get_window_state") data = compactWindowStateData(data);
		if (tool === "list_apps") data = compactListAppsData(data);
		const collected = await collectImages(ctx, tool, data, screenshot?.path);
		return cuaCallValue(tool, data, collected);
	} finally {
		await screenshot?.cleanup();
	}
}
async function refreshSession(config, args, signal) {
	const session = sessionToRefresh(args);
	if (session === void 0) return;
	await callDriverTool(config, "start_session", { session }, { signal });
}
async function callDriverToolReviving(config, tool, args, options) {
	try {
		return await callDriverTool(config, tool, args, options);
	} catch (error) {
		const session = endedSessionId(error instanceof Error ? error.message : String(error));
		if (session === void 0) throw error;
		await callDriverTool(config, "start_session", { session }, { signal: options.signal });
		return await callDriverTool(config, tool, args, options);
	}
}
function assertKnownDriverTool(config, tool) {
	if (listDriverTools(config).some((listed) => listed.name === tool)) return;
	throw new Error(`${LOG} unknown driver tool '${tool}'. This DSH plugin only forwards tools from its own cua-driver list-tools. Call cua_list_tools.`);
}
function runtimeNotReady(config, tool) {
	if (runtimeAvailable(config)) return void 0;
	if (config.autoStart) ensureRuntime(config);
	const status = readRuntimeStatus();
	const notes = [
		status.message,
		`${status.percent}% — ${formatBytes(status.bytes)} / ${formatBytes(status.total)}`,
		status.error ? `error: ${status.error}` : "",
		status.hint,
		`status: ${status.statusPath}`,
		`log: ${status.logPath}`
	].filter((part) => part.length > 0);
	return cuaCallValue(tool, {
		ok: false,
		reason: "runtime_not_ready",
		runtime: JSON.parse(JSON.stringify(status))
	}, { notes });
}
function publicName(raw) {
	return `cua_${raw.replace(/[^A-Za-z0-9_]/g, "_")}`;
}
function actionKind(tool) {
	return /^(get_|list_|check_|health_|describe)/.test(tool) ? "read" : "other";
}
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function jsonObject(value) {
	return JSON.parse(JSON.stringify(value));
}
//#endregion
//#region src/dsh-cuadrive-mac.ts
const name = "dsh-cuadrive-mac";
const inject = ["tools", "skills"];
/**
* DSH-owned Cua Driver: private daemon, first-class `cua_*` tools, DSH skill.
* `defineTool` stays in this entry so `dshx check` sees a tool plugin.
* apply() never spawnSync-downloads — host tools (including cua_status) register immediately.
*/
function apply(ctx, config = {}) {
	console.log("[my-plugins/dsh-cuadrive-mac] loaded");
	const resolved = resolveConfig(config);
	registerHostTools(ctx, resolved);
	if (!isMacOS()) {
		ctx.logger.warn(`${LOG} macOS only — computer-use is not started on ${process.platform}.`);
		try {
			registerCuaSkill(ctx, resolved);
		} catch (error) {
			ctx.logger.warn(`${LOG} DSH skill not registered: ${error instanceof Error ? error.message : String(error)}`);
		}
		return;
	}
	try {
		registerCuaSkill(ctx, resolved);
	} catch (error) {
		ctx.logger.warn(`${LOG} DSH skill not registered: ${error instanceof Error ? error.message : String(error)}`);
	}
	startOwnedDaemon(ctx, resolved);
	const existing = findVendorBinary();
	if (existing) resolved.binary = existing;
	ctx.effect(() => {
		let cancelled = false;
		if (!existing) {
			const status = readRuntimeStatus();
			const lock = loadRuntimeLock();
			ctx.logger.warn(`${LOG} cua-driver ${lock.driver} (plugin ${lock.plugin}) is not in vendor yet — ${status.percent}%. Call cua_status or open ${status.statusPath}`);
		}
		(existing ? Promise.resolve(existing) : ensureRuntime(resolved)).then(async (binary) => {
			if (cancelled) return;
			resolved.binary = binary;
			const before = readHostPermissions();
			const perms = await ensureHostPermissions(resolved);
			if (cancelled) return;
			if (!perms.accessibility || !perms.screenRecording) ctx.logger.warn(`${LOG} ${perms.hint}`);
			await (!before.prompted || !before.accessibility || !before.screenRecording ? restartOwnedDaemon : ensureOwnedDaemon)(resolved);
			if (cancelled) return;
			onRuntimeReady(ctx, resolved);
			warmHostCapture(resolved).catch((error) => {
				ctx.logger.warn(`${LOG} first-launch capture probe: ${error instanceof Error ? error.message : String(error)}`);
			});
		}).catch((error) => {
			if (cancelled) return;
			const failed = readRuntimeStatus();
			ctx.logger.warn(`${LOG} ${error instanceof Error ? error.message : String(error)}. ${failed.hint} ${readHostPermissions().hint}`);
		});
		return () => {
			cancelled = true;
			abortRuntimeInstall();
		};
	}, "dsh-cuadrive-mac.runtime");
}
function onRuntimeReady(ctx, resolved) {
	if (resolved.registerDriverTools) try {
		const names = registerDriverTools(ctx, resolved);
		console.log(`${LOG} registered ${names.length} driver tools`);
	} catch (error) {
		ctx.logger.warn(`${LOG} driver tools unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	startHostedSession(ctx, resolved);
}
//#endregion
export { Config, apply, inject, name };

//# sourceMappingURL=index.mjs.map