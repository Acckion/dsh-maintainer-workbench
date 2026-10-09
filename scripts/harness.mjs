import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const data = resolve(process.env.MAINTAINER_DATA_DIR ?? resolve(root, '.data/native'));
await mkdir(data, { recursive: true });
const overlay = resolve(data, 'harness-dev.patch.yml');
await writeFile(overlay, `- id: hmr\n  disabled: true\n- insert:\n    - id: maintainer-tool-pruner\n      name: "@deepseek-ai/dsh-compaction-tool-result-pruner"\n      config:\n        thresholdChars: 3000\n        headChars: 1600\n        tailChars: 600\n    - id: maintainer-compaction\n      name: "@deepseek-ai/dsh-compaction-basic"\n      config:\n        auto: false\n        headroomTokens: 4096\n        maxTokens: 2048\n        retainTokens: 2000\n        maxOverflowRetries: 1\n    - id: maintainer-local\n      name: ${JSON.stringify(resolve(root, 'dist/plugin.js'))}\n`);
// Normal launch preserves DSH_HOME and all host-managed credentials/providers.
// Isolation is explicit, useful for development and tests only.
const isolated = process.argv.includes('--isolated');
const env = { ...process.env, MAINTAINER_DATA_DIR: data, ...(isolated ? { DSH_HOME: resolve(root, '.harness-local') } : {}) };
console.log(isolated ? 'Harness: explicit isolated development profile (.harness-local)' : 'Harness: inherit existing DSH_HOME / normal user profile; configure models in host Settings');
const child = spawn(process.execPath, [resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', process.env.HARNESS_PROFILE ?? 'web', '--patch', overlay, '--no-open', '--port', process.env.HARNESS_PORT ?? '4318'], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
