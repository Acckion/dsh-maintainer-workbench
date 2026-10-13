import test from 'node:test';
import assert from 'node:assert/strict';
import { modelInput, discussionInput, taskModelInput } from '../src/core/model-input.ts';
import { maintainerPromptContext } from '../src/core/issue-flow.ts';
import { manualContext } from '../src/workflow/manual.ts';
import { Store } from '../src/core/store.ts';
import { seedFixture } from './support/fixtures.ts';

test('model input preserves literal quotes, newlines, backslashes and JSON-looking source without global unescaping', () => {
  const source = 'const path = "C:\\tmp";\nconst literal = "\\n";\nconst object = {"key":"value"};';
  const text = modelInput({ body: source, nested: { known: false, unavailable: null, absent: undefined } });
  assert.ok(text.includes(source)); assert.ok(!text.includes(JSON.stringify(source)));
  assert.match(text, /known: false/); assert.match(text, /unavailable: unknown/); assert.doesNotMatch(text, /absent:/);
  const context = discussionInput(JSON.stringify({ comments: [{ body: source }] }));
  assert.ok(context.includes(source));
  assert.equal(discussionInput('plain\nsource'), 'plain\nsource');
  assert.match(discussionInput(JSON.stringify({ body: 'x'.repeat(500) }), 50), /truncated by host/);
});

test('quick maintainer context omits duplicate body and old analysis but preserves authoritative manual text', () => {
  const store = new Store(':memory:'); seedFixture(store);
  const original = store.issues()[0];
  const text = '跳过复现\n保留 "C:\\tmp" 和字面量 \\n';
  const issue = { ...original, body: 'BODY_MUST_NOT_REPEAT', analysis: { summary: 'OLD_ANALYSIS_MUST_NOT_REPEAT' } as any,
    processing: { ...store.processing.current(original.id)!, manualSteps: [{ id: 'm', stage: 'investigate', mode: 'skip', text }] as any } };
  const context = modelInput(maintainerPromptContext(issue));
  assert.doesNotMatch(context, /BODY_MUST_NOT_REPEAT|OLD_ANALYSIS_MUST_NOT_REPEAT/);
  assert.ok(context.includes(text)); assert.ok(manualContext(issue).includes(text));
  store.close();
});

test('task instructions and recorded decisions stay separate from untrusted repository bodies', () => {
  const data = { instructions: '仅修改终端组件\n不要修改主题全局配置', issue: { body: 'repository text', plan: { decision: 'accepted', scope: 'terminal' }, providedInputs: [{ value: 'unknown', state: 'unknown' }] } };
  const before = JSON.stringify(data), prompt = taskModelInput(data);
  assert.ok(prompt.indexOf(data.instructions) < prompt.indexOf('REPOSITORY DATA —'));
  assert.ok(prompt.indexOf('decision: accepted') < prompt.indexOf('REPOSITORY DATA —'));
  assert.match(prompt, /state: unknown/); assert.ok(prompt.includes('body: repository text'));
  assert.equal(JSON.stringify(data), before);
});
