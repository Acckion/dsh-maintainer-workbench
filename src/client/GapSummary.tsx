import {gapKinds,gapLabels,gapStatusLabels,gapStageLabels,planGaps,type Gap} from '../domain/gaps.ts';
export function GapSummary({plan}:{plan:{gaps?:Gap[];missingInfo?:string[]}}){
 const gaps=planGaps(plan);if(!gaps.length)return null;
 return <section className="mw-gap-summary" aria-label="缺口与责任">{gapKinds.map(kind=>{
  const rows=gaps.filter(g=>g.kind===kind);if(!rows.length)return null;
  return <div className="mw-callout" key={kind}><strong>{gapLabels[kind]}</strong><ul>{rows.map(g=><li key={g.id}>{g.summary} · {gapStatusLabels[g.status]}<p className="mw-muted">{g.resolution || '解除条件尚未明确，不能据此判定缺口已解决'}{g.blocks.length?`；影响阶段：${g.blocks.map(stage=>gapStageLabels[stage]).join('、')}`:'；尚未确定阻塞阶段'}{g.sources.length?`；来源：${g.sources.join('；')}`:''}</p></li>)}</ul></div>;
 })}<p className="mw-muted">系统检查由系统完成。资料补充和范围授权分别记录；未来阶段的缺口不要求现在全部填齐。</p></section>;
}
