import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { lockDirectory } from '../core/lock.ts';
import { Credentials } from '../core/credentials.ts';
import { Store } from '../core/store.ts';
import { Workbench } from '../core/workbench.ts';
import { API, handler, localRejection, send } from './http.ts';
const dataDir = resolve(process.env.MAINTAINER_DATA_DIR ?? '.data');
const unlock = lockDirectory(dataDir);
const credentials = new Credentials(dataDir);
await credentials.load();
const workbench = new Workbench(new Store(resolve(dataDir, 'workbench.sqlite')), dataDir);
const api = handler(workbench, localRejection, credentials);
const files: Record<string, [string, string]> = { '/': ['dist/preview.html', 'text/html'], '/app.js': ['dist/app.js', 'application/javascript'], '/app.css': ['dist/app.css', 'text/css'] };
const server = createServer(async (req, res) => {
  if (req.url?.startsWith(API)) { await api(req, res); return; }
  if (localRejection(req)) { send(res, 403, { error: 'Forbidden' }); return; }
  const file = files[new URL(req.url ?? '/', 'http://localhost').pathname];
  if (!file) { send(res, 404, { error: 'Not found' }); return; }
  try { const content = await readFile(resolve(file[0])); res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' }); res.end(content); }
  catch { send(res, 503, { error: '请先运行 npm run build' }); }
});
server.on('error', error => { console.error(`无法启动工作台：${error.message}`); process.exitCode = 1; void stop(); });
server.listen(Number(process.env.PORT ?? 4317), '127.0.0.1', () => console.log(`Maintainer Workbench: http://127.0.0.1:${(server.address() as { port: number }).port}`));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; server.close(); await workbench.close(); unlock(); }
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
