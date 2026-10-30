import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('archive verification accepts a host bundle and rejects the removed controller import even when syntax is valid', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mw-distribution-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'dsh-maintainer-workbench', main: './dist/plugin.js', exports: { '.': './dist/plugin.js', './client': './dist/client.js' } }),
    'dist/plugin.js': 'export const name = "maintainer-workbench";\n',
    'dist/server.js': 'export {};\n',
    'dist/client.js': 'export {};\n',
    'dist/app.js': '', 'dist/app.css': '', 'dist/preview.html': '', 'cordis.patch.yml': '',
    'scripts/verify-document-patch.mjs': '', 'LICENSE': '', 'THIRD_PARTY_NOTICES.md': '',
    'dist/skills/maintenance/SKILL.md': '', 'third_party/example/LICENSE': '',
  };
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, 'package', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archive = join(dir, 'fixture.tgz');
  const verifier = fileURLToPath(new URL('../scripts/verify-distribution.mjs', import.meta.url));
  const pack = () => execFileSync('tar', ['-czf', archive, '-C', dir, 'package']);
  pack();
  const valid = spawnSync(process.execPath, [verifier, archive], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);

  const obsolete = 'import { buildModelCatalog } from "@deepseek-ai/dsh-api-session-controller"; export { buildModelCatalog };\n';
  execFileSync(process.execPath, ['--check', '--input-type=module'], { input: obsolete });
  await writeFile(join(dir, 'package/dist/plugin.js'), obsolete);
  pack();
  const rejected = spawnSync(process.execPath, [verifier, archive], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /session-controller exports are not a supported dependency/);
});
