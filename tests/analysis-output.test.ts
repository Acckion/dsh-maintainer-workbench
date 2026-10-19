import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalysis, parseObject } from '../src/core/intelligence.ts';
import { fixtureAnalysis, seedFixture } from './support/fixtures.ts';
import { Store } from '../src/core/store.ts';
import { Workbench } from '../src/core/workbench.ts';
import { GitHub } from '../src/core/github.ts';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function sample() { const store = new Store(':memory:'); seedFixture(store); const value = fixtureAnalysis(store.issues()[0], 'triage'); store.close(); return value; }
test('recovers redundant array closer from real failure pattern without changing prose or test status', () => {
  const value = { ...sample(), responseDraft: '引用 "text" 和 Windows \\path；保留字符串里的 ], } 与换行\n下一行' };
  const text = JSON.stringify(value).replace(',"tests":', '],"tests":');
  let repairs = 0;
  assert.deepEqual(parseAnalysis(text, () => repairs++), value);
  assert.equal(repairs, 1);
  assert.deepEqual(parseAnalysis('```json\n' + JSON.stringify(value) + '\n```'), value);
  assert.deepEqual(parseAnalysis(JSON.stringify(value).slice(0, -1) + ',}'), value);
});
test('rejects truncated, incomplete and semantically invalid reports instead of inventing fields', () => {
  const text = JSON.stringify(sample());
  assert.throws(() => parseAnalysis(text.slice(0, -2)), /截断/);
  assert.throws(() => parseAnalysis('{"summary":"partial"}'), /字段/);
  assert.throws(() => parseAnalysis(JSON.stringify({ ...sample(), confidence: 2 })), /confidence/);
  assert.throws(() => parseAnalysis(text + text), /格式/);
});
test('failed parsing keeps raw model output in persisted job for inspection', async () => {
  const store = new Store(':memory:'); seedFixture(store);
  const github = new GitHub(''); github.profile = async repo => repo.profile!;
  const workbench = new Workbench(store, await mkdtemp(join(tmpdir(), 'mw-output-')), async ({recordOutput}) => {
    recordOutput?.('{"summary":"unfinished');
    throw new Error('模型结果可能被截断');
  }, github, false);
  workbench.enqueue([store.issues()[0].id], 'triage'); workbench.pump(); await workbench.drain();
  assert.equal(store.jobs()[0].status, 'failed');
  assert.equal(store.jobs()[0].rawOutput, '{"summary":"unfinished');
  await workbench.close();
});


test('recovers exactly one complete report surrounded by brief prose or a JSON fence', () => {
  const value={...sample(),responseDraft:'嵌套与转义：{ [ ] }，引用 "quote"，路径 \\folder'};
  const body=JSON.stringify(value);
  for(const raw of [
    'Verified real current-session tool-call IDs. Producing the corrected review.\n\n'+body,
    body+'\n报告整理完成。',
    '报告如下：\n```json\n'+body+'\n```\n报告整理完成。',
  ]) {
    let repairs=0;
    assert.deepEqual(parseAnalysis(raw,()=>repairs++),value);
    assert.equal(repairs,1);
  }
});

test('envelope recovery rejects multiple, nested-only, truncated and invalid-schema reports', () => {
  const body=JSON.stringify(sample());
  for(const raw of [
    '报告：'+body+'\n另一份：'+body,
    '报告：'+body+'\n另一份：{"unfinished":',
    '报告：[ '+body+' ]',
    '报告：{"outer":'+body,
    '报告：'+body.slice(0,-2),
    '报告：'+body+'\n[]',
  ]) assert.throws(()=>parseAnalysis(raw),/格式|截断/);
  assert.throws(()=>parseAnalysis('报告：{"summary":"partial"}'),/字段/);
  assert.throws(()=>parseAnalysis('报告：'+JSON.stringify({...sample(),confidence:2})),/confidence/);
});

test('recovered review JSON must still pass the stage schema and native evidence gate', async () => {
  const {parseArtifact}=await import('../src/core/artifacts.ts');
  const {reviewEvidenceGate}=await import('../src/core/review-evidence.ts');
  const raw='Verified real current-session tool-call IDs. Producing the corrected review.\n'+JSON.stringify({schemaVersion:1,stage:'review',summary:'no findings',coverage:'source read claimed',evidence:[],nextSteps:[],responseDraft:'',inspectedSources:[{executionId:'invented-call',path:'src/a.ts',line:1,quote:'const a = 1;'}],findings:[],followups:[],verdict:'no_findings',blockers:[]});
  const artifact=parseArtifact('review',parseObject(raw));
  const job={kind:'review',worktree:'/tmp/nonexistent-envelope-evidence-fixture',sessionId:'current-session',baseSha:'a'.repeat(40),executionRecords:[]} as unknown as import('../src/core/types.ts').Job;
  const gate=await reviewEvidenceGate(job,artifact);
  assert.equal(gate.allowed,false);
  assert.match(gate.reasons.join(' '),/未关联同 Session/);
});
