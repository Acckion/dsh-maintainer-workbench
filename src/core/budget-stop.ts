import {relative,isAbsolute} from 'node:path';
import {artifactSchemas,type Artifact,asAnalysis} from './artifacts.ts';
import {parseReport} from './report-finalizer.ts';
import {reconcileTestExecutions} from './execution-links.ts';
import type {Job,ExecutionRecord} from './types.ts';
import {inScope,safeRepoPath} from '../domain/maintenance.ts';
/** A budget stop is never task success, even if the model submits an optimistic report. */
export class BudgetStopError extends Error {
  override name='BudgetStopError';
  constructor(message:string,readonly artifact:Artifact){super(message);}
}
export function budgetStopArtifact(job:Job,reason:string,records:ExecutionRecord[],root:string,raw=''):Artifact {
  const common={schemaVersion:1,stage:job.kind,summary:reason.slice(0,1000),coverage:'仅保留已取得的证据，未完成必要检查',evidence:records.filter(r=>!r.isError).slice(-20).map(r=>({source:r.sourcePath??r.command??r.id,detail:`工具记录 ${r.id}；${r.tool}，不代表完成验收`})),nextSteps:['查看已有证据，缩小范围或调整预算后明确继续'],responseDraft:''};
  const defaults={facts:[],hypotheses:[],reproduction:'未确认',rootCause:'未确认',impact:'未确认',proposedChanges:[],acceptanceCriteria:[],blockers:[reason.slice(0,5000)],changes:[],limitations:[reason.slice(0,5000)],tests:[],findings:[],followups:[],verdict:'incomplete',environment:'尚未完成验证',classification:'unknown',intent:'尚未完成预检',risks:[],readiness:'blocked',category:'maintenance',priority:'P2',labels:[],module:'unknown',missingInfo:[reason.slice(0,5000)],duplicateOf:null,duplicateReason:'',route:'investigate',routeReason:reason.slice(0,5000)};
  let artifact=artifactSchemas[job.kind].parse({...defaults,...common}) as Artifact;
  if(raw){try{artifact=parseReport(job.kind,raw,()=>{}, {...job,executionRecords:records});}catch{/* Invalid output cannot discard host evidence. */}}
  artifact={...artifact,summary:('本阶段未完成：'+artifact.summary).slice(0,6000),inputRequest:undefined,gaps:undefined,nextSteps:['查看已有证据，缩小范围或调整预算后明确继续'],responseDraft:''};
  if('blockers' in artifact)artifact={...artifact,blockers:[reason.slice(0,5000),...artifact.blockers].slice(0,30)};
  if('limitations' in artifact)artifact={...artifact,limitations:[reason.slice(0,5000),...artifact.limitations].slice(0,30)};
  if(artifact.stage==='review')artifact={...artifact,verdict:'incomplete'};
  if(artifact.stage==='preflight')artifact={...artifact,readiness:'blocked',planDraft:undefined};
  if(artifact.stage==='investigate'){
    const read=[...new Set(records.filter(r=>r.tool==='read'&&!r.isError&&r.sourcePath).map(r=>isAbsolute(r.sourcePath!)?relative(root,r.sourcePath!):r.sourcePath!).filter(safeRepoPath))];
    const scope=job.maintenanceScope;
    const maintenance=scope===undefined?artifact.maintenance:{...artifact.maintenance,findings:artifact.maintenance?.findings??[],documents:artifact.maintenance?.documents??[],checkedPaths:read.filter(p=>inScope(p,scope)).slice(0,300),complete:false};
    artifact={...artifact,planDraft:undefined,maintenance:maintenance?{...maintenance,complete:false}:undefined};
  }
  return reconcileTestExecutions(artifact,{...job,executionRecords:records});
}
export function budgetStopOutput(error:BudgetStopError){return {artifact:error.artifact,result:asAnalysis(error.artifact),budgetStopped:true};}
