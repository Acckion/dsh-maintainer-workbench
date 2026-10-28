import type {PRContext} from '../core/types.ts';
import {githubCheckNotices} from '../core/github-check-notices.ts';
export function GitHubCheckSummary({context}:{context:PRContext}){
 return <section className="mw-github-check-summary" aria-label="GitHub 规则与 CI 状态"><p className="mw-muted">本次任务保存的 GitHub 状态；最新结果请在“交付与跟踪”中核对。</p>{githubCheckNotices(context).map(notice=><section key={notice.id} className="mw-callout mw-gap-group"><strong>{notice.title}</strong><p>{notice.detail}</p>{notice.url&&<a href={notice.url} target="_blank" rel="noreferrer">打开 CI 运行详情</a>}</section>)}</section>;
}
