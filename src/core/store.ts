import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Repo, Issue, Job, Audit, Settings, Analysis } from './types.ts';

/** One writer per process. Each mutation is durable before the worker can start. */
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS triage_cache (issueId TEXT NOT NULL, revision TEXT NOT NULL, jobId TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(issueId,revision));
      CREATE TABLE IF NOT EXISTS repos (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_issue_kind_revision ON jobs(json_extract(data,'$.issueId'),json_extract(data,'$.kind'),json_extract(data,'$.revision'));
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, jobId TEXT, action TEXT NOT NULL, detail TEXT NOT NULL);`);
    // Idempotent migration: retain prior completed classifications across upgrades/restarts.
    this.db.exec(`INSERT OR IGNORE INTO triage_cache(issueId,revision,jobId,data)
      SELECT json_extract(data,'$.issueId'),json_extract(data,'$.revision'),id,json_extract(data,'$.result') FROM jobs
      WHERE json_extract(data,'$.kind')='triage' AND json_extract(data,'$.status')='completed'
      AND json_type(data,'$.result')='object' ORDER BY rowid DESC;`);
    // Upgrade legacy installations before any worker can restore or execute tasks.
    this.transaction(() => {
      const demoRepos = "SELECT id FROM repos WHERE json_extract(data, '$.mode') = 'demo'";
      const demoJobs = `SELECT id FROM jobs WHERE json_extract(data, '$.repoId') IN (${demoRepos}) OR json_extract(data, '$.engine') = 'demo / simulated'`;
      this.db.exec(`DELETE FROM audit WHERE jobId IN (${demoJobs}) OR action = 'demo.seed';
        DELETE FROM jobs WHERE id IN (${demoJobs});
        DELETE FROM issues WHERE json_extract(data, '$.repoId') IN (${demoRepos});
        DELETE FROM repos WHERE id IN (${demoRepos});`);
    });
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
  settings(): Settings { return { syncLimit:1000, autoPreflight: false, triageMaxTokens: 1800, concurrency: 2, maxJobsPerBatch: 20, timeoutMs: 600000, provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 6000, agentPreset: 'inherit', permissionPreset: 'inherit', syncIntervalMinutes: 0, autoTriage: false, ...this.get<Settings>('settings', 'main') }; }
  triage(issueId: string, revision: string): { jobId: string; analysis: Analysis } | undefined {
    const row = this.db.prepare('SELECT jobId,data FROM triage_cache WHERE issueId=? AND revision=?').get(issueId,revision);
    return row ? {jobId:String(row.jobId),analysis:JSON.parse(String(row.data))} : undefined;
  }
  saveTriage(issueId: string, revision: string, jobId: string, analysis: Analysis): void {
    this.db.prepare('INSERT INTO triage_cache(issueId,revision,jobId,data) VALUES(?,?,?,?) ON CONFLICT(issueId,revision) DO UPDATE SET jobId=excluded.jobId,data=excluded.data').run(issueId,revision,jobId,JSON.stringify(analysis));
  }
  issueJobs(issueId: string, kind: string, revision: string): Job[] {
    return this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.issueId')=? AND json_extract(data,'$.kind')=? AND json_extract(data,'$.revision')=? ORDER BY rowid DESC").all(issueId,kind,revision).map(r=>JSON.parse(String(r.data)));
  }
  close(): void { this.db.close(); }
}
