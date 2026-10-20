import type { DatabaseSync } from 'node:sqlite';
import type { Job } from '../../core/types.ts';
import { digest, findingFingerprint, assetFor, scopeFingerprint, fingerprint } from '../../core/maintenance.ts';
import { maintenanceReportSchema, inScope, safeRepoPath, type MaintenanceFinding, type MaintenanceInventory, type MaintenanceScan, type MaintenanceSnapshot, type MaintenanceDecision, type MaintenancePlan } from '../../domain/maintenance.ts';
/** Durable evidence and decisions. Execution state always comes from jobs. */
export class MaintenanceRepository {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS maintenance_inventory (id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance_scans (id TEXT PRIMARY KEY,repoId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance_findings (id TEXT PRIMARY KEY,repoId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance_plans (id TEXT PRIMARY KEY,repoId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS maintenance_scans_repo ON maintenance_scans(repoId);
      CREATE INDEX IF NOT EXISTS maintenance_findings_repo ON maintenance_findings(repoId);`);
  }
  private rows<T>(table:string,repoId:string):T[] {return this.db.prepare(`SELECT data FROM ${table} WHERE repoId=? ORDER BY rowid DESC`).all(repoId).map(r=>JSON.parse(String(r.data)));}
  inventory(id:string):MaintenanceInventory|undefined {const r=this.db.prepare('SELECT data FROM maintenance_inventory WHERE id=?').get(id);return r?JSON.parse(String(r.data)):undefined;}
  saveInventory(value:MaintenanceInventory) {this.db.prepare('INSERT INTO maintenance_inventory(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.repoId,JSON.stringify(value));}
  saveScan(value:MaintenanceScan) {this.db.prepare('INSERT INTO maintenance_scans(id,repoId,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,value.repoId,JSON.stringify(value));}
  private saveFinding(value:MaintenanceFinding) {this.db.prepare('INSERT INTO maintenance_findings(id,repoId,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id,value.repoId,JSON.stringify(value));}
  snapshot(repoId:string):MaintenanceSnapshot {
    const inventory=this.inventory(repoId);
    return {inventory:inventory?{...inventory,files:Object.fromEntries(inventory.assets.map(a=>[a.path,a.oid]))}:undefined,scans:this.rows<MaintenanceScan>('maintenance_scans',repoId).map(({inventoryFiles,...s})=>({...s,current:s.pr?undefined:!!inventory&&scopeFingerprint(inventory,s.scope)===s.fingerprint&&(!s.dependencies?.length||fingerprint(inventory.files,s.dependencies)===fingerprint(inventoryFiles,s.dependencies)),inventoryFiles:{},documents:s.documents?.map(d=>({...d,current:!!inventory&&findingFingerprint(inventory.files,{paths:[d.path],dependencies:d.relatedPaths})===findingFingerprint(inventoryFiles,{paths:[d.path],dependencies:d.relatedPaths})}))})),findings:this.rows<MaintenanceFinding>('maintenance_findings',repoId).map(f=>({...f,stale:this.stale(f,inventory)}))};
  }
  private stale(f:MaintenanceFinding,inventory?:MaintenanceInventory):boolean {
    if(!f.pr)return !inventory || findingFingerprint(inventory.files,f)!==f.fingerprint;
    const row=this.db.prepare('SELECT data FROM issues WHERE id=?').get(f.pr.issueId);if(!row)return true;
    const issue=JSON.parse(String(row.data));return issue.headSha!==f.pr.headSha || issue.prBaseSha!==f.pr.baseSha || issue.state!=='open';
  }
  scanByJob(id:string):MaintenanceScan|undefined {const r=this.db.prepare("SELECT data FROM maintenance_scans WHERE id=?").get(id);return r?JSON.parse(String(r.data)):undefined;}
  decide(repoId:string,id:string,decision:Exclude<MaintenanceDecision,'resolved'>,reason:string,expectedFingerprint:string) {
    const finding=this.rows<MaintenanceFinding>('maintenance_findings',repoId).find(f=>f.id===id);
    if(!finding)throw Error('仓库问题不存在');
    if(finding.fingerprint!==expectedFingerprint)throw Error('问题依据已变化，请刷新后重试');
    if(decision!=='open'&&!reason.trim())throw Error('暂缓或忽略需要说明原因');
    const at=new Date().toISOString();this.saveFinding({...finding,decision,reason,updatedAt:at,history:[...finding.history,{at,action:decision,reason}].slice(-100)});
  }
  savePlan(value:MaintenancePlan) {this.db.prepare('INSERT INTO maintenance_plans(id,repoId,data) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').run(value.id,value.repoId,JSON.stringify(value));}
  plan(id:string):MaintenancePlan|undefined {const r=this.db.prepare('SELECT data FROM maintenance_plans WHERE id=?').get(id);return r?JSON.parse(String(r.data)):undefined;}
  observeJob(job:Job) {
    const scan=this.scanByJob(job.id);if(!scan || scan.state!=='pending'&&!(job.budgetStopped&&scan.state==='cancelled'))return;
    if(['failed','cancelled'].includes(job.status)&&!job.budgetStopped){this.saveScan({...scan,state:job.status as 'failed'|'cancelled',summary:job.error,complete:false});return;}
    if(job.status!=='completed'&&!job.budgetStopped)return;
    const artifact=job.artifact;
    const parsed=maintenanceReportSchema.safeParse(artifact?.stage==='investigate'?artifact.maintenance:undefined);
    if(!parsed.success){this.saveScan({...scan,state:'partial',complete:false,summary:artifact?.summary ?? '报告未提供结构化仓库检查结果；原始报告仍可查看。'});return;}
    const report=parsed.data;
    if([...report.checkedPaths,...report.findings.flatMap(f=>[...f.paths,...f.dependencies])].some(p=>!safeRepoPath(p))) {this.saveScan({...scan,state:'partial',complete:false,summary:'报告包含无效仓库路径，未用于更新问题状态。'});return;}
    if(scan.pr && (!job.prContext || job.prContext.headSha!==scan.pr.headSha || job.prContext.baseSha!==scan.pr.baseSha)){this.saveScan({...scan,state:'partial',complete:false,summary:'PR 检查版本不一致，保留报告，不更新问题。'});return;}
    const checked=report.checkedPaths.filter(p=>inScope(p,scan.scope) && p in scan.inventoryFiles);
    const found=new Set<string>();const prior=this.rows<MaintenanceFinding>('maintenance_findings',scan.repoId);
    const at=job.finishedAt??job.updatedAt;
    for(const input of report.findings) {
      if(!input.paths.some(p=>inScope(p,scan.scope)))continue;
      const id=digest([scan.repoId,...(scan.pr?[scan.pr.issueId]:[]),input.domain,input.key,[...input.paths].sort()]);found.add(id);
      const old=prior.find(f=>f.id===id);const fp=findingFingerprint(scan.inventoryFiles,input);
      const decision=old && old.fingerprint===fp && old.decision!=='resolved'?old.decision:'open';
      // A late result must never replace evidence from a later scan.
      if(old && (this.scanByJob(old.jobId)?.createdAt ?? old.createdAt)>scan.createdAt)continue;
      this.saveFinding({...input,pr:scan.pr,id,repoId:scan.repoId,jobId:job.id,scanId:scan.id,revision:scan.revision,fingerprint:fp,decision,reason:decision==='open'?'':old?.reason??'',createdAt:old?.createdAt??at,updatedAt:at,history:[...(old?.history??[]),{at,action:'observed',reason:input.title,jobId:job.id}].slice(-100)});
    }
    // Absence resolves only after a complete, unblocked recheck covering every affected path.
    const expected=Object.keys(scan.inventoryFiles).filter(p=>inScope(p,scan.scope)&&(scan.scope.includes(p)||!!assetFor(p,scan.inventoryFiles[p])&&assetFor(p,scan.inventoryFiles[p])!.domain!=='config'));
    const complete=!job.budgetStopped&&scan.inventoryComplete!==false && report.complete && (artifact?.stage==='investigate' && !artifact.blockers.length) && checked.length>0 && expected.every(p=>checked.includes(p));
    if(complete)for(const old of prior)if(old.pr?.issueId===scan.pr?.issueId && !found.has(old.id) && (this.scanByJob(old.jobId)?.createdAt ?? old.createdAt)<=scan.createdAt && old.decision!=='resolved' && old.paths.every(p=>checked.includes(p)))this.saveFinding({...old,decision:'resolved',reason:'完整复查未再发现此问题',updatedAt:at,jobId:job.id,scanId:scan.id,revision:scan.revision,fingerprint:findingFingerprint(scan.inventoryFiles,old),history:[...old.history,{at,action:'resolved',reason:'完整复查未再发现此问题',jobId:job.id}].slice(-100)});
    this.saveScan({...scan,state:complete?'completed':'partial',complete,checkedPaths:checked,dependencies:[...new Set([...report.checkedPaths,...report.findings.flatMap(f=>f.dependencies),...(report.documents??[]).flatMap(d=>d.relatedPaths)])],documents:report.documents?.filter(d=>safeRepoPath(d.path)&&d.relatedPaths.every(safeRepoPath)&&checked.includes(d.path)).map(d=>({...d,oid:scan.inventoryFiles[d.path]})),summary:artifact?.summary});
  }
}
