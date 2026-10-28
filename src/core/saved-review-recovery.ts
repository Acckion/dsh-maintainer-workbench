import {resolve} from 'node:path';
import {executionReference} from './execution-reference.ts';
import {parseObject} from './report-json.ts';
import {parseReport} from './report-finalizer.ts';
import {executionWithinWorktree} from './execution-cwd-native.ts';
import type {Job} from './types.ts';

/** Deterministic citation repair only. Never run code, call a model, or edit report conclusions. */
export function recoverSavedReviewArtifact(job:Job){
 if(job.kind!=='review'||!job.rawOutput||!job.sessionId||!job.worktree||!job.patchSha256)throw Error('缺少可复用的审查报告或执行检查点');
 const body=parseObject(job.rawOutput,()=>{});
 if(!body||typeof body!=='object'||Array.isArray(body)||(body as any).reportFormat!=='compact-v1')throw Error('原始报告不是可安全恢复的结构；原始记录已保留');
 const report=structuredClone(body) as Record<string,any>;
 const recordFor=(id:string)=>{
  const r=executionReference(job.executionRecords??[],id,job.sessionId);
  if(!r||r.sessionId!==job.sessionId||r.checkoutSha!==job.baseSha||r.patchHash!==job.patchSha256||r.isError||r.signal||!executionWithinWorktree(job.worktree!,r.cwd))throw Error(`引用 ${id} 缺少同会话、同版本、同补丁的成功执行记录`);
  return r;
 };
 const source=(ref:any)=>{
  const r=recordFor(ref.executionId);
  const path=resolve(job.worktree!,ref.path);
  if(!(r.sourcePath&&resolve(job.worktree!,r.sourcePath)===path&&/read|file|open/i.test(r.tool))&&!(r.command&&/\b(cat|nl|sed|rg|head|tail|awk)\b/.test(r.command)&&r.command.includes(ref.path)))throw Error(`引用 ${ref.executionId} 不是对应文件的读取`);
  const lines=r.output.split('\n').map(text=>text.match(/^\s*(\d+)(?:\s*[|:] ?|[ \t]+)(.*)$/)).filter(Boolean) as RegExpMatchArray[];
  let line=lines.find(line=>Number(line[1])===ref.line);
  if(ref.quote?.trim()&&(!line||!line[2].trim().includes(ref.quote.trim()))){
   const matches=lines.filter(line=>line[2].trim().includes(ref.quote.trim()));
   if(matches.length!==1)throw Error(`引用 ${ref.executionId} 的原文无法唯一定位，不能猜测行号`);
   line=matches[0];
  }
  if(!line?.[2].trim())throw Error(`引用 ${ref.executionId} 没有可核验的完整源码行`);
  return {...ref,executionId:r.id,line:Number(line[1]),quote:line[2]};
 };
 report.inspectedSources=report.inspectedSources?.map(source);
 report.findings=report.findings?.map((f:any)=>{
  if(f.sourceEvidence){if(f.sourceEvidence.path!==f.path)throw Error('发现与源码引用路径不同，不能自动修复');f.sourceEvidence=source(f.sourceEvidence);f.line=f.sourceEvidence.line;}
  const repro=f.reproduction;
  if(repro?.basis==='executed'&&repro.executionId){
   const r=recordFor(repro.executionId);
   if(!r.command||r.exitCode===null||!repro.outputQuote?.trim()||!r.output.includes(repro.outputQuote.trim()))throw Error('复现引用缺少实际命令、退出码或原始输出');
   const command=repro.command?.trim();
   if(command&&command!==r.command.trim()){
    const prefix=command.split(/["']/)[0].trim();
    if(!/(\.\.\.|…)/.test(command)||!prefix||!r.command.trim().startsWith(prefix))throw Error('复现命令冲突，不能自动替换');
   }
   repro.executionId=r.id;repro.command=r.command;
  }
  return f;
 });
 return parseReport('review',JSON.stringify(report),()=>{},job);
}
