import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Filter, X} from 'lucide-react';
import type {Issue} from '../core/types.ts';
import {categoryOptions, defaultInboxFacets, facetCount, itemLabels, type InboxFacets} from './issue-filters.ts';
export function InboxFilter({value,onChange,facets=defaultInboxFacets,onFacetsChange,issues=[]}:{value:string;onChange:(value:string)=>void;facets?:InboxFacets;onFacetsChange?:(value:InboxFacets)=>void;issues?:Issue[]}) {
  const [open,setOpen]=useState(false),[labelSearch,setLabelSearch]=useState('');
  const root=useRef<HTMLDivElement>(null), trigger=useRef<HTMLButtonElement>(null);
  const popup=useRef<HTMLDivElement>(null);
  const update=(change:Partial<InboxFacets>)=>{onChange('all');onFacetsChange?.({...facets,...change});};
  const count=facetCount(facets)+Number(value!=='all');
  const labels=[...new Map([...issues.flatMap(itemLabels).map(label=>label.name),...facets.labels].map(name=>[name.toLowerCase(),name])).values()].sort((a,b)=>a.localeCompare(b));
  useLayoutEffect(()=>{
    const element=popup.current;
    if(!open || !element)return;
    const place=()=>{
      const rect=trigger.current!.getBoundingClientRect();
      const width=Math.min(310,window.innerWidth-32);
      element.style.left=`${Math.max(16,Math.min(rect.right-width,window.innerWidth-width-16))}px`;
      element.style.top=`${rect.bottom+6}px`;
      element.style.maxHeight=`${Math.max(150,Math.min(window.innerHeight*.7,window.innerHeight-rect.bottom-22))}px`;
    };
    // React 18 types do not expose popover; the native top layer avoids sidebar clipping.
    place();element.setAttribute('popover','manual');element.showPopover?.();
    window.addEventListener('resize',place);
    return ()=>window.removeEventListener('resize',place);
  },[open]);
  useEffect(()=>{
    if(!open)return;
    root.current?.querySelector<HTMLSelectElement>('select')?.focus();
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return ()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  return <div ref={root} className="mw-inbox-filter">
    <button ref={trigger} className={`mw-icon-button mw-filter-toggle ${count?'active':''}`} aria-label="展开筛选" aria-expanded={open} aria-haspopup="dialog" title={count?`${count} 项筛选条件`:'筛选类型、标签、优先级'} onClick={()=>setOpen(v=>!v)}><Filter size={16}/>{count>0&&<span className="mw-filter-count">{count}</span>}</button>
    {open&&<div ref={popup} role="dialog" aria-label="筛选问题" className="mw-filter-popover mw-facet-popover"><header><strong>筛选与排序</strong><button className="mw-icon-button" aria-label="关闭筛选" onClick={()=>{setOpen(false);trigger.current?.focus();}}><X size={15}/></button></header>
      <label>开关状态<select aria-label="筛选开关状态" value={value==='closed'?'closed':facets.state} onChange={e=>update({state:e.target.value as InboxFacets['state']})}><option value="open">开放中</option><option value="closed">已关闭 / 已合并</option><option value="all">全部状态</option></select></label>
      <label>类型<select aria-label="筛选类型" value={facets.category} onChange={e=>update({category:e.target.value})}><option value="all">全部类型</option>{categoryOptions.map(([key,name])=><option key={key} value={key}>{name}</option>)}<option value="unclassified">尚未分类</option></select></label>
      <label>优先级<select aria-label="筛选优先级" value={facets.priority} onChange={e=>update({priority:e.target.value})}><option value="all">全部优先级</option>{['P0','P1','P2','P3'].map(p=><option key={p} value={p}>{p}</option>)}<option value="unset">尚未评估</option></select></label>
      <label>分析状态<select aria-label="筛选分析状态" value={['untriaged','duplicates'].includes(value)?value:facets.analysis} onChange={e=>update({analysis:e.target.value as InboxFacets['analysis']})}><option value="all">全部分析状态</option><option value="untriaged">尚未分诊 / 预检</option><option value="triaged">已有有效分类</option><option value="stale">分类已过期</option><option value="duplicates">疑似重复 Issue</option></select></label>
      <fieldset><legend>标签 · GitHub 与本地建议</legend><input className="mw-label-search" aria-label="查找筛选标签" placeholder="查找标签…" value={labelSearch} onChange={e=>setLabelSearch(e.target.value)}/><div className="mw-label-options">{labels.filter(label=>label.toLowerCase().includes(labelSearch.toLowerCase())).map(label=><label key={label.toLowerCase()}><input type="checkbox" checked={facets.labels.some(item=>item.toLowerCase()===label.toLowerCase())} onChange={e=>update({labels:e.target.checked?[...facets.labels,label]:facets.labels.filter(item=>item.toLowerCase()!==label.toLowerCase())})}/><span>{label}</span></label>)}{labels.length===0&&<p>当前仓库尚无标签</p>}</div><select aria-label="标签匹配方式" value={facets.labelMode} onChange={e=>update({labelMode:e.target.value as 'any'|'all'})}><option value="all">同时包含所选标签</option><option value="any">包含任一所选标签</option></select></fieldset>
      <label>排序<select aria-label="列表排序" value={facets.sort} onChange={e=>update({sort:e.target.value as InboxFacets['sort']})}><option value="updated">最近更新</option><option value="priority">优先级从高到低</option><option value="number">编号从新到旧</option></select></label>
      <footer><button className="mw-text-button" onClick={()=>{onChange('all');onFacetsChange?.({...defaultInboxFacets,labels:[]});setLabelSearch('');}}>清除全部筛选</button><span>条件可组合，结果即时更新</span></footer>
    </div>}
  </div>;
}
