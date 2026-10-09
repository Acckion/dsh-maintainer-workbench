import test from 'node:test';
import assert from 'node:assert/strict';
import { planningInputRequest } from '../src/core/change-plan.ts';
import { artifactSchemas, asAnalysis } from '../src/core/artifacts.ts';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { seedFixture } from './support/fixtures.ts';
import type { InputRequest } from '../src/domain/input.ts';
import type { Job } from '../src/core/types.ts';
const confirm: InputRequest = { reason: '需维护者一次性确认计划', fields: [{ id: 'confirm_plan', question: '是否确认按本计划草稿实施：仅新增检查清单？' }] };
const artifact = (request: InputRequest) => artifactSchemas.triage.parse({
  schemaVersion: 1, stage: 'triage', summary: '新增文档范围明确', coverage: 'Issue 正文', evidence: [], nextSteps: [], responseDraft: '',
  category: 'docs', priority: 'P3', labels: [], module: 'docs', impact: '文档', missingInfo: [], duplicateOf: null, duplicateReason: '', route: 'decision', routeReason: '确认计划',
  inputRequest: request, planDraft: { category: 'docs', goal: '新增检查清单', scope: '仅新增 WORKBENCH-EVAL.md', reproduction: '', expected: '', actual: '',
    acceptanceCriteria: ['清单内容完整，链接有效'], sources: [], missingInfo: [], route: 'docs' },
});
test('complete draft routes only plan confirmation to the host without granting execution', () => {
  assert.equal(planningInputRequest(artifact(confirm), confirm), undefined);
  const explicit: InputRequest = { ...confirm, fields: [{ id: 'approve', question: '继续？', purpose: 'plan_confirmation' }] };
  assert.equal(planningInputRequest(artifact(explicit), explicit), undefined);
});
test('real information and substantive yes/no decisions remain inputs, including mixed requests', () => {
  for (const field of [
    { id: 'version', question: '使用哪个版本？', purpose: 'information' as const },
    { id: 'confirm_plan', question: '是否把排序设置应用到所有用户？', purpose: 'decision' as const },
    { id: 'confirm_plan', question: '是否选择固定排序？' },
  ]) {
    const request = { ...confirm, fields: [field] };
    assert.deepEqual(planningInputRequest(artifact(request), request), request);
    const mixed = { ...confirm, fields: [...confirm.fields, field.id === 'confirm_plan' ? { ...field, id: 'ordering' } : field] };
    assert.deepEqual(planningInputRequest(artifact(mixed), mixed)?.fields, mixed.fields.slice(1));
  }
});
test('missing or incomplete plans never erase an input request', () => {
  const a = artifact(confirm);
  assert.equal(planningInputRequest({ ...a, planDraft: undefined }, confirm), confirm);
  assert.equal(planningInputRequest({ ...a, planDraft: { ...a.planDraft!, scope: '' } }, confirm), confirm);
});
for (const genuine of [false, true]) test(`analysis worker ${genuine ? 'preserves real questions' : 'publishes a plan for one UI confirmation'}`, async () => {
  const store = new Store(':memory:'); seedFixture(store);
  const request = genuine ? { reason: '缺少版本', fields: [{ id: 'version', question: '使用哪个版本？', purpose: 'information' as const }] } : confirm;
  const a = artifact(request);
  const wb = new Workbench(store, '/tmp/workbench-plan-input-tests', async () => ({ artifact: a, result: asAnalysis(a), engine: 'fixture' }), undefined, true);
  try {
    const issue = store.issues()[0]; wb.orchestration.analyze([issue.id]); await wb.drain();
    assert.equal(store.jobs()[0].status, genuine ? 'waiting_input' : 'completed');
    assert.equal(store.issues()[0].processing?.waits.some(w => w.type === 'user_input' && w.state === 'open'), genuine);
    assert.equal(store.jobs().length, 1);
    assert.equal(store.issues()[0].plan, undefined);
    assert.equal(store.issues()[0].orchestration?.run, undefined);
    if (!genuine) assert.equal(store.issues()[0].orchestration?.draft?.goal, '新增检查清单');
  } finally { await wb.close(); }
});
test('recover existing confirmation wait idempotently without executing or changing genuine waits', async () => {
  const store = new Store(':memory:'); seedFixture(store);
  const wb = new Workbench(store, '/tmp/workbench-plan-input-tests', async () => { throw Error('Recovery must not call a model'); }, undefined, false);
  try {
    const issue = store.issues()[0]; const id = wb.enqueue([issue.id], 'triage').created[0];
    const a = artifact(confirm);
    store.put('jobs', { ...store.get<Job>('jobs', id)!, status: 'waiting_input', artifact: a, result: asAnalysis(a) });
    const wait = wb.processing.requestInput(issue.id, confirm, id);
    assert.equal(wb.orchestration.recoverPlanConfirmation(id), true);
    wb.orchestration.reconcile();
    assert.equal(wb.orchestration.recoverPlanConfirmation(id), false);
    assert.equal(store.jobs().length, 1);
    assert.equal(store.jobs()[0].status, 'completed');
    assert.equal(store.processing.current(issue.id)?.waits.find(w => w.id === wait.id)?.state, 'cancelled');
    assert.equal(store.issues()[0].orchestration?.draft?.goal, '新增检查清单');
    assert.equal(store.issues()[0].plan, undefined);
    assert.equal(store.issues()[0].orchestration?.run, undefined);
    const other = store.issues()[1]; const otherId = wb.enqueue([other.id], 'triage').created[0];
    const real = { reason: '需决定范围', fields: [{ id: 'scope', question: '应用到所有用户吗？', purpose: 'decision' as const }] };
    const b = artifact(real); store.put('jobs', { ...store.get<Job>('jobs', otherId)!, status: 'waiting_input', artifact: b, result: asAnalysis(b) });
    const genuineWait = wb.processing.requestInput(other.id, real, otherId);
    assert.equal(wb.orchestration.recoverPlanConfirmation(otherId), false);
    assert.equal(store.processing.current(other.id)?.waits.find(w => w.id === genuineWait.id)?.state, 'open');
  } finally { await wb.close(); }
});
