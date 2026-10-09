import React,{useEffect} from 'react';
import {useItemDraft} from './item-draft.ts';
export function ItemInstructions({issueId,onChange}:{issueId:string;onChange:(value:string)=>void}) {
 const {draft,ready,error,update}=useItemDraft(issueId);
 useEffect(()=>{if(ready)onChange(draft.instructions??'');},[ready,draft.instructions]);
 return <details><summary>补充本次要求</summary><textarea aria-label="给 Agent 的补充要求" rows={3} disabled={!ready} value={draft.instructions??''} onChange={e=>update({instructions:e.target.value})}/>{error && <p role="alert">{error}</p>}</details>;
}
