import { z } from 'zod';
export const maintenanceDomains = ['docs', 'agents', 'ci'] as const;
export type MaintenanceDomain = typeof maintenanceDomains[number];
export const maintenanceFindingSchema = z.object({
  key: z.string().min(1).max(120),
  domain: z.enum(maintenanceDomains),
  kind: z.enum(['contradiction', 'missing', 'suggestion', 'uncertain']),
  title: z.string().min(1).max(500),
  paths: z.array(z.string().min(1).max(500)).min(1).max(30),
  dependencies: z.array(z.string().min(1).max(500)).max(80),
  impact: z.string().max(3000),
  evidence: z.array(z.object({ source: z.string().max(500), detail: z.string().max(4000) })).min(1).max(20),
  recommendation: z.string().min(1).max(4000),
});
export type MaintenanceFindingInput = z.infer<typeof maintenanceFindingSchema>;
export const documentResponsibilitySchema=z.object({path:z.string().min(1).max(500),role:z.string().min(1).max(1000),audience:z.string().max(1000),authority:z.enum(['current','historical','reference','unknown']),relatedPaths:z.array(z.string().min(1).max(500)).max(40)});
export type DocumentResponsibility=z.infer<typeof documentResponsibilitySchema> & {oid?:string;current?:boolean};
export interface MaintenancePR {issueId:string;number:number;headSha:string;baseSha:string}
export const maintenanceReportSchema = z.object({
  documents:z.array(documentResponsibilitySchema).max(100).optional(),
  findings: z.array(maintenanceFindingSchema).max(60),
  checkedPaths: z.array(z.string().min(1).max(500)).max(300),
  complete: z.boolean(),
});
export interface RepositoryAsset { path: string; domain: MaintenanceDomain | 'config'; oid: string; role: string }
export interface MaintenanceInventory {
  repoId: string; revision: string; fingerprint: string; scannedAt: string;
  files: Record<string, string>; assets: RepositoryAsset[]; complete: boolean;
  warnings: string[]; dirty: boolean; source: 'commit' | 'folder' | 'remote';
}
export type MaintenanceDecision = 'open' | 'deferred' | 'ignored' | 'resolved';
export interface MaintenanceFinding extends MaintenanceFindingInput {
  pr?: MaintenancePR;
  id: string; repoId: string; jobId: string; scanId: string; revision: string;
  fingerprint: string; decision: MaintenanceDecision; reason: string;
  createdAt: string; updatedAt: string; stale?: boolean;
  history: { at: string; action: string; reason: string; jobId?: string }[];
}
export interface MaintenanceScan {
  pr?:MaintenancePR; documents?:DocumentResponsibility[]; inventoryComplete?:boolean;
  id: string; repoId: string; jobId: string; revision: string; scope: string[];
  fingerprint: string; inventoryFiles: Record<string, string>; createdAt: string;
  state: 'pending' | 'completed' | 'partial' | 'failed' | 'cancelled';
  checkedPaths: string[]; dependencies?: string[]; complete: boolean; summary?: string;
}
export interface MaintenanceSnapshot {
  inventory?: MaintenanceInventory; findings: MaintenanceFinding[]; scans: MaintenanceScan[];
}
export const safeRepoPath = (path: string) => !!path && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some(s => s === '..' || s === '.' || !s) && !/[\x00-\x1f]/.test(path);
export const inScope = (path: string, scope: string[]) => !scope.length || scope.some(p => path === p || path.startsWith(p + '/'));
export const maintenancePlanInputSchema = z.object({
  prId:z.string().min(1).optional(),
  repoId:z.string().min(1), mode:z.enum(['docs','agents','ci']),
  paths:z.array(z.string().min(1).max(500)).min(1).max(60),
  findingIds:z.array(z.string().min(1).max(100)).max(60).default([]),
  goal:z.string().trim().min(1).max(2000),
  acceptanceCriteria:z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  instructions:z.string().max(4000).default(''),
  allowStructural:z.boolean().default(false),
});
export type MaintenancePlanInput=z.infer<typeof maintenancePlanInputSchema>;
export interface MaintenancePlan extends MaintenancePlanInput {
  pr?:MaintenancePR;
  id:string; revision:string; stamp:string; createdAt:string; issueId:string;
  evidence:{source:string;detail:string}[];
}
