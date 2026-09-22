import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import React from 'react';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { Context } from '@deepseek-ai/cordis';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { App } from '../client/App.tsx';
import css from '../client/styles.css';
export const name = 'maintainer-workbench-ui';
export const inject = ['slots', 'uiWorkspace'];
const panelId = 'maintainer-workbench' as MainPanelId;
export function apply(ctx: Context): void {
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; style.dataset.plugin = 'maintainer-workbench'; document.head.append(style); return () => style.remove(); });
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, () => <App openSession={id => ctx.uiWorkspace.openSession(id as SessionId)} />));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panelId, order: 5, label: () => '维护工作台' }, () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="5" r="2" /><circle cx="17" cy="7" r="2" /><circle cx="7" cy="19" r="2" /><path d="M7 7v10M17 9c0 5-10 3-10 8" /></svg>));
}
