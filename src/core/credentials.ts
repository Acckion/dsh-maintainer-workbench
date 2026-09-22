import { chmod, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
const schema = z.object({ apiKey: z.string().max(4000).optional(), githubToken: z.string().max(4000).optional(), baseUrl: z.string().url().max(1000).optional() }).strict();
/** Secret values stay server-side in a mode-0600 file; GET never returns them. */
export class Credentials {
  constructor(private directory: string, private mode: 'all' | 'github-only' = 'all') {}
  private values: z.infer<typeof schema> = {};
  async load(): Promise<void> {
    let text: string;
    try { text = await readFile(join(this.directory, 'credentials.json'), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    this.values = schema.parse(JSON.parse(text));
    this.apply(false);
  }
  async save(input: unknown): Promise<void> {
    const parsed = schema.parse(input);
    if (this.mode === 'github-only' && (parsed.apiKey !== undefined || parsed.baseUrl !== undefined)) throw new Error('原生模型由 Harness 统一管理，请在宿主设置中配置');
    if (parsed.baseUrl) {
      const url = new URL(parsed.baseUrl);
      if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('模型地址不能包含凭据、查询参数或片段');
      if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远程模型端点必须使用 HTTPS');
    }
    this.values = { ...this.values, ...parsed };
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, 'credentials.json.tmp');
    await writeFile(temporary, JSON.stringify(this.values), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, join(this.directory, 'credentials.json'));
    this.apply(true);
  }
  private apply(overwrite: boolean) {
    for (const [field, env] of [['apiKey', 'MAINTAINER_API_KEY'], ['githubToken', 'GITHUB_TOKEN'], ['baseUrl', 'MAINTAINER_BASE_URL']] as const) if ((this.mode === 'all' || field === 'githubToken') && this.values[field] !== undefined && (overwrite || !process.env[env])) process.env[env] = this.values[field];
    if (this.mode === 'all' && this.values.apiKey && !process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = this.values.apiKey;
  }
}
