import {useEffect,useState} from 'react';
import type {IssuePlan} from '../core/types.ts';
export interface ItemDraft {view?:string;reply?:string;instructions?:string;plan?:IssuePlan}
// Serialize writes per item: a late response cannot overwrite a newer edit.
const writes = new Map<string,Promise<void>>();
export function saveItemDraft(id:string,patch:ItemDraft):Promise<void> {
  const pending=(writes.get(id)??Promise.resolve()).catch(()=>{}).then(async()=>{
    const response=await fetch('/maintainer/api/item-draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,patch})});
    if(!response.ok) throw new Error('草稿保存失败，请重试');
  });
  writes.set(id,pending); return pending;
}
export function useItemDraft(id:string) {
  const [draft,setDraft]=useState<ItemDraft>({}),[ready,setReady]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let live=true;setReady(false);setDraft({});setError('');
    void (writes.get(id)??Promise.resolve()).catch(()=>{}).then(()=>fetch(`/maintainer/api/item-draft?id=${encodeURIComponent(id)}`)).then(async r=>{if(!r.ok)throw new Error('草稿读取失败');return r.json();}).then(value=>{if(live){setDraft(value);setReady(true);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};
  },[id]);
  const update=(patch:ItemDraft)=>{setDraft(value=>({...value,...patch}));void saveItemDraft(id,patch).then(()=>setError('')).catch(e=>setError(e.message));};
  return {draft,ready,error,update};
}

export async function flushItemDraft(id:string):Promise<void> {await writes.get(id);}
