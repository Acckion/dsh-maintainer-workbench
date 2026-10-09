import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyDistribution } from './verify-distribution.mjs';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], { cwd: root, encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
if (process.env.GITHUB_SHA && commit !== process.env.GITHUB_SHA) throw Error('Checkout does not match the workflow source commit');
const version = process.env.DISTRIBUTION_CHANNEL === 'master'
  ? `${manifest.version.split('-')[0]}-master.${git('show', '-s', '--format=%ct', 'HEAD')}.g${commit.slice(0, 12)}`
  : manifest.version;
const output = join(root, 'artifacts');
const staging = await mkdtemp(join(tmpdir(), 'maintainer-distribution-'));
try {
  await mkdir(output, { recursive: true });
  for (const path of [...new Set([...manifest.files, 'LICENSE'])]) {
    if (path.includes('..') || resolve(root, path) === root) throw Error(`Unsafe package path: ${path}`);
    await cp(join(root, path), join(staging, path), { recursive: true });
  }
  // Source checkouts keep prepare for development. Installed distributions are
  // complete packages, with no lifecycle hooks or development dependencies.
  const distributed = { ...manifest, version, gitHead: commit, scripts: { start: manifest.scripts.start } };
  delete distributed.devDependencies;
  await writeFile(join(staging, 'package.json'), JSON.stringify(distributed, null, 2) + '\n');
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', output];
  // Use npm's JS entry on Windows rather than shell-interpolating paths.
  const packed = process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: staging, encoding: 'utf8' })
    : execFileSync('npm', args, { cwd: staging, encoding: 'utf8' });
  const [info] = JSON.parse(packed);
  const archive = join(output, 'dsh-maintainer-workbench.tgz');
  await cp(join(output, info.filename), archive);
  if (info.filename !== 'dsh-maintainer-workbench.tgz') await rm(join(output, info.filename));
  await verifyDistribution(archive);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  const metadata = { name: manifest.name, version, sourceVersion: manifest.version, commit, tag: `master-${commit}`, file: 'dsh-maintainer-workbench.tgz', sha256, shasum: info.shasum };
  await writeFile(join(output, 'distribution.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(join(output, 'SHA256SUMS'), `${sha256}  ${metadata.file}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${metadata.tag}\n`);
  console.log(JSON.stringify(metadata, null, 2));
} finally {
  await rm(staging, { recursive: true, force: true });
}
