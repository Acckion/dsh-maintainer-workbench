import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Inspect the actual archive, not the source manifest or a dry-run file list. */
export async function verifyDistribution(archive) {
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/') && !entry.split('/').includes('..'), `Unsafe archive entry: ${entry}`);
    assert.ok(!/^package\/(node_modules|src|tests|\.data|\.env)(\/|$)/.test(entry), `Unexpected source/private file: ${entry}`);
  }
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(manifest.name, 'dsh-maintainer-workbench');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) assert.equal(manifest.scripts?.[hook], undefined, `Distribution must not run ${hook}`);
  assert.equal(manifest.devDependencies, undefined);
  const paths = [manifest.main, ...Object.values(manifest.exports).filter(v => typeof v === 'string'),
    'dist/server.js', 'dist/app.js', 'dist/app.css', 'dist/preview.html', 'cordis.patch.yml',
    'scripts/verify-document-patch.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
  for (const path of paths) assert.ok(entries.includes(`package/${path.replace(/^\.\//, '')}`), `Missing runtime asset: ${path}`);
  assert.ok(entries.some(path => path.startsWith('package/dist/skills/') && path.endsWith('/SKILL.md')), 'Missing bundled workflows');
  assert.ok(entries.some(path => path.startsWith('package/third_party/') && /LICENSE|NOTICE/.test(path)), 'Missing upstream notices');
  // Check executable bundles without invoking plugin activation or host APIs.
  for (const path of ['dist/plugin.js', 'dist/server.js', 'dist/client.js']) {
    const code = execFileSync('tar', ['-xOzf', archive, `package/${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    execFileSync(process.execPath, ['--check', '--input-type=module'], { input: code });
  }
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyDistribution(resolve(process.argv[2] ?? 'artifacts/dsh-maintainer-workbench.tgz'));
  console.log('Distribution archive verified.');
}
