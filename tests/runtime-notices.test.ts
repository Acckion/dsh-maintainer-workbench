import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("bundled runtime notices retain exact installed license texts and versions", async () => {
  const inventory = JSON.parse(
    await readFile("third_party/runtime/manifest.json", "utf8"),
  ) as {
    name: string;
    version: string;
    notice: string;
    sha256: string;
    sourceLicense?: string;
  }[];
  for (const name of [
    "react",
    "react-dom",
    "scheduler",
    "lucide-react",
    "zod",
    "react-markdown",
    "remark-gfm",
  ])
    assert.ok(inventory.some((r) => r.name === name));
  for (const item of inventory) {
    const manifest = JSON.parse(
      await readFile(`node_modules/${item.name}/package.json`, "utf8"),
    );
    const expectedName = item.sourceLicense ?? "LICENSE";
    const files = await readdir(`node_modules/${item.name}`);
    const actualName =
      files.find((name) => name === expectedName) ??
      files.find((name) => name.toLowerCase() === expectedName.toLowerCase());
    assert.ok(actualName, `${item.name}: installed license is missing`);
    const original = await readFile(`node_modules/${item.name}/${actualName}`),
      retained = await readFile(item.notice);
    assert.equal(
      manifest.version,
      item.version,
      `${item.name}: update inventory after dependency changes`,
    );
    assert.deepEqual(
      retained,
      original,
      `${item.name}: preserve the complete notice`,
    );
    assert.equal(
      createHash("sha256").update(retained).digest("hex"),
      item.sha256,
    );
  }
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok(packageJson.files.includes("third_party"));
});
