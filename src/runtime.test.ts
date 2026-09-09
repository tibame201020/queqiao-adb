import { describe, expect, it, vi } from "vitest";
import { ADB_EXECUTABLES, adbDefinitions, createScreenshotPreview } from "./index.js";
import sharp from "sharp";

function definition(name: string) {
  const found = adbDefinitions.find((tool) => tool.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function successfulSession(stdout: string) {
  let emitted = false;
  return {
    pid: 1,
    write: vi.fn(),
    close: vi.fn(),
    next: vi.fn(async () => {
      if (!emitted) { emitted = true; return { type: "stdout" as const, data: stdout }; }
      throw new Error("closed");
    }),
    closed: Promise.resolve({ exitCode: 0, signal: null, durationMs: 1, timedOut: false, aborted: false, outputLimitExceeded: false }),
  };
}

describe("ADB runtime hardening", () => {
  it("allows only adb executable candidates and known MuMu paths", () => {
    expect(ADB_EXECUTABLES).toContain("adb");
    expect(ADB_EXECUTABLES).toContain("adb.exe");
    expect(ADB_EXECUTABLES.some((x) => x.includes("MuMuPlayer"))).toBe(true);
    expect(ADB_EXECUTABLES.some((x) => /powershell|cmd\.exe|bash|sh$/i.test(x))).toBe(false);
  });

  it("falls back to a declared MuMu adb path when PATH adb is unavailable", async () => {
    const open = vi.fn()
      .mockRejectedValueOnce(new Error("spawn adb ENOENT"))
      .mockRejectedValueOnce(new Error("spawn adb.exe ENOENT"))
      .mockResolvedValue(successfulSession("List of devices attached\nemulator-5554\tdevice\n"));
    const context = { workspaceId: "w", capabilities: {} as never, runtime: { stdio: { open }, http: {} as never } };
    const result = await definition("adb_devices").execute({ workspaceId: "w" }, context as never) as any;
    expect(result.devices[0].id).toBe("emulator-5554");
    expect(open.mock.calls[2][0].executable).toBe(ADB_EXECUTABLES[2]);
  });

  it("creates a bounded JPEG preview from a multi-megabyte PNG", async () => {
    const png = await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 80, g: 120, b: 160 } } }).png().toBuffer();
    const preview = await createScreenshotPreview(png, { maxWidth: 640, quality: 70 });
    expect(preview.mimeType).toBe("image/jpeg");
    expect(preview.width).toBeLessThanOrEqual(640);
    expect(preview.bytes).toBeLessThan(256 * 1024);
    expect(Buffer.from(preview.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
  });
});
