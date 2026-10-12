import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Artifact } from './artifacts.ts';
import type { Job, ExecutionRecord } from './types.ts';
import { linkedExecution } from './execution-links.ts';
const quote=(text:string)=>"'"+text.replace(/'/g,"'\\''")+"'";
export function documentCheckCommand(job: Pick<Job,'worktree'|'baseSha'>): string {
 const script=[new URL('../scripts/verify-document-patch.mjs',import.meta.url),new URL('../../scripts/verify-document-patch.mjs',import.meta.url)].find(url=>existsSync(url));
 if(!script) throw new Error('插件安装不完整：缺少文档检查脚本');
 return [process.execPath, fileURLToPath(script), job.worktree!, job.baseSha].map(quote).join(' ');
}
function isDocumentCheckCommand(command: string | undefined, job: Pick<Job,'worktree'|'baseSha'>): boolean {
 const expected=documentCheckCommand(job), actual=command?.trim();
 if(actual===expected)return true;
 // Only permit a literal exit-code echo after the exact host-owned invocation.
 // Do not accept pipelines, substitutions, or extra commands as checker evidence.
 return !!actual?.startsWith(expected) && /^;\s*echo "[A-Za-z_][A-Za-z0-9_]*=\$\?"$/.test(actual.slice(expected.length));
}
function documentCheckEvidence(job: Job) {
 const command=documentCheckCommand(job);
 const record=[...(job.executionRecords??[])].reverse().find(r=>isDocumentCheckCommand(r.command,job)&&linkedExecution(job,{command:r.command!,executionId:r.id})===r);
 let data: {checks?:Record<string,boolean>;limitations?:string[]}|undefined;
 try{const line=record?.output.split('\n').find(l=>l.startsWith('DOCUMENT_CHECKS_JSON='));if(line)data=JSON.parse(line.slice('DOCUMENT_CHECKS_JSON='.length));}catch{}
 const required=['whitespace','link_files','link_anchors','exact_repetition'];
 const complete=record&&!record.isError&&record.exitCode===0&&required.every(k=>data?.checks?.[k]===true);
 return {command,record,data,complete};
}
export function documentChecksPassed(job: Job): boolean {
 return job.kind==='validate' && !!job.handoff?.some(h=>h.id===job.sourceJobId&&h.kind==='docs') && !!documentCheckEvidence(job).complete;
}
export function documentAcceptance(artifact: Artifact, job: Job): Artifact {
 if(artifact.stage!=='validate'||!job.handoff?.some(h=>h.id===job.sourceJobId&&h.kind==='docs'))return artifact;
 const {command,record,data,complete}=documentCheckEvidence(job);
 const required=['whitespace','link_files','link_anchors','exact_repetition'];
 const blockers=required.filter(k=>data?.checks?.[k]!==true).map(k=>`文档验收未通过或缺少本次执行证据：${k}`);
 // Only explicit extra commands join the host-owned document acceptance gate.
 // Other model probes remain visible as supplemental coverage, never as passed
 // evidence or as an invented additional required test.
 const extra=artifact.tests.filter(t=>!isDocumentCheckCommand(t.command,job));
 const requiredExtra=extra.filter(t=>!!job.instructions?.includes(t.command.trim()));
 const supplemental=extra.filter(t=>!requiredExtra.includes(t));
 const supplementalEvidence=supplemental.map(t=>{
  const r=linkedExecution(job,t);
  const status=r && r.exitCode!==null ? !r.isError && r.exitCode===0 ? 'passed' : 'failed' : 'not_run';
  return {source:`补充检查（不计入本次验收）：${t.command}`,detail:`${status}：${status==='not_run'?'报告描述无法精确关联当前执行记录；不作为成功证据':`执行记录 ${r!.id}，退出码 ${r!.exitCode}`}`};
 });
 const test={command:record?.command??command,status:complete?'passed' as const:record?'failed' as const:'not_run' as const,output:complete?'差异空白、新增相对链接文件、锚点及完全重复文本检查通过。':blockers.join('；'),...(record?{executionId:record.id}:{})};
 return {...artifact,summary:complete?'指定文档检查通过；语义重复仍需人工复审。':'文档验收不完整，不能确认全部通过。',coverage:'仅核验文档差异、相对链接文件、标题锚点和完全重复文本；语义重复需人工复审，未执行安装或运行。'+(supplemental.length?`${supplemental.length} 项补充检查单独展示，不计入本次必需验收。`:''),evidence:[{source:record?.id??'缺少执行记录',detail:test.output},...supplementalEvidence].slice(0,30),tests:[...requiredExtra,test],blockers:[...new Set([...artifact.blockers,...blockers,...(!complete&&!blockers.length?['文档检查进程未成功完成']:[])])],responseDraft:complete?'指定文档自动检查通过；尚需人工复审说明是否在语义上重复。未执行安装或运行测试，未提交或发布。':'本次缺少完整文档验收证据，暂不能接受或发布。请补齐链接、锚点和重复文本检查。',nextSteps:complete?['人工复审文档必要性及语义重复']:['补齐本次文档验收检查']};
}

/** Missing required execution gets one repair; an attempted failure is retained, not retried. */
export function needsDocumentCheckExecution(job: Pick<Job,'worktree'|'baseSha'>, records: ExecutionRecord[]): boolean {
 return !records.some(record => isDocumentCheckCommand(record.command,job));
}
