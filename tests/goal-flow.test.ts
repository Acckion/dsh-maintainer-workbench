import { artifactSchemas } from '../src/core/artifacts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextGoalStep } from '../src/workflow/continuation.ts';
import type { Issue, Job } from '../src/core/types.ts';
const issue = {state:'open',plan:{category:'bug',decision:'accepted',goal:'Fix sum',reproduction:'Run test',expected:'3',actual:'1',acceptanceCriteria:['test passes']}} as Issue;
const validationArtifact = (status: 'passed'|'failed') => artifactSchemas.validate.parse({schemaVersion:1,stage:'validate',summary:'Validation',coverage:'Unit tests',environment:'Local',evidence:[],nextSteps:[],responseDraft:'',tests:[{command:'node test.cjs',status,output:'Test result'}],blockers:[]});
const job = {goal:'resolve',kind:'fix',status:'awaiting_review',patch:'diff',result:{}} as Job;
test('explicit goals proceed through implementation, validation, and then human review', () => {
 assert.equal(nextGoalStep(job,issue).next,'validate');
 const validated={...job,kind:'validate',status:'completed',artifact:validationArtifact('passed')} as Job;
 assert.equal(nextGoalStep(validated,issue).next,'review');
 assert.ok(nextGoalStep({...job,kind:'review'},issue).pause);
});
test('legacy tasks never start extra agent calls and failed validation never proceeds', () => {
 assert.deepEqual(nextGoalStep({...job,goal:undefined},issue),{});
 assert.ok(nextGoalStep({...job,status:'cancelled'},issue).pause);
 assert.ok(nextGoalStep({...job,kind:'validate',artifact:validationArtifact('failed')} as Job,issue).pause);
 assert.ok(nextGoalStep({...job,artifactState:'stale'},issue).pause);
});
test('investigation stops for human scope acceptance and incomplete bug evidence', () => {
 const investigation={...job,kind:'investigate'} as Job;
 assert.equal(nextGoalStep(investigation,issue).next,'fix');
 assert.ok(nextGoalStep(investigation,{...issue,plan:undefined}).pause);
 assert.ok(nextGoalStep(investigation,{...issue,plan:{...issue.plan!,reproduction:''}}).pause);
});
