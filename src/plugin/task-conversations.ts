import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-session-title';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { conversationCategories, repositoryConversationTitle, taskConversationCategory, taskConversationRecord } from '../core/conversations.ts';
import type { Job, Repo } from '../core/types.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'maintainer-record': { kind: 'maintainer-record'; jobId: string; fingerprint: string } & ContextFormed;
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function categorySessionId(repoId: string, category: string): SessionId {
  return `maintainer-category-${digest(repoId).slice(0, 24)}-${category}` as SessionId;
}

/** One repository workspace owns category sessions. Execution logs retain their real worktree cwd. */
export async function recordTaskConversations(ctx: Context, jobs: Job[], repos: Repo[], dataDir: string): Promise<void> {
  const groups = new Map<string, { repo: Repo; jobs: Job[] }>();
  for (const job of jobs) {
    if (['queued', 'running', 'waiting_environment'].includes(job.status) || job.formatOnly) continue;
    const repo = repos.find(repo => repo.id === job.repoId);
    if (!repo) continue;
    const id = categorySessionId(repo.id, taskConversationCategory(job));
    const group = groups.get(id) ?? { repo, jobs: [] };
    group.jobs.push(job);
    groups.set(id, group);
  }
  for (const [key, group] of groups) {
    const id = key as SessionId;
    const recorded = new Set<string>();
    const stored = await ctx.sessionPersistence.stat(id);
    if (stored) {
      const reader = await ctx.sessionPersistence.open(id, 'read');
      try {
        for (const event of (await reader.read()).events) {
          if (event.type === 'user/message' && event.data.source.kind === 'maintainer-record')
            recorded.add(`${event.data.source.jobId}:${event.data.source.fingerprint}`);
        }
      } finally { await reader.close(); }
    }
    const pending = group.jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(job => ({ job, text: taskConversationRecord(job) }))
      .map(item => ({ ...item, fingerprint: digest(item.text) }))
      .filter(item => !recorded.has(`${item.job.id}:${item.fingerprint}`));
    if (!pending.length) continue;
    const path = stored?.header.cwd ?? (group.repo.localPath || join(dataDir, 'conversations', digest(group.repo.id).slice(0, 24)));
    if (!group.repo.localPath && !stored) await mkdir(path!, { recursive: true });
    if (!path) throw new Error('仓库类别会话缺少主区目录');
    const workspace = await ctx.workspaceRegistry.create(path, repositoryConversationTitle(group.repo));
    if (workspace.title !== repositoryConversationTitle(group.repo) && workspace.sessionIds.every(id => String(id).startsWith('maintainer-')))
      await workspace.setTitle(repositoryConversationTitle(group.repo));
    // A category log is a recall surface. It never dispatches a model turn or inherits execution tools.
    const setup = async (agentCtx: Context) => { agentCtx.tools.restrict({ allow: [] }); };
    const handle = stored
      ? await ctx.agents.resume({ resumeSessionId: id, setup })
      : await ctx.agents.create({ sessionId: id, meta: { cwd: workspace.path }, setup });
    try {
      const category = taskConversationCategory(group.jobs[0]);
      ctx.get('sessionTitle')?.rename(handle.agent.session, conversationCategories[category]);
      for (const item of pending) {
        handle.agent.session.append('user/message', createUserMessage({
          source: { kind: 'maintainer-record', form: 'recall', jobId: item.job.id, fingerprint: item.fingerprint },
          content: [{ type: 'text', text: item.text }],
        }), { surfaceOp: 'append' });
      }
      // Host and client Context declarations share this key; use the host service contract here.
      await (ctx.get('sessions') as unknown as SessionStore).flush(handle.agent.session);
      await workspace.attachSession(id);
    } finally { await handle.dispose(); }
  }
}
