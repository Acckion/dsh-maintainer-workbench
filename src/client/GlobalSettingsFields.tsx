import type { ReactNode } from "react";
import type { Settings } from "../core/types.ts";

export function Row({label, description, children}: {label:string;description?:string;children:ReactNode}) {
  return <label className="mw-preference-row"><span className="mw-preference-copy"><span>{label}</span>
    {description && <small>{description}</small>}</span><span className="mw-preference-control">{children}</span></label>;
}
export function Toggle({label, description, value, change}: {label:string;description:string;value:boolean;change:(v:boolean)=>void}) {
  return <Row label={label} description={description}><span className="mw-preference-switch">
    <input role="switch" type="checkbox" aria-label={label} checked={value} onChange={e=>change(e.target.checked)}/><span aria-hidden="true"/>
  </span></Row>;
}
export function GlobalSettingsFields({settings,update,panel,native,hostPreset}: {
  settings:Settings;update:(s:Settings)=>void;panel:string;native:boolean;hostPreset?:string;
}) {
  const number = (key: keyof Settings, label:string, min:number, max:number, description?:string, factor=1) => <Row label={label} description={description}>
    <input aria-label={label} type="number" min={min} max={max} value={(settings[key] as number)/factor}
      onChange={e=>update({...settings,[key]:+e.target.value*factor})}/></Row>;
  const text = (key: keyof Settings, label:string, description?:string) => <Row label={label} description={description}>
    <input aria-label={label} value={settings[key] as string} required onChange={e=>update({...settings,[key]:e.target.value})}/></Row>;
  return <>
    {panel !== "automation" && <>
      {!native && <>{text('provider','模型提供方')}{text('model','模型名称')}</>}
      {number('concurrency','并发任务',1,4,'同时运行的任务数量')}
      {number('maxJobsPerBatch','每批任务上限',1,50,'单次批量派发的任务数量')}
    </>}
    {panel !== "execution" && <>
      {number('syncLimit','同步记录上限（0 表示无上限）',0,1000000,'按最近更新顺序同步 Issue 与 PR；0 表示读取全部')}
      {number('syncIntervalMinutes','定时同步（分钟，0 表示关闭）',0,1440,'后台同步的间隔；0 表示仅手动同步')}
      <Toggle label="自动分诊新增或已更新的 Issue" description="同步后自动分类与建议下一步；未变化的版本复用本机结果"
        value={settings.autoTriage} change={autoTriage=>update({...settings,autoTriage})}/>
      <Toggle label="自动快速预检新增或已更新的 PR" description="同步后自动分析变更范围与审查重点；使用所选模型，不自动修改或发布"
        value={settings.autoPreflight??false} change={autoPreflight=>update({...settings,autoPreflight})}/>
    </>}
    {panel !== "automation" && <details className="mw-preference-details"><summary>高级执行选项</summary>
      {number('timeoutMs','超时时间（秒）',1,1800,'超过此时间的任务停止并保留记录',1000)}
      {number('triageMaxTokens','分诊 / PR 预检输出 Token 上限',500,8000)}
      <p className="mw-muted">分诊与预检实际额度取此项和仓库／全局输出上限的较小值；模型推理与计划草稿均需预算。默认 6000。</p>
      {number('maxTokens','每次请求输出 Token 上限',500,32000,'单次输出上限不等于任务总费用上限')}
      {text('agentPreset','Harness Agent preset',`inherit 跟随宿主默认${hostPreset?`（${hostPreset}）`:''}，复用工具与 Skills`)}
      {text('permissionPreset','修复任务权限 preset','inherit 跟随宿主默认；调查与审查保持只读')}
    </details>}
  </>;
}
