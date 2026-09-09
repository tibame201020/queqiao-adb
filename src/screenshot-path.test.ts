import { describe, expect, it } from "vitest";
import path from "node:path";
import { screenshotPullTarget } from "./index.js";

describe("screenshot pull target", () => {
  it("uses the exact contained absolute path as adb pull destination", () => {
    const workspaceRoot = "C:\\Users\\jeffh";
    const localName = ".queqiao-adb-test.png";
    expect(screenshotPullTarget(workspaceRoot, localName)).toBe(path.join(workspaceRoot, localName));
  });
});
