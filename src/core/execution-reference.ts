import type {ExecutionRecord} from './types.ts';
/** Only an exact current-session sequence is an alias, never a suffix/path/guess. */
export function executionReference(records:readonly ExecutionRecord[],id:string,sessionId?:string){
 const matches=records.filter(record=>record.id===id||record.callId===id||
   (!!sessionId&&/^[1-9]\d*$/.test(id)&&record.id===`${sessionId}:${id}`));
 return matches.length===1?matches[0]:undefined;
}
