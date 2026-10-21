import type { Job } from '../core/types.ts';
export function EnvironmentStatus({job}:{job?:Job}) {
  const state=job?.environmentPreparation;if(!job||!state)return null;
  const running=['running','queued'].includes(job.status);
  const label=running?({checking:'检查环境',preparing:'正在准备环境',ready:'环境已就绪',blocked:'环境需要处理',failed:'环境准备失败'} as const)[state.status]:['checking','preparing'].includes(state.status)?'环境准备已中断':({ready:'环境已就绪',blocked:'环境需要处理',failed:'环境准备失败'} as Record<string,string>)[state.status];
  return <section className="mw-callout mw-environment-status" aria-label="验证环境准备"><strong>{label}</strong><p>{state.reason}</p>
    {(state.nodeVersion||state.packageManager)&&<p className="mw-muted">{state.nodeVersion} · {state.packageManager}</p>}
    {state.logPath&&<a href={`/maintainer/api/environment/log?id=${encodeURIComponent(job.id)}`} target="_blank" rel="noreferrer">查看环境准备日志</a>}
    <small>环境就绪仅表示可开始检查；验收仍以本次测试记录为准。</small>
  </section>;
}
