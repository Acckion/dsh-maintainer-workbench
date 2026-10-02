import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Credentials } from '../core/credentials.ts';
import { kinds, type Job } from '../core/types.ts';
import type { Workbench } from '../core/workbench.ts';
export const API = '/maintainer/api';
export function send(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('需要 application/json 请求');
  let text = ''; for await (const chunk of req) { text += chunk.toString(); if (Buffer.byteLength(text) > 128 * 1024) throw new Error('请求体过大'); }
  return JSON.parse(text);
}
export function localRejection(req: IncomingMessage): 403 | undefined {
  const host = req.headers.host ?? '';
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return 403;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return 403;
  if (req.headers['sec-fetch-site'] === 'cross-site') return 403;
}
export function handler(workbench: Workbench, reject: (req: IncomingMessage) => number | undefined, credentials?: Credentials) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rejection = reject(req); if (rejection) { send(res, rejection, { error: '请求来源或认证未通过' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.slice(API.length);
    try {
      if (req.method === 'GET' && path === '/github/connection') { send(res, 200, await workbench.githubConnection()); return; }
      if (req.method === 'GET' && path === '/state') { send(res, 200, workbench.snapshot()); return; }
      if (req.method === 'GET' && path.startsWith('/export/')) {
        const job = workbench.store.get<Job>('jobs', decodeURIComponent(path.slice('/export/'.length)));
        if (!job) { send(res, 404, { error: '任务不存在' }); return; }
        const patch = url.searchParams.get('format') === 'patch';
        res.writeHead(200, { 'Content-Type': patch ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="maintainer-${job.id}.${patch ? 'patch' : 'json'}"`, 'Cache-Control': 'no-store' });
        res.end(patch ? job.patch ?? '' : JSON.stringify(job, null, 2)); return;
      }
      if (req.method !== 'POST') { send(res, 404, { error: '接口不存在' }); return; }
      const input = await body(req);
      if (path === '/sync-all') {
        const names = workbench.store.repos().map(r => r.fullName);
        const results = [];
        for (let i = 0; i < names.length; i += 20) results.push(...(await workbench.syncMany(names.slice(i, i + 20))).results);
        send(res, 200, { results }); return;
      }
      if (path === '/sync-many') { send(res, 200, await workbench.syncMany(z.object({ names: z.array(z.string().max(250)).min(1).max(20) }).parse(input).names)); return; }
      if (path === '/sync') await workbench.sync(z.object({ fullName: z.string().min(3).max(200) }).parse(input).fullName);
      else if (path === '/prepare') await workbench.prepareRepository(z.object({ repoId: z.string() }).parse(input).repoId);
      else if (path === '/bind') { const p = z.object({ repoId: z.string(), localPath: z.string().min(1).max(2000) }).parse(input); await workbench.bindPath(p.repoId, p.localPath); }
      else if (path === '/classify') {
        const p = z.object({ issueIds:z.array(z.string()).min(1).max(workbench.store.settings().maxJobsPerBatch) }).parse(input);
        const created:string[] = [], reused:string[] = [], errors:{id:string;error:string}[] = [];
        for (const id of new Set(p.issueIds)) { try { const issue = workbench.store.get<import('../core/types.ts').Issue>('issues',id); if (!issue) throw new Error('事项不存在'); const r = workbench.enqueue([id],issue.type === 'pr' ? 'preflight' : 'triage'); created.push(...r.created);reused.push(...r.reused); } catch(e) { errors.push({id,error:e instanceof Error ? e.message : '派发失败'}); } }
        send(res,200,{created,reused,errors});return;
      }
      else if (path === '/jobs') { const p = z.object({ issueIds: z.array(z.string()), kind: z.enum(kinds), sourceJobId: z.string().optional(), instructions: z.string().max(8000).optional() }).parse(input); send(res, 200, workbench.enqueue(p.issueIds, p.kind, { sourceJobId: p.sourceJobId, instructions: p.instructions })); return; }
      else if (path === '/finding') { const p = z.object({ id: z.string(), findingId: z.string(), decision: z.enum(['accepted','needs_evidence','dismissed','resolved']) }).parse(input); workbench.finding(p.id, p.findingId, p.decision); }
      else if (path === '/decision') { const p = z.object({ issueId: z.string(), stage: z.string(), reason: z.string().max(4000) }).parse(input); workbench.decide(p.issueId, p.stage, p.reason); }
      else if (path === '/cancel') workbench.cancel(z.object({ id: z.string() }).parse(input).id);
      else if (path === '/retry') workbench.retry(z.object({ id: z.string() }).parse(input).id);
      else if (path === '/review') { const p = z.object({ id: z.string(), decision: z.enum(['approve', 'reject']), note: z.string().max(4000) }).parse(input); send(res, 200, { ok: true, ...await workbench.review(p.id, p.decision, p.note) }); return; }
      else if (path === '/publish') { const p = z.object({ id: z.string(), action: z.enum(['comment', 'labels', 'pr', 'update_pr', 'review']) }).parse(input); send(res, 200, { urls: await workbench.publish(p.id, p.action) }); return; }
      else if (path === '/credentials') { if (!credentials) throw new Error('当前运行环境不提供密钥配置'); await credentials.save(input); workbench.store.audit('credentials.updated', '更新本地连接配置，未记录密钥'); }
      else if (path === '/policy') { const p = z.object({ repoId:z.string(), policy:z.unknown() }).parse(input); workbench.updatePolicy(p.repoId,p.policy); }
      else if (path === '/settings') workbench.updateSettings(input);
      else { send(res, 404, { error: '接口不存在' }); return; }
      send(res, 200, { ok: true });
    } catch (error) { send(res, 400, { error: error instanceof z.ZodError ? `输入格式错误：${error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ')}` : error instanceof Error ? error.message : '请求失败' }); }
  };
}
