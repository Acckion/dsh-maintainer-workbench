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
      if (path === '/demo') workbench.seed();
      else if (path === '/sync') await workbench.sync(z.object({ fullName: z.string().min(3).max(200) }).parse(input).fullName);
      else if (path === '/prepare') await workbench.prepareRepository(z.object({ repoId: z.string() }).parse(input).repoId);
      else if (path === '/bind') { const p = z.object({ repoId: z.string(), localPath: z.string().min(1).max(2000) }).parse(input); await workbench.bindPath(p.repoId, p.localPath); }
      else if (path === '/jobs') { const p = z.object({ issueIds: z.array(z.string()), kind: z.enum(kinds) }).parse(input); send(res, 200, workbench.enqueue(p.issueIds, p.kind)); return; }
      else if (path === '/cancel') workbench.cancel(z.object({ id: z.string() }).parse(input).id);
      else if (path === '/retry') workbench.retry(z.object({ id: z.string() }).parse(input).id);
      else if (path === '/review') { const p = z.object({ id: z.string(), decision: z.enum(['approve', 'reject']), note: z.string().max(4000) }).parse(input); await workbench.review(p.id, p.decision, p.note); }
      else if (path === '/publish') { const p = z.object({ id: z.string(), action: z.enum(['comment', 'labels', 'pr']) }).parse(input); send(res, 200, { urls: await workbench.publish(p.id, p.action) }); return; }
      else if (path === '/credentials') { if (!credentials) throw new Error('当前运行环境不提供密钥配置'); await credentials.save(input); workbench.store.audit('credentials.updated', '更新本地连接配置，未记录密钥'); }
      else if (path === '/settings') workbench.updateSettings(input);
      else { send(res, 404, { error: '接口不存在' }); return; }
      send(res, 200, { ok: true });
    } catch (error) { send(res, 400, { error: error instanceof z.ZodError ? `输入格式错误：${error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ')}` : error instanceof Error ? error.message : '请求失败' }); }
  };
}
