import {useEffect,useMemo,useState} from 'react';
import {FileCode2,FileDiff,Terminal,FileText,WrapText} from 'lucide-react';
import type {Job} from '../core/types.ts';
import {diffLines} from './diff-lines.ts';
import {analysisEvidence,citedExecution,evidenceBlocks,evidenceTitle,numberedCode,relativeEvidencePath,type Evidence,type EvidenceBlock} from './evidence-presentation.ts';

const names={file:'文件',diff:'Diff',command:'命令',text:'说明'};
const icons={file:FileCode2,diff:FileDiff,command:Terminal,text:FileText};

/** A read-only view of saved evidence. Selecting a file never reads a live checkout or runs a tool. */
export function AnalysisEvidence({job,evidence=job?analysisEvidence(job):[],label='分析依据',collapsible=true}:{job?:Job;evidence?:Evidence[];label?:string;collapsible?:boolean}) {
  const [selected,setSelected]=useState(0),[wrap,setWrap]=useState(false);
  useEffect(()=>setSelected(0),[job?.id]);
  useEffect(()=>setSelected(index=>Math.min(index,Math.max(0,evidence.length-1))),[evidence.length]);
  const entries=useMemo(()=>evidence.map(item=>evidenceTitle(item,job)),[evidence,job?.executionRecords,job?.worktree,job?.analysisPath]);
  if(!evidence.length)return null;
  const index=Math.min(selected,evidence.length-1);
  const Container=collapsible?'details':'section';
  return <Container className="mw-analysis-evidence">
    {collapsible?<summary>{label} · {evidence.length}</summary>:null}
    <div className="mw-evidence-browser" role="region" aria-label={label+'阅读器'}>
      <nav className="mw-evidence-files" aria-label="依据列表">{entries.map((entry,i)=>{const Icon=icons[entry.kind];return <button type="button" className={i===index?'active':''} aria-current={i===index?'true':undefined} onClick={()=>setSelected(i)} key={i} title={entry.title}><Icon size={15}/><span>{entry.title}</span><small>{names[entry.kind]}</small></button>;})}</nav>
      <label className="mw-evidence-mobile-picker">选择依据<select aria-label="选择分析依据" value={index} onChange={e=>setSelected(Number(e.target.value))}>{entries.map((entry,i)=><option key={i} value={i}>{i+1}. {entry.title}</option>)}</select></label>
      <EvidenceReader key={`${job?.id??''}:${index}:${evidence[index].source}`} job={job} evidence={evidence[index]} title={entries[index].title} kind={entries[index].kind} wrap={wrap} toggleWrap={()=>setWrap(value=>!value)}/>
    </div>
  </Container>;
}

function EvidenceReader({job,evidence,title,kind,wrap,toggleWrap}:{job?:Job;evidence:Evidence;title:string;kind:keyof typeof names;wrap:boolean;toggleWrap:()=>void}) {
  const record=citedExecution(evidence,job),[view,setView]=useState<'tool'|'excerpt'>(record?.output?'tool':'excerpt'),[raw,setRaw]=useState(false);
  const text=view==='tool'&&record?.output?record.output:evidence.detail;
  const blocks=useMemo(()=>{const parsed=evidenceBlocks(text);return kind==='file'&&parsed.length===1&&parsed[0].kind==='text'?[{...parsed[0],kind:'code' as const}]:parsed;},[text,kind]);
  return <section className={`mw-evidence-reader${wrap?' wrap':''}`} aria-label="选中依据内容">
    <header className="mw-evidence-file-header"><span className="mw-evidence-kind">{names[kind]}</span><strong title={title}>{title}</strong><button type="button" className={`mw-icon-button ${wrap?'active':''}`} aria-label="自动换行" aria-pressed={wrap} onClick={toggleWrap} title="自动换行"><WrapText size={16}/></button></header>
    <div className="mw-evidence-view-controls">
      {record?.output?<div role="group" aria-label="依据文本来源"><button type="button" aria-pressed={view==='tool'} onClick={()=>setView('tool')}>工具输出</button><button type="button" aria-pressed={view==='excerpt'} onClick={()=>setView('excerpt')}>报告摘录</button></div>:<span>保存的报告摘录</span>}
      <button type="button" className="mw-text-button" aria-pressed={raw} onClick={()=>setRaw(value=>!value)}>{raw?'格式化阅读':'原始文本'}</button>
    </div>
    {view==='tool'&&record?.command&&<div className="mw-evidence-command"><span>执行命令</span><pre>{record.command}</pre></div>}
    {view==='tool'&&record?.truncated&&<p className="mw-evidence-notice">工具输出已裁剪，以下是保存的片段。</p>}
    {job?.artifactState==='stale'&&<p className="mw-evidence-notice">此依据属于历史版本。</p>}
    <div className="mw-evidence-output" tabIndex={0} aria-label="依据正文">{raw?<pre className="mw-evidence-raw">{text}</pre>:blocks.map((block,index)=><EvidenceContent block={block} job={job} showPath={blocks.filter(item=>item.path).length>1} key={index}/>)}</div>
    <details className="mw-evidence-source"><summary>来源信息{record?` · ${record.exitCode===null?'退出码未提供':`退出码 ${record.exitCode}`}${record.isError?' · 工具报错':''}`:''}</summary><dl><dt>引用</dt><dd>{evidence.source}</dd>{record&&<><dt>执行记录</dt><dd>{record.id}</dd><dt>工具</dt><dd>{record.tool}</dd><dt>记录时间</dt><dd>{record.recordedAt}</dd><dt>执行基线</dt><dd>{record.checkoutSha||'未保存'}</dd></>}</dl></details>
  </section>;
}

function EvidenceContent({block,job,showPath}:{block:EvidenceBlock;job?:Job;showPath:boolean}) {
  if(block.kind==='diff')return <section className="mw-evidence-block" aria-label={block.path?relativeEvidencePath(block.path,job)+' 差异':'差异片段'}>
    {block.path&&<h5>{relativeEvidencePath(block.path,job)}</h5>}
    <div className="mw-evidence-code mw-evidence-diff" role="table" aria-label="Diff 内容">{diffLines(block.text).map((line,index)=><div role="row" className={`mw-evidence-code-line ${line.kind}`} key={index}><span role="cell" className="mw-evidence-line-number" aria-label={line.oldLine?`原文件第 ${line.oldLine} 行`:undefined}>{line.oldLine}</span><span role="cell" className="mw-evidence-line-number" aria-label={line.newLine?`新文件第 ${line.newLine} 行`:undefined}>{line.newLine}</span><code role="cell">{line.text||' '}</code></div>)}</div>
  </section>;
  const numbered=numberedCode(block.text);
  return <section className="mw-evidence-block">{showPath&&block.path&&<h5>{relativeEvidencePath(block.path,job)}</h5>}{block.kind==='code'?<>
    <div className="mw-evidence-code" role="table" aria-label={numbered.sourceNumbers?'源码片段':'代码片段'}>{numbered.lines.map((line,index)=><div role="row" className="mw-evidence-code-line" key={index}><span role="cell" className="mw-evidence-line-number" aria-label={line.number?`源文件第 ${line.number} 行`:'摘录行号'}>{line.number??index+1}</span><code role="cell">{line.text||' '}</code></div>)}</div>{numbered.note&&<p className="mw-evidence-end-note">{numbered.note}</p>}
  </>:<pre className="mw-evidence-text">{block.text}</pre>}</section>;
}
