import {gapKinds,gapLabels,gapStatusLabels,gapStageLabels,planGaps,type Gap} from '../domain/gaps.ts';
import type {PresentedGap} from './gap-presentation.ts';
export function GapSummary({plan,presentation}:{plan:{gaps?:Gap[];missingInfo?:string[]};presentation?:PresentedGap[]}){
 const rows=presentation??planGaps(plan).map(gap=>({gap}));if(!rows.length)return null;
 const pending=rows.filter(row=>row.gap.status!=='resolved'),done=rows.filter(row=>row.gap.status==='resolved');
 const item=({gap:g,original,resolvedBy}:PresentedGap)=><li key={g.id}>{g.summary} · {g.status==='resolved'?'已完成':gapStatusLabels[g.status]}<p className="mw-muted">{g.resolution || '解除条件尚未明确，不能据此判定缺口已解决'}{g.blocks.length?`；影响阶段：${g.blocks.map(stage=>gapStageLabels[stage]).join('、')}`:'；尚未确定阻塞阶段'}{g.sources.length?`；来源：${g.sources.join('；')}`:''}</p>{original&&<p className="mw-muted">本阶段记录：{original.summary} · {gapStatusLabels[original.status]}。后续同版本检查已完成（任务 {resolvedBy?.slice(0,8)}）。</p>}</li>;
 return <section className="mw-gap-summary" aria-label="检查与待办">{gapKinds.map(kind=>{
  const group=pending.filter(row=>row.gap.kind===kind);if(!group.length)return null;
  return <div className="mw-callout" key={kind}><strong>{kind==='system_check'?'尚未完成的系统检查':gapLabels[kind]}</strong><ul>{group.map(item)}</ul></div>;
 })}{!!done.length&&<details><summary>已完成的检查与已解决事项 · {done.length}</summary><ul>{done.map(item)}</ul></details>}
 {pending.length>0&&<p className="mw-muted">系统检查由系统完成。资料补充和范围授权分别记录；未来阶段的缺口不要求现在全部填齐。</p>}</section>;
}
