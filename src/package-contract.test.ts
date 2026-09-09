import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ADB_EXTENSION_MANIFEST } from "./index.js";

it("is an independently publishable Queqiao extension package", async () => {
  const pkg = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"));
  expect(pkg.name).toBe("@tibame201020/queqiao-adb");
  expect(pkg.private).toBe(false);
  expect(pkg.version).toBe(ADB_EXTENSION_MANIFEST.version);
  expect(pkg.devDependencies["@tibame201020/queqiao"]).toBe("0.9.7");
  expect(pkg.engines.node).toBe(">=22.19 <25");
  expect(pkg.queqiao).toEqual({ apiVersion: 1, module: "./dist/index.js", manifest: ADB_EXTENSION_MANIFEST });
});
