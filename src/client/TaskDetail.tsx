import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowLeft,X} from 'lucide-react';
import type {Audit,Issue,Job} from '../core/types.ts';
import {kindNames} from '../core/types.ts';
import {RepositoryPatch} from './RepositoryDetail.tsx';
import {StageProgress} from './StageProgress.tsx';
import {StageResult} from './StageResult.tsx';
import {StageExecutionDetails} from './StageExecutionDetails.tsx';
import {ReviewSummary,type DetailTab} from './ReviewSummary.tsx';
import {Tag,Empty} from './Primitives.tsx';
import {taskStatus} from './review-evidence.ts';

type Request={sequence:number;tab:DetailTab;path?:string;line?:number};
const tabs:Record<DetailTab,string>={overview:'概览',log:'执行记录',diff:'文件差异',evidence:'审阅与证据'};
/** Task details stay bound to the selected run; opening the source is an explicit action. */
export function TaskDetail({job,issue,jobs,members,audit,repository,native,requested,input,actions,reviewControls,tools,open,openSession,source,back,backLabel,close}:{job:Job;issue?:Issue;jobs:Job[];members:Job[];audit:Audit[];repository:string;native:boolean;requested?:Request;input?:ReactNode;actions:ReactNode;reviewControls?:ReactNode;tools?:ReactNode;open:(id:string,tab:DetailTab)=>void;openSession?:(id:string)=>void;source?:()=>void;back:()=>void;backLabel:string;close:()=>void}) {
  const [tab,setTab]=useState<DetailTab>('overview'),[location,setLocation]=useState<{path:string;line?:number}>();
  const reader=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(requested){setTab(requested.tab);setLocation(requested.path?{path:requested.path,line:requested.line}:undefined);}},[requested?.sequence]);
  useEffect(()=>{reader.current?.scrollTo({top:0});},[tab,job.id]);
  const liveIssue=issue??job.issueSnapshot,status=taskStatus(job);
  const showProgress=['queued','running','failed','cancelled','waiting_input','waiting_environment'].includes(job.status)||!job.artifact&&!job.result;
  const showLocation=(path:string,line?:number)=>{setLocation({path,line});setTab('diff');};
  return <aside id="mw-detail" tabIndex={-1} className="mw-detail mw-reader-embedded mw-task-detail" aria-label="任务详情" data-job-id={job.id}>
    <header className="mw-reader-header"><div className="mw-task-detail-heading"><button className={`mw-icon-button mw-task-back ${backLabel==='返回来源列表'?'has-source':''}`} aria-label={backLabel} onClick={back}><ArrowLeft size={16}/></button><div><p>{kindNames[job.kind]} · 第 {job.attempt} 次尝试</p><h2>{job.issueSnapshot.title}</h2></div><button className="mw-icon-button" aria-label="关闭任务详情" onClick={close}><X size={16}/></button></div>
      <div className="mw-task-detail-meta"><Tag tone={status.tone}>{status.label}</Tag>{job.artifactState==='stale'&&<Tag tone="warn">旧版本产物</Tag>}<span>{repository}</span><code title={job.id}>{job.id.slice(0,8)}</code>{source&&<button className="mw-text-button" onClick={source}>查看关联 {job.issueSnapshot.type==='pr'?'PR':'Issue'} #{job.issueSnapshot.number}</button>}</div>
      {members.length>1&&<label className="mw-task-step-picker">处理步骤<select aria-label="选择任务处理步骤" value={job.id} onChange={e=>open(e.target.value,'overview')}>{members.map(step=><option key={step.id} value={step.id}>{kindNames[step.kind]} · {taskStatus(step).label} · {step.id.slice(0,8)}</option>)}</select></label>}
      <nav className="mw-reader-tabs" aria-label="任务详情页面">{Object.entries(tabs).map(([key,label])=><button key={key} className={tab===key?'active':''} aria-current={tab===key?'page':undefined} onClick={()=>setTab(key as DetailTab)}>{label}</button>)}</nav>
    </header>
    <div className="mw-task-detail-content" ref={reader}>
      {tab==='overview'&&<>{showProgress&&<StageProgress job={job} issue={liveIssue} audit={audit} readOnly={!issue} input={issue?input:undefined} openSession={openSession}/>} {(job.artifact||job.result)&&<StageResult job={job} open={open} openLocation={showLocation}/>}<section aria-label="任务操作">{actions}</section></>}
      {tab==='log'&&<StageExecutionDetails job={job} audit={audit} tools={tools} showOpenEvidence={false} openEvidence={id=>open(id,'log')} openSession={openSession}/>}
      {tab==='diff'&&<>{location&&<p className="mw-task-diff-location">发现位置：<code>{location.path}{location.line?`:${location.line}`:''}</code> · 本次任务保存的补丁</p>}{job.patch?<RepositoryPatch patch={job.patch}/>:<Empty title="本次任务没有保存文件差异" text="此处仅展示所选任务的补丁，其他步骤的改动可通过处理步骤或关联证据查看。"/>}</>}
      {tab==='evidence'&&<><ReviewSummary job={job} jobs={jobs} audit={audit} native={native} issue={issue} open={open} openSession={openSession} openLocation={showLocation} deliveryActions={actions}/>{reviewControls}</>}
    </div>
  </aside>;
}
