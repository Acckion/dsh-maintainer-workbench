import React from 'react';
import type { Job } from '../core/types.ts';

export interface PublicationPreview { id: string; revision: string; updatedAt: string; stamp: string; alreadyPublished?: string[] }

export function publicationPreviewCurrent(preview: PublicationPreview | undefined, job: Job | undefined): boolean {
  return !!preview && !!job && job.id === preview.id && job.status === 'approved' && !!job.result
    && (job.artifactState !== 'stale' || !!preview.alreadyPublished?.length) && job.revision === preview.revision && job.updatedAt === preview.updatedAt;
}

/** A stale open preview must not keep an enabled confirmation button after polling. */
export function PublicationConfirm({ preview, job, busy, error, confirm }: { preview?: PublicationPreview; job?: Job; busy: boolean; error?: string; confirm: () => void }) {
  const valid = publicationPreviewCurrent(preview, job) && !error;
  return <>
    {!!preview?.alreadyPublished?.length && <p className="mw-callout">已找到上次发布的远端记录。确认只核对并保存回执，不重复发布。</p>}
    {!valid && <p className="mw-callout amber" role="alert">{error || '发布预览已失效：输入版本或审批已变化。请关闭预览，重新同步、分析并审核后再发布。'}</p>}
    <button type="button" className="mw-button primary" disabled={busy || !valid} onClick={() => { if (!busy && valid) confirm(); }}>{busy ? '正在核对…' : preview?.alreadyPublished?.length ? '核对已有发布记录' : '确认发布以上内容'}</button>
  </>;
}
