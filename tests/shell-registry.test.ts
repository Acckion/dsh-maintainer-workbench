import test from 'node:test';
import assert from 'node:assert/strict';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools';
import { createScope } from '@deepseek-ai/dsh-scope';
import { documentToolAllow } from '../src/core/context-budget.ts';
import { validationToolAllow, validationCommandBlocker } from '../src/core/validation-context.ts';
import { resolveShellTool, platformShellTool, isShellToolName } from '../src/core/shell-tools.ts';

const fixtureTool = (name: string) => defineTool({
  name,
  description: `fixture ${name}`,
  parameters: {},
  output: {
    schema: { type: 'string' },
    render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
  },
  async execute() { return 'ok'; },
});

/** Globals a Windows host session registers, with `pwsh` instead of `bash`. */
const WINDOWS_HOST_GLOBALS = ['read', 'glob', 'grep', 'edit', 'write', 'job_output', 'job_list', 'job_kill', 'pwsh', 'ask_user_question'];

test('stage allow lists pass the real tools.restrict() on a pwsh-only host', async t => {
  const registry = new CordisContext();
  new SystemPrompt(registry, SystemPrompt.Config({}));
  new ToolRuntime(registry);
  const removals = WINDOWS_HOST_GLOBALS.map(name => registry.tools.register(fixtureTool(name)));
  const docsKey = {};
  const docsScope = createScope(registry, docsKey);
  const removeScoped = docsScope.ctx.tools.register(fixtureTool('submit_stage_report'));
  t.after(async () => { await docsScope.dispose(); removeScoped(); for (const remove of removals) remove(); });

  const visible = docsScope.ctx.tools.schemas(docsKey).map(tool => tool.name);
  assert.equal(resolveShellTool(visible, 'win32'), 'pwsh');

  assert.throws(
    () => docsScope.ctx.tools.restrict({ allow: ['read', 'glob', 'grep', 'edit', 'write', 'bash', 'job_output', 'job_list', 'job_kill', 'ask_user_question'] }),
    /unknown global tool "bash"/,
    'the previous hardcoded bash allow list must keep failing on a pwsh-only host',
  );

  docsScope.ctx.tools.restrict({ allow: documentToolAllow('pwsh') });
  const docsVisible = docsScope.ctx.tools.schemas(docsKey).map(tool => tool.name);
  for (const name of ['read', 'edit', 'write', 'pwsh', 'ask_user_question']) assert.ok(docsVisible.includes(name), `docs stage keeps ${name}`);
  assert.ok(docsVisible.includes('submit_stage_report'), 'stage-scoped report tool survives the global restriction');

  const validateKey = {};
  const validateScope = createScope(registry, validateKey);
  t.after(async () => { await validateScope.dispose(); });
  validateScope.ctx.tools.restrict({ allow: validationToolAllow('pwsh') });
  const validateVisible = validateScope.ctx.tools.schemas(validateKey).map(tool => tool.name);
  for (const name of ['read', 'glob', 'grep', 'pwsh', 'ask_user_question']) assert.ok(validateVisible.includes(name), `validate stage keeps ${name}`);
  for (const name of ['edit', 'write']) assert.ok(!validateVisible.includes(name), `validate stage strips ${name}`);
});

test('a host without any known shell tool degrades to a shell-less allow list instead of failing setup', async t => {
  const registry = new CordisContext();
  new SystemPrompt(registry, SystemPrompt.Config({}));
  new ToolRuntime(registry);
  const globals = ['read', 'glob', 'grep', 'job_output', 'job_list', 'job_kill', 'ask_user_question'];
  const removals = globals.map(name => registry.tools.register(fixtureTool(name)));
  t.after(async () => { for (const remove of removals) remove(); });

  const shellTool = resolveShellTool(globals, 'win32');
  assert.equal(shellTool, undefined);
  const key = {};
  const scope = createScope(registry, key);
  t.after(async () => { await scope.dispose(); });
  scope.ctx.tools.restrict({ allow: validationToolAllow(shellTool) });
  assert.deepEqual(scope.ctx.tools.schemas(key).map(tool => tool.name).sort(), [...globals].sort());
});

test('shell tool resolution prefers the platform tool and validates shell blockers by candidate name', () => {
  assert.equal(platformShellTool('win32'), 'pwsh');
  assert.equal(platformShellTool('linux'), 'bash');
  assert.equal(resolveShellTool(['read', 'bash'], 'linux'), 'bash');
  assert.equal(resolveShellTool(['bash', 'pwsh'], 'win32'), 'pwsh');
  assert.equal(resolveShellTool(['bash', 'pwsh'], 'linux'), 'bash');
  assert.equal(resolveShellTool([], 'win32'), undefined);
  assert.ok(isShellToolName('bash') && isShellToolName('pwsh'));
  assert.ok(!isShellToolName('read') && !isShellToolName('terminal'));
  assert.ok(validationCommandBlocker('pwsh', { command: 'npm install vitest' }));
  assert.equal(validationCommandBlocker('pwsh', { command: 'node --test' }), undefined);
});
