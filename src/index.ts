import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { ExtensionManifestConfig, QueqiaoExtension, ToolDefinition, WorkerExtensionContext } from "@tibame201020/queqiao/extension";

const EXTENSION_ID = "dev.queqiao.adb";
const EXTENSION_VERSION = "0.1.0";
const ADB_TIMEOUT_MS = 15_000;
const SCREENSHOT_TIMEOUT_MS = 30_000;
const MAX_SOURCE_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 192 * 1024;

export const ADB_EXECUTABLES = [
  "adb",
  "adb.exe",
  "C:\\Program Files\\Netease\\MuMuPlayer\\nx_device\\12.0\\shell\\adb.exe",
  "C:\\Program Files\\Netease\\MuMuPlayer\\nx_device\\15.0\\shell\\adb.exe",
  "C:\\Program Files\\Netease\\MuMuPlayer\\nx_main\\adb.exe",
] as const;

const workspaceSchema = z.string().min(1).max(64);
const deviceIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, "invalid ADB device id");
const packageSchema = z.string().min(3).max(255).regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/, "invalid Android package name");
const coordinateSchema = z.number().int().min(0).max(16_384);
const durationSchema = z.number().int().min(1).max(30_000).default(500);
const keyEventSchema = z.number().int().min(0).max(1024);
const screenshotWidthSchema = z.number().int().min(320).max(1280).default(640);
const screenshotQualitySchema = z.number().int().min(40).max(90).default(70);

export type AdbToolContext = WorkerExtensionContext;
type ProcessClose = { exitCode: number | null; signal: string | null; durationMs: number; timedOut: boolean; aborted: boolean; outputLimitExceeded: boolean };
type AdbResult = { stdout: string; stderr: string; close: ProcessClose; executable: string };

type PreviewOptions = { maxWidth: number; quality: number };
export async function createScreenshotPreview(png: Buffer, options: PreviewOptions) {
  if (png.length < 8 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("ADB screenshot source is not a PNG image");
  if (png.length > MAX_SOURCE_SCREENSHOT_BYTES) throw new Error(`ADB screenshot source exceeds ${MAX_SOURCE_SCREENSHOT_BYTES} bytes`);
  const attempts = [
    { width: options.maxWidth, quality: options.quality },
    { width: Math.min(options.maxWidth, 480), quality: Math.min(options.quality, 60) },
    { width: Math.min(options.maxWidth, 360), quality: 50 },
  ];
  for (const attempt of attempts) {
    const { data, info } = await sharp(png).resize({ width: attempt.width, withoutEnlargement: true }).jpeg({ quality: attempt.quality }).toBuffer({ resolveWithObject: true });
    if (data.length <= MAX_PREVIEW_BYTES) return { mimeType: "image/jpeg" as const, encoding: "base64" as const, width: info.width, height: info.height, bytes: data.length, data: data.toString("base64") };
  }
  throw new Error(`ADB screenshot preview exceeds ${MAX_PREVIEW_BYTES} bytes after bounded compression`);
}

async function collectSession(session: Awaited<ReturnType<AdbToolContext["runtime"]["stdio"]["open"]>>, executable: string): Promise<AdbResult> {
  let stdout = "";
  let stderr = "";
  while (true) {
    try {
      const event = await session.next();
      if (event.type === "stdout") stdout += event.data;
      else stderr += event.data;
    } catch { break; }
  }
  const close = await session.closed as ProcessClose;
  if (close.timedOut) throw new Error("adb timed out");
  if (close.aborted) throw new Error("adb was aborted");
  if (close.outputLimitExceeded) throw new Error("adb output exceeded the Worker bounded output limit");
  if (close.exitCode !== 0) throw new Error(`adb failed: ${stderr.trim() || `exit ${close.exitCode}`}`);
  return { stdout, stderr, close, executable };
}

async function runAdb(context: AdbToolContext, args: readonly string[], timeoutMs = ADB_TIMEOUT_MS): Promise<AdbResult> {
  let lastOpenError: unknown;
  for (const executable of ADB_EXECUTABLES) {
    try {
      const session = await context.runtime.stdio.open({ executable, args, cwd: ".", timeoutMs, ...(context.signal ? { signal: context.signal } : {}) });
      return await collectSession(session, executable);
    } catch (error) {
      lastOpenError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/ENOENT|not found|cannot find|system cannot find|no such file/i.test(message)) throw error;
    }
  }
  throw new Error(`No declared ADB executable is available: ${lastOpenError instanceof Error ? lastOpenError.message : String(lastOpenError)}`);
}

function deviceArgs(deviceId: string, args: readonly string[]): string[] { return ["-s", deviceId, ...args]; }
function cleanLines(value: string): string[] { return value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); }
function parseDevices(stdout: string) {
  return cleanLines(stdout).filter((line) => !line.startsWith("List of devices attached")).slice(0, 128).map((line) => {
    const [id = "", state = "unknown", ...rest] = line.split(/\s+/);
    const meta: Record<string, string> = {};
    for (const token of rest) { const split = token.indexOf(":"); if (split > 0) meta[token.slice(0, split)] = token.slice(split + 1); }
    return { id, state, ...(meta.product ? { product: meta.product } : {}), ...(meta.model ? { model: meta.model } : {}), ...(meta.device ? { device: meta.device } : {}), ...(meta.transport_id ? { transportId: meta.transport_id } : {}) };
  });
}
function parseGetprop(stdout: string) {
  const props = new Map<string, string>();
  for (const line of cleanLines(stdout)) { const match = /^\[([^\]]+)\]: \[(.*)\]$/.exec(line); if (match) props.set(match[1]!, match[2]!); }
  return props;
}
function parseWmValue(stdout: string, label: string) {
  const lines = cleanLines(stdout); const override = lines.find((line) => line.startsWith(`Override ${label}:`)); const physical = lines.find((line) => line.startsWith(`Physical ${label}:`));
  return (override ?? physical)?.split(":", 2)[1]?.trim() ?? null;
}
function parseForeground(stdout: string) {
  const match = /(?:topResumedActivity|mResumedActivity)[^\n]*?\s([A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+)/.exec(stdout);
  if (!match) return { packageName: null, activity: null, component: null };
  const component = match[1]!; const slash = component.indexOf("/"); return { packageName: component.slice(0, slash), activity: component.slice(slash + 1), component };
}
async function executeNoOutput(context: AdbToolContext, args: readonly string[]) { const result = await runAdb(context, args); return { ok: true, adbExecutable: result.executable, stderr: result.stderr.trim() || undefined }; }

export const adbDefinitions: readonly ToolDefinition<AdbToolContext>[] = [
  { name: "adb_devices", title: "List ADB devices", description: "List bounded Android devices visible to the Worker ADB daemon.", inputSchema: z.object({ workspaceId: workspaceSchema }), requiredCapabilities: [], risk: "read", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, async execute(_input, context) { const result = await runAdb(context, ["devices", "-l"]); return { adbExecutable: result.executable, devices: parseDevices(result.stdout) }; } },
  { name: "adb_device_info", title: "Read ADB device info", description: "Read bounded model, Android version, display size, and density for one ADB device.", inputSchema: z.object({ workspaceId: workspaceSchema, deviceId: deviceIdSchema }), requiredCapabilities: [], risk: "read", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, async execute(input, context) { const { deviceId } = input as { deviceId: string }; const [prop, size, density] = await Promise.all([runAdb(context, deviceArgs(deviceId, ["shell", "getprop"])), runAdb(context, deviceArgs(deviceId, ["shell", "wm", "size"])), runAdb(context, deviceArgs(deviceId, ["shell", "wm", "density"]))]); const props = parseGetprop(prop.stdout); return { deviceId, adbExecutable: prop.executable, manufacturer: props.get("ro.product.manufacturer") ?? null, model: props.get("ro.product.model") ?? null, androidVersion: props.get("ro.build.version.release") ?? null, sdk: props.get("ro.build.version.sdk") ?? null, size: parseWmValue(size.stdout, "size"), density: parseWmValue(density.stdout, "density") }; } },
  { name: "adb_packages", title: "List Android packages", description: "List bounded installed Android package names on one ADB device.", inputSchema: z.object({ workspaceId: workspaceSchema, deviceId: deviceIdSchema, thirdPartyOnly: z.boolean().default(true), prefix: z.string().max(128).regex(/^[A-Za-z0-9._]*$/).default("") }), requiredCapabilities: [], risk: "read", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, async execute(input, context) { const { deviceId, thirdPartyOnly, prefix } = input as { deviceId: string; thirdPartyOnly: boolean; prefix: string }; const result = await runAdb(context, deviceArgs(deviceId, ["shell", "pm", "list", "packages", ...(thirdPartyOnly ? ["-3"] : [])])); const all = cleanLines(result.stdout).map((line) => line.replace(/^package:/, "")).filter((name) => !prefix || name.startsWith(prefix)); const packages = all.slice(0, 4096); return { deviceId, adbExecutable: result.executable, packages, truncated: all.length > packages.length }; } },
  { name: "adb_foreground_app", title: "Read foreground Android app", description: "Read the current resumed Android package and activity from one ADB device.", inputSchema: z.object({ workspaceId: workspaceSchema, deviceId: deviceIdSchema }), requiredCapabilities: [], risk: "read", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, async execute(input, context) { const { deviceId } = input as { deviceId: string }; const result = await runAdb(context, deviceArgs(deviceId, ["shell", "dumpsys", "activity", "activities"])); return { deviceId, adbExecutable: result.executable, ...parseForeground(result.stdout) }; } },
  { name: "adb_screenshot", title: "Capture Android screenshot", description: "Capture a screenshot through ADB, create a bounded JPEG preview, and return base64 image data. The source PNG is deleted after conversion.", inputSchema: z.object({ workspaceId: workspaceSchema, deviceId: deviceIdSchema, maxWidth: screenshotWidthSchema, quality: screenshotQualitySchema }), requiredCapabilities: ["workspace:exec"], risk: "read", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true }, async execute(input, context) { const { deviceId, maxWidth, quality } = input as { deviceId: string; maxWidth: number; quality: number }; const token = randomUUID(); const remotePath = `/sdcard/Download/queqiao-adb-${token}.png`; const localName = `.queqiao-adb-${token}.png`; const workspaceRoot = await context.capabilities.resolveExecutionDirectory("."); const localPath = await context.capabilities.assertExecutionPathContained(path.join(workspaceRoot, localName)); let adbExecutable: string | undefined; try { adbExecutable = (await runAdb(context, deviceArgs(deviceId, ["shell", "screencap", "-p", remotePath]), SCREENSHOT_TIMEOUT_MS)).executable; await runAdb(context, deviceArgs(deviceId, ["pull", remotePath, localName]), SCREENSHOT_TIMEOUT_MS); const source = await readFile(localPath); const preview = await createScreenshotPreview(source, { maxWidth, quality }); return { deviceId, adbExecutable, sourceBytes: source.length, ...preview }; } finally { await rm(localPath, { force: true }).catch(() => undefined); await runAdb(context, deviceArgs(deviceId, ["shell", "rm", "-f", remotePath])).catch(() => undefined); } } },
  { name: "adb_app_start", title: "Start Android app", description: "Start one installed Android package through the standard monkey launcher intent.", inputSchema: z.object({ workspaceId: workspaceSchema, deviceId: deviceIdSchema, packageName: packageSchema }), requiredCapabilities: [], risk: "execute", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false }, async execute(input, context) { const { deviceId, packageName } = input as { deviceId: string; packageName: string }; return { deviceId, packageName, ...(await executeNoOutput(context, deviceArgs(deviceId, ["shell", "monkey", "-p", packageName, "-c", "android.intent.category.LAUNCHER", "1"]))) }; } },
  { name: "adb_app_stop", title: "Stop Android app", description: "Force-stop one Android package on the selected ADB device.", inputSchema: z.object({ workspaceId: workspaceSchema, deviceId: deviceIdSchema, packageName: packageSchema }), requiredCapabilities: [], risk: "execute", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true }, async execute(input, context) { const { deviceId, packageName } = input as { deviceId: string; packageName: string }; return { deviceId, packageName, ...(await executeNoOutput(context, deviceArgs(deviceId, ["shell", "am", "force-stop", packageName]))) }; } },
  { name: "adb_tap", title: "Tap Android screen", description: "Send one bounded tap to the selected ADB device.", inputSchema: z.object({ workspaceId: workspaceSchema, deviceId: deviceIdSchema, x: coordinateSchema, y: coordinateSchema }), requiredCapabilities: [], risk: "execute", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false }, async execute(input, context) { const { deviceId, x, y } = input as { deviceId: string; x: number; y: number }; return { deviceId, x, y, ...(await executeNoOutput(context, deviceArgs(deviceId, ["shell", "input", "tap", String(x), String(y)]))) }; } },
  { name: "adb_swipe", title: "Swipe Android screen", description: "Send one bounded swipe gesture to the selected ADB device.", inputSchema: z.object({ workspaceId: workspaceSchema, deviceId: deviceIdSchema, x1: coordinateSchema, y1: coordinateSchema, x2: coordinateSchema, y2: coordinateSchema, durationMs: durationSchema }), requiredCapabilities: [], risk: "execute", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false }, async execute(input, context) { const { deviceId, x1, y1, x2, y2, durationMs } = input as { deviceId: string; x1: number; y1: number; x2: number; y2: number; durationMs: number }; return { deviceId, ...(await executeNoOutput(context, deviceArgs(deviceId, ["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(durationMs)]))) }; } },
  { name: "adb_keyevent", title: "Send Android key event", description: "Send one bounded numeric Android key event to the selected ADB device.", inputSchema: z.object({ workspaceId: workspaceSchema, deviceId: deviceIdSchema, keyCode: keyEventSchema }), requiredCapabilities: [], risk: "execute", annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false }, async execute(input, context) { const { deviceId, keyCode } = input as { deviceId: string; keyCode: number }; return { deviceId, keyCode, ...(await executeNoOutput(context, deviceArgs(deviceId, ["shell", "input", "keyevent", String(keyCode)]))) }; } },
] as const;

function manifestContribution(definition: ToolDefinition<AdbToolContext>) { return { operation: "register" as const, tool: definition.name, visibility: "public" as const, title: definition.title, description: definition.description, inputSchema: z.toJSONSchema(definition.inputSchema, { io: "input" }) as Extract<ExtensionManifestConfig["contributions"][number], { operation: "register" }>["inputSchema"], requiredCapabilities: [...definition.requiredCapabilities], risk: definition.risk, annotations: definition.annotations }; }
export const ADB_EXTENSION_MANIFEST: ExtensionManifestConfig = { id: EXTENSION_ID, version: EXTENSION_VERSION, displayName: "Queqiao ADB", host: { kind: "worker" }, ordering: { requires: [], before: [], after: [] }, runtime: { processes: { allow: [...ADB_EXECUTABLES] }, outboundHttp: { allowOrigins: [] } }, contributions: adbDefinitions.map(manifestContribution) };
export const queqiaoExtension: QueqiaoExtension<AdbToolContext> = { manifest: { id: EXTENSION_ID, version: EXTENSION_VERSION, displayName: "Queqiao ADB", supportedEnvironments: ["windows", "linux", "darwin"] }, activate(api) { for (const definition of adbDefinitions) api.registerTool(definition); } };
export default queqiaoExtension;
