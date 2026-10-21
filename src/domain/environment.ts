import { z } from 'zod';

export const environmentPolicySchema = z.object({
  mode: z.enum(['manual','automatic']).default('manual'),
  allowNetwork: z.boolean().default(false),
  allowScripts: z.boolean().default(false),
  scope: z.enum(['root','workspace']).default('root'),
  binDirectory: z.string().max(4000).default(''),
  timeoutMs: z.number().int().min(1000).max(600000).default(180000),
}).strict();
export type EnvironmentPolicy = z.infer<typeof environmentPolicySchema>;
export interface EnvironmentPreparation {
  status: 'checking'|'preparing'|'ready'|'blocked'|'failed';
  reason: string;
  updatedAt: string;
  key?: string;
  nodeVersion?: string;
  packageManager?: string;
  command?: string;
  logPath?: string;
}
