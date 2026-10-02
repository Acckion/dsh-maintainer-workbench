import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('bundled runtime notices retain exact installed license texts and versions', async () => {
  const inventory = JSON.parse(await readFile('third_party/runtime/manifest.json', 'utf8')) as { name: string; version: string; notice: string; sha256: string }[];
  assert.deepEqual(inventory.map(r => r.name), ['react', 'react-dom', 'scheduler', 'lucide-react', 'zod']);
  for (const item of inventory) {
    const manifest = JSON.parse(await readFile(`node_modules/${item.name}/package.json`, 'utf8'));
    const original = await readFile(`node_modules/${item.name}/LICENSE`), retained = await readFile(item.notice);
    assert.equal(manifest.version, item.version, `${item.name}: update inventory after dependency changes`);
    assert.deepEqual(retained, original, `${item.name}: preserve the complete notice`);
    assert.equal(createHash('sha256').update(retained).digest('hex'), item.sha256);
  }
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(packageJson.files.includes('third_party'));
});
