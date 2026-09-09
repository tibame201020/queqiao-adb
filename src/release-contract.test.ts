import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

it("declares dual-use metadata and stages trusted publishes", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const workflow = await readFile(path.join(root, ".github", "workflows", "publish-npm.yml"), "utf8");

  expect(pkg.contentPolicy).toEqual({ class: "dual-use" });
  expect(pkg.files).toContain("DISCLOSURE");
  expect(workflow).toContain("npm stage publish --provenance --access public");
  expect(workflow).not.toMatch(/run:\s+npm publish --provenance --access public/);
});
