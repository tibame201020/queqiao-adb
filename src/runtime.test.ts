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
  it("allows only portable adb executable names", () => {
    expect(ADB_EXECUTABLES).toEqual(["adb", "adb.exe"]);
    expect(ADB_EXECUTABLES.every((x) => /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(x))).toBe(true);
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
