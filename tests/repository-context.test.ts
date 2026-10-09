import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, prepareManagedCheckout, prepareWorktree } from '../src/core/git.ts';
import { localRepositoryProfile, repositoryProfile, repositoryPromptProfile } from '../src/core/repository-context.ts';
import type { Repo, Job } from '../src/core/types.ts';

test('code prompt omits bulky source excerpts but preserves pinned discovery evidence and read instructions', () => {
  const sources = Array.from({ length: 12 }, (_, i) => ({ path: `docs/${i}.md`, content: 'large-source-excerpt '.repeat(300) }));
  const profile = repositoryProfile('pinned-sha', ['package.json', 'src/helper.ts', 'src/helper.test.ts'], sources);
  const saved = JSON.stringify(profile);
  const prompt = repositoryPromptProfile(profile)!;
  assert.equal(prompt.revision, 'pinned-sha');
  assert.deepEqual(prompt.sourcePaths, sources.map(s => s.path));
  assert.deepEqual(prompt.testPaths, profile.testPaths);
  assert.deepEqual(prompt.commands, profile.commands);
  assert.ok(prompt.warnings.some(w => w.includes('complete scoped AGENTS.md')));
  assert.ok(!JSON.stringify(prompt).includes('large-source-excerpt'));
  assert.ok(JSON.stringify(prompt).length < saved.length / 10);
  assert.equal(JSON.stringify(profile), saved);
  assert.equal(repositoryPromptProfile(undefined), undefined);
});

test('repository understanding discovers multiple stacks and declared commands without repository-name rules', () => {
  const js = repositoryProfile('a', ['package.json', 'src/main.ts', 'tests/main.test.ts', '.github/workflows/ci.yml'], [{ path: 'package.json', content: JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc', deploy: 'publish-production' } }) }]);
  assert.deepEqual(js.languages, ['TypeScript']); assert.equal(js.commands.length, 2); assert.equal(js.commands[0].command, 'vitest run'); assert.equal(js.workflows.length, 1);
  const other = repositoryProfile('b', ['pyproject.toml', 'src/module.py', 'tests/test_core.py', 'Cargo.toml', 'src/main.rs', 'Package.swift', 'Sources/App.swift', 'Tests/AppTests.swift'], []);
  assert.deepEqual(new Set(other.languages), new Set(['Python', 'Rust', 'Swift'])); assert.equal(other.manifests.length, 3); assert.equal(other.testPaths.length, 2); assert.deepEqual(other.commands, []);
});

test('local understanding reads pinned Git blobs, skips symlinks and never executes declared commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maintainer-profile-'));
  await git(dir, ['init', '-b', 'main']);
  await writeFile(join(dir, 'README.md'), 'Recorded documentation');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'touch EXECUTED' } }));
  await symlink('/etc/passwd', join(dir, 'AGENTS.md'));
  await git(dir, ['add', '.']); await git(dir, ['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','base']);
  const sha = await git(dir, ['rev-parse','HEAD']); await writeFile(join(dir,'README.md'), 'Uncommitted unrelated edit');
  const p = await localRepositoryProfile(dir, sha);
  assert.equal(p.sources.find(s => s.path === 'README.md')?.content, 'Recorded documentation');
  assert.ok(!p.sources.some(s => s.path === 'AGENTS.md')); assert.ok(p.warnings.some(w => w.includes('non-regular')));
  await assert.rejects(readFile(join(dir,'EXECUTED')), /ENOENT/);
});

test('automatic managed clone can create an isolated task worktree, reuse clone and preserve source checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maintainer-managed-')); const source = join(root,'source'); await mkdir(source);
  await git(source,['init','-b','main']); await writeFile(join(source,'README.md'),'fixture'); await git(source,['add','.']); await git(source,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','base']);
  const sha = await git(source,['rev-parse','HEAD']); let clones = 0;
  const repo: Repo = { id:'fixture/generic', fullName:'fixture/generic', localPath:'', defaultBranch:'main', headSha:sha, description:'', mode:'github', syncedAt:null, syncWarning:null };
  const transport: typeof git = async (cwd,args,auth,signal,timeout) => {
    if (args[0] !== 'clone') return git(cwd,args,auth,signal,timeout);
    clones++; assert.equal(args.at(-2),'https://github.com/fixture/generic.git'); const result = await git(cwd,['clone','--no-checkout','--',source,args.at(-1)!]);
    await git(args.at(-1)!,['remote','set-url','origin','https://github.com/fixture/generic.git']); return result;
  };
  repo.localPath = await prepareManagedCheckout(repo,root,undefined,transport);
  assert.equal(await prepareManagedCheckout(repo,root,undefined,transport),repo.localPath); assert.equal(clones,1);
  const job = { id:'test-managed-job', kind:'fix', baseSha:sha, issueSnapshot:{number:1} } as Job;
  const workspace = await prepareWorktree(repo,job,root); await writeFile(join(workspace.path,'README.md'),'changed in isolated task');
  assert.equal(await readFile(join(source,'README.md'),'utf8'),'fixture');
  await assert.rejects(prepareManagedCheckout({...repo,fullName:'../../invalid'},root), /无效/);
});
