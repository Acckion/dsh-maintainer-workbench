import type {PRContext} from './types.ts';
import type {Gap} from '../domain/gaps.ts';
export interface GitHubCheckNotice {id:string;title:string;detail:string;url?:string; tone:'info'|'warning'}
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'?value as Record<string,unknown>:{};
/** Only host-read metadata supplies these labels; missing records are never a passing CI. */
export function githubCheckNotices(pr:PRContext):GitHubCheckNotice[]{
 const notices:GitHubCheckNotice[]=[];
 const rules=Array.isArray(pr.branchRules)?pr.branchRules:undefined;
 const knownNone=pr.branchProtectionRead==='not_configured'&&rules?.length===0;
 if(knownNone)notices.push({id:'protection',title:`${pr.baseRef} 未配置分支保护或分支规则`,detail:'这是当前仓库配置，不是检查失败；无需为了继续审查或修复而更换密钥或开启保护。',tone:'info'});
 else if(pr.branchProtectionRead==='configured'||pr.branchProtection!=null||rules?.length)notices.push({id:'protection',title:'已读取分支保护或分支规则',detail:'合并前仍需核对当前提交是否满足规则；这不代表 CI 已通过。',tone:'info'});
 else notices.push({id:'protection',title:pr.branchProtectionRead==='permission_denied'?'无权读取分支保护详情':'分支保护规则尚未确认',detail:pr.branchProtectionRead==='permission_denied'?'可请有权限的维护者核对，或为现有身份授权仓库 Administration 只读权限；无需提供所有者密钥。不阻塞本地审查和修复。':pr.branchProtectionRead==='not_configured'?'未配置传统分支保护，但分支规则集尚未读到；请刷新远端进度后核对。':'可能未配置保护、无读取权限或连接失败；不能仅凭 404 判断。请刷新远端进度，必要时由维护者在 GitHub 核对；等待 CI 不会解决规则读取问题。',tone:'warning'});
 const workflows=object(pr.workflowRuns).workflow_runs;
 const checks=object(pr.checks).check_runs;
 const runs=[...(Array.isArray(workflows)?workflows:[]),...(Array.isArray(checks)?checks:[])].map(object).filter(r=>!r.head_sha||r.head_sha===pr.headSha);
 const action=runs.find(r=>r.conclusion==='action_required');
 const url=action&&typeof action.html_url==='string'?action.html_url:undefined;
 if(action)notices.push({id:'ci',title:'CI 需要人工处理',detail:'GitHub 返回 action_required。请打开运行详情查看具体原因；若显示等待 Fork 工作流审批，由有写权限的维护者点击“Approve and run”。处理后刷新 CI 状态。无需把所有者密钥交给插件。',url,tone:'warning'});
 else if(runs.some(r=>['queued','in_progress','waiting','requested','pending'].includes(String(r.status))))notices.push({id:'ci',title:'CI 尚未完成',detail:'等待工作流执行完成后刷新；当前没有完整结果，不能判定 CI 已通过。不阻塞本地审查和修复。',tone:'info'});
 else if(runs.some(r=>['failure','timed_out','cancelled','stale'].includes(String(r.conclusion))))notices.push({id:'ci',title:'CI 未通过',detail:'请查看工作流失败步骤和日志，再决定修复或重跑；增加 Token 权限不能修复测试失败。',tone:'warning'});
 else if(runs.length)notices.push({id:'ci',title:'已读取 CI 执行结果',detail:'已读取的结果没有失败记录；仅代表当前读取范围，合并前仍需核对必需检查及提交版本。',tone:'info'});
 else notices.push({id:'ci',title:pr.checks==null&&pr.workflowRuns==null?'CI 状态未能读取':'尚无可用的 CI 检查结果',detail:'请刷新远端进度或打开 GitHub Actions 查看是否已触发、等待审批或未配置工作流；没有检查记录不等于 CI 通过，也不表示密钥无效。',tone:'warning'});
 return notices;
}
/** Replace only generic metadata coverage warnings, never actual local failures or required gates. */
export function genericGitHubCoverageGap(gap:Gap):boolean{
 return gap.id!=='host_required_ci'&&['external_wait','system_check','unclassified'].includes(gap.kind)&&
 !/(本地|依赖|运行环境|node_modules|command not found)/i.test(gap.summary)&&
 /分支保护|CI.*(?:未知|未确认|无检查|未读取)|合并门禁.*未确认/.test(gap.summary);
}
