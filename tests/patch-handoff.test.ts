import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git, collectPatch, applicationPatch } from '../src/core/git.ts';

for (const binary of [false, true]) {
  test(`handoff applies ${binary ? 'binary' : 'text ending in blank context'} patch with historical identity`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'maintainer-patch-handoff-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await git(root, ['init', '-b', 'main']);
    const file = binary ? 'data.bin' : 'README.md';
    const before = binary ? Buffer.from([0, 1, 2, 3]) : Buffer.from('before\n\n## Governance\n\n');
    const after = binary ? Buffer.from([0, 1, 4, 3]) : Buffer.from('after\n\n## Governance\n\n');
    await writeFile(join(root, file), before);
    await git(root, ['add', '.']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base']);
    await writeFile(join(root, file), after);
    const saved = await collectPatch(root);
    const raw = await applicationPatch(root, 'HEAD', saved);
    if (!binary) {
      assert.ok(raw.endsWith(' \n'));
      assert.equal(raw.trimEnd(), saved);
    }
    const patchFile = join(root, '.git', 'handoff.patch');
    await writeFile(patchFile, raw);
    await git(root, ['reset', '--hard', 'HEAD']);
    if (!binary) {
      await writeFile(patchFile, saved + '\n');
      await assert.rejects(git(root, ['apply', '--check', patchFile]), /corrupt patch/);
      await writeFile(patchFile, raw);
    }
    await git(root, ['apply', '--index', patchFile]);
    assert.deepEqual(await readFile(join(root, file)), after);
    assert.equal(await collectPatch(root), saved);
    await writeFile(join(root, file), Buffer.from('changed again\n'));
    await assert.rejects(applicationPatch(root, 'HEAD', saved), /交接补丁或基础版本已变化/);
  });
}
