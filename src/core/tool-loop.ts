import { createHash } from 'node:crypto';
function stable(value: unknown): string {
  if(Array.isArray(value))return JSON.stringify(value.map(stable));
  if(value&&typeof value==='object')return JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)]));
  return JSON.stringify(value)??'';
}
function argumentsOf(args:unknown):Record<string,unknown> {
  if(typeof args==='string'){try{return JSON.parse(args);}catch{return {opaque:args};}}
  return args&&typeof args==='object'?args as Record<string,unknown>:{};
}
function fingerprint(name:string,args:unknown):string {
  const a=argumentsOf(args),effective=name==='bash'?{command:a.command??a.cmd??args,cwd:a.cwd??a.workdir}:a;
  return createHash('sha256').update(name+':'+stable(effective)).digest('hex');
}
export function automaticToolLimit(kind:string,scope?:string[]):number {
  if(scope)return !scope.length?180:scope.length===1&&/\.[\w-]+$/.test(scope[0])?80:120;
  return ({docs:120,validate:80,review:160,investigate:140,ci:100,fix:180} as Record<string,number>)[kind]??160;
}
/** Separate bounded exploration from report submission; edits never renew the task allowance. */
export function toolLoopPolicy(documentTask=false,investigation=false,options:{limit?:number;kind?:string;scope?:string[]}={}) {
  const limit=options.limit&&Number.isInteger(options.limit)&&options.limit>=10&&options.limit<=1000?options.limit:automaticToolLimit(options.kind??(documentTask?'docs':investigation?'investigate':'fix'),options.scope);
  const seen=new Map<string,number>();let used=0,searches=0,reads=0,warned=false,reason:string|undefined;
  return {
    get reason(){return reason;},
    get state(){return {limit,used,searches,reason,phase:reason?'report' as const:'explore' as const};},
    guard(name:string,args:unknown):string|undefined {
      // The report tool passes two host guards; it must neither count nor be blocked here.
      if(name==='submit_stage_report')return;
      if(reason)return reason;
      if(!['read','grep','glob','bash','job_output','job_list','subagent','edit','write'].includes(name))return;
      const key=fingerprint(name,args),count=(seen.get(key)??0)+1;seen.set(key,count);
      if(used>=limit){reason=`查阅预算已达上限（${used}/${limit}）：停止新增工具调用，使用 submit_stage_report 整理已获得证据和未完成项。预算耗尽不代表阶段成功，maintenance.complete 必须为 false。`;return reason;}
      used++;
      if(name==='read')reads++;
      if(name==='glob'||name==='grep')searches++;
      if(searches>Math.min(40,Math.floor(limit*.3))&&searches>3*Math.max(reads,1)){reason='搜索无进展：目录匹配与搜索过多，停止变换模式继续遍历。请提交已有证据及无法确认的路径，未完成检查不能标为成功。';return reason;}
      if(count>=4){reason='重复工具调用阻塞：同一调用已请求4次；停止继续查阅，提交已有事实与未完成项，不得把阶段标为成功。';return reason;}
      // Varying a glob suffix is still search churn. Force a checkpoint before consuming the whole budget.
      if(!warned&&(used>=Math.floor(limit*.7)||searches>=Math.min(20,Math.floor(limit*.4)))){
        warned=true;return `查阅预算提醒：已使用 ${used}/${limit} 次，其中搜索 ${searches} 次。本次调用未执行。请先利用已有证据收敛结论；只补充影响结论的直接依赖，避免变换目录模式继续遍历，尽快提交报告。`;
      }
      if(count===3)return '重复调用提醒：相同参数已请求两次，本次不再执行；请利用已有结果，或说明缺失证据并改用定点读取。';
    },
    edited(name:string,failed:boolean){if(!failed&&['edit','write'].includes(name))seen.clear();},
  };
}
