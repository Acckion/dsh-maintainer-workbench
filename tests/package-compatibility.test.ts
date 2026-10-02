import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dependencyFingerprints } from './evaluation/dependencies.ts';

test('plugin declares the bounded Cordis4.0 compatibility range while preserving the pinned development runtime', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')), lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(manifest.peerDependencies['@deepseek-ai/cordis'], '>=4.0.3 <4.1.0');
  assert.equal(lock.packages[''].peerDependencies['@deepseek-ai/cordis'], manifest.peerDependencies['@deepseek-ai/cordis']);
  assert.equal(manifest.devDependencies['@deepseek-ai/cordis'], '4.0.3');
  assert.equal(lock.packages['node_modules/@deepseek-ai/cordis'].version, '4.0.3');
});

test('evaluation preserves raw lock fingerprints but permits root metadata changes only', () => {
  const lock = { packages: { '': { name: 'workbench', peerDependencies: { cordis: '4.0.3' } }, 'node_modules/cordis': { version: '4.0.3', integrity: 'pinned' } } };
  const before = dependencyFingerprints(JSON.stringify(lock));
  lock.packages[''].peerDependencies.cordis = '>=4.0.3 <4.1.0';
  const metadata = dependencyFingerprints(JSON.stringify(lock));
  assert.notEqual(metadata.lockSha256, before.lockSha256);
  assert.equal(metadata.graphSha256, before.graphSha256);
  lock.packages['node_modules/cordis'].version = '4.0.4';
  assert.notEqual(dependencyFingerprints(JSON.stringify(lock)).graphSha256, before.graphSha256);
  assert.throws(() => dependencyFingerprints('{"packages":{}}'), /Expected/);
});
