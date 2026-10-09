export interface WorkspaceRecord {
  id: string;
  repositoryId: string;
  caseId?: string;
  ownerRunId: string;
  path: string;
  branch: string;
  checkoutSha: string;
  purpose: string;
  status:
    | "preparing"
    | "ready"
    | "in_use"
    | "retained"
    | "interrupted"
    | "cleaning"
    | "removed";
  updatedAt: string;
  cleanupStartedAt?: string;
}
export interface ChangeSnapshot {
  id: string;
  sourceRunId: string;
  caseId?: string;
  repositoryId: string;
  workItemId: string;
  checkoutSha: string;
  patchHash: string;
  resultTreeHash: string;
  patchPath: string;
  parentId?: string;
  createdAt: string;
}
