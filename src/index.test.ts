import { describe, expect, it, vi } from "vitest";
import { ADB_EXECUTABLES, ADB_EXTENSION_MANIFEST, adbDefinitions } from "./index.js";

function definition(name: string) {
  const found = adbDefinitions.find((tool) => tool.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function context(events: Array<{ type: "stdout" | "stderr"; data: string }>, close = { exitCode: 0, signal: null, durationMs: 1, timedOut: false, aborted: false, outputLimitExceeded: false }) {
  const next = vi.fn();
  for (const event of events) next.mockResolvedValueOnce(event);
  next.mockRejectedValue(new Error("closed"));
  const session = { pid: 123, write: vi.fn(), next, close: vi.fn(), closed: Promise.resolve(close) };
  const open = vi.fn().mockResolvedValue(session);
  return { workspaceId: "w", capabilities: {} as never, runtime: { stdio: { open }, http: {} as never }, open, session };
}

describe("ADB extension contract", () => {
  it("declares only adb as an extension process", () => {
    expect(ADB_EXTENSION_MANIFEST.runtime).toEqual({ processes: { allow: [...ADB_EXECUTABLES] }, outboundHttp: { allowOrigins: [] } });
  });

  it("registers the bounded MVP tools", () => {
    expect(adbDefinitions.map((x) => x.name)).toEqual([
      "adb_devices", "adb_device_info", "adb_packages", "adb_foreground_app", "adb_screenshot",
      "adb_app_start", "adb_app_stop", "adb_tap", "adb_swipe", "adb_keyevent",
    ]);
  });

  it("marks read and execute tools correctly", () => {
    expect(definition("adb_devices").risk).toBe("read");
    expect(definition("adb_screenshot").annotations.readOnlyHint).toBe(true);
    expect(definition("adb_tap").risk).toBe("execute");
    expect(definition("adb_tap").annotations.readOnlyHint).toBe(false);
  });

  it("rejects argument-injection shaped device ids and packages", () => {
    expect(() => definition("adb_device_info").inputSchema.parse({ workspaceId: "w", deviceId: "x;rm -rf /" })).toThrow();
    expect(() => definition("adb_app_start").inputSchema.parse({ workspaceId: "w", deviceId: "emulator-5554", packageName: "com.foo;whoami" })).toThrow();
  });

  it("runs tap as argv without a host shell", async () => {
    const c = context([]);
    await definition("adb_tap").execute({ workspaceId: "w", deviceId: "emulator-5554", x: 100, y: 200 }, c as never);
    expect(c.open).toHaveBeenCalledWith(expect.objectContaining({ executable: "adb", args: ["-s", "emulator-5554", "shell", "input", "tap", "100", "200"] }));
  });

  it("parses adb devices into bounded structured output", async () => {
    const c = context([{ type: "stdout", data: "List of devices attached\nemulator-5554\tdevice product:a52 model:SM_A528B transport_id:1\nabc\toffline\n" }]);
    const result = await definition("adb_devices").execute({ workspaceId: "w" }, c as never) as any;
    expect(result.devices).toEqual([
      expect.objectContaining({ id: "emulator-5554", state: "device", model: "SM_A528B" }),
      expect.objectContaining({ id: "abc", state: "offline" }),
    ]);
  });

  it("exposes bounded JPEG screenshot controls instead of raw PNG output", () => {
    const parsed = definition("adb_screenshot").inputSchema.parse({ workspaceId: "w", deviceId: "emulator-5554" }) as any;
    expect(parsed.maxWidth).toBe(640);
    expect(parsed.quality).toBe(70);
    expect(definition("adb_screenshot").requiredCapabilities).toContain("workspace:exec");
  });
});
