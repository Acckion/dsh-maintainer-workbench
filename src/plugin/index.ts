import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { resolve } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { lockDirectory } from '../core/lock.ts';
import { Credentials } from '../core/credentials.ts';
import { Store } from '../core/store.ts';
import { Workbench } from '../core/workbench.ts';
import { API, handler } from '../server/http.ts';
import { harnessRunner, hostStatus } from './native-runner.ts';
export const name = 'maintainer-workbench';
export const inject = ['webServer', 'connection', 'agents', 'agentPresets', 'permissionPresets', 'workspaceRegistry', 'agentDefaultModel', 'llm'];
interface Connection { requestRejection(request: { headers: import('node:http').IncomingMessage['headers'] }): 401 | 403 | undefined }
export async function apply(ctx: Context): Promise<void> {
  const dataDir = resolve(process.env.MAINTAINER_DATA_DIR ?? resolve(resolveDshHome(), 'maintainer'));
  const unlock = lockDirectory(dataDir);
  ctx.effect(() => unlock);
  const credentials = new Credentials(dataDir, 'github-only');
  await credentials.load();
  const workbench = new Workbench(new Store(resolve(dataDir, 'workbench.sqlite')), dataDir, harnessRunner(ctx), undefined, true, () => hostStatus(ctx));
  if (workbench.store.repos().length === 0) workbench.seed();
  const connection = Reflect.get(ctx, 'connection') as Connection;
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API, handler: handler(workbench, req => connection.requestRejection(req), credentials) }));
  ctx.effect(() => () => workbench.close());
}
