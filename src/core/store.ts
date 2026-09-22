import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Repo, Issue, Job, Audit, Settings } from './types.ts';

/** One writer per process. Each mutation is durable before the worker can start. */
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, jobId TEXT, action TEXT NOT NULL, detail TEXT NOT NULL);`);
  }
  all<T>(table: 'repos' | 'issues' | 'jobs' | 'settings'): T[] { return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(r => JSON.parse(String(r.data)) as T); }
  get<T>(table: 'repos' | 'issues' | 'jobs' | 'settings', id: string): T | undefined { const r = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id); return r ? JSON.parse(String(r.data)) as T : undefined; }
  put<T extends { id: string }>(table: 'repos' | 'issues' | 'jobs' | 'settings', item: T): void { this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(item.id, JSON.stringify(item)); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  audit(action: string, detail: string, jobId: string | null = null): void { this.db.prepare('INSERT INTO audit(at,jobId,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), jobId, action, detail); }
  audits(): Audit[] { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 250').all() as unknown as Audit[]; }
  repos(): Repo[] { return this.all('repos'); }
  issues(): Issue[] { return this.all('issues'); }
  jobs(): Job[] { return this.all('jobs'); }
  settings(): Settings { return { concurrency: 2, maxJobsPerBatch: 20, timeoutMs: 600000, provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 6000, agentPreset: 'inherit', permissionPreset: 'inherit', syncIntervalMinutes: 0, autoTriage: false, ...this.get<Settings>('settings', 'main') }; }
  close(): void { this.db.close(); }
}
