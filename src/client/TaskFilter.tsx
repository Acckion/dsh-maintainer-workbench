import {FilterPopover} from './FilterPopover.tsx';
import type {TaskFilter as TaskState} from './task-presentation.ts';

export const taskFilterLabels:Record<TaskState,string>={attention:'需要我处理',running:'正在运行',completed:'已完成',failed:'失败 / 已停止',all:'全部状态'};
export function TaskFilter({onReset,value,onChange,includeQuick,onIncludeQuickChange,counts}:{onReset?:()=>void;value:TaskState;onChange:(value:TaskState)=>void;includeQuick:boolean;onIncludeQuickChange:(value:boolean)=>void;counts:Record<TaskState,number>}) {
  const count=Number(value!=='all')+Number(includeQuick);
  return <FilterPopover count={count} title={count?`${count} 项筛选条件`:'筛选任务状态与显示范围'} label="筛选任务" heading="筛选任务">
    <label>任务状态<select aria-label="任务状态筛选" value={value} onChange={e=>onChange(e.target.value as TaskState)}>{Object.entries(taskFilterLabels).map(([key,label])=><option value={key} key={key}>{label} · {counts[key as TaskState]}</option>)}</select></label>
    <div className="mw-label-options"><label><input type="checkbox" checked={includeQuick} onChange={e=>onIncludeQuickChange(e.target.checked)}/>包含快速分诊与预检</label></div>
    <footer><button className="mw-text-button" onClick={()=>{if(onReset)onReset();else {onChange('all');onIncludeQuickChange(false);}}}>清除搜索与筛选</button></footer>
  </FilterPopover>;
}
