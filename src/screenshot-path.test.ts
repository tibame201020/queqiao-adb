import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { adbDefinitions, screenshotPullTarget } from "./index.js";

describe("screenshot pull target", () => {
  it("uses the workspace root plus internal UUID filename without requiring pre-existing lstat", () => {
    const workspaceRoot = "C:\\Users\\jeffh";
    const localName = ".queqiao-adb-test.png";
    expect(screenshotPullTarget(workspaceRoot, localName)).toBe(path.join(workspaceRoot, localName));
  });

  it("does not call assertExecutionPathContained for a not-yet-created temp file", async () => {
    const tool = adbDefinitions.find((x) => x.name === "adb_screenshot")!;
    const assertExecutionPathContained = vi.fn(() => { throw new Error("must-not-lstat-new-file"); });
    const open = vi.fn().mockRejectedValue(new Error("stop-after-path-resolution"));
    const context = {
      workspaceId: "w",
      capabilities: {
        resolveExecutionDirectory: vi.fn().mockResolvedValue("C:\\Users\\jeffh"),
        assertExecutionPathContained,
      },
      runtime: { stdio: { open }, http: {} },
    };
    await expect(tool.execute({ workspaceId: "w", deviceId: "emulator-5556", maxWidth: 320, quality: 55 }, context as never)).rejects.toThrow("stop-after-path-resolution");
    expect(assertExecutionPathContained).not.toHaveBeenCalled();
  });
});
