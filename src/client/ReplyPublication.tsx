import { useEffect, useRef, useState } from 'react';
import type { Job } from '../core/types.ts';
import { request } from './api.ts';
import { flushItemDraft, saveItemDraft, useItemDraft } from './item-draft.ts';
import { Modal } from './Primitives.tsx';
import { PublicationConfirm, publicationPreviewCurrent, type PublicationPreview } from './PublicationConfirm.tsx';

/** Seed editable prose from the accepted report, without inferring tests or a merge decision. */
export function replyFromReport(job: Job): string {
  if (job.result?.responseDraft?.trim()) return job.result.responseDraft;
  const summary = job.artifact?.summary ?? job.result?.summary;
  if (!summary?.trim()) return '';
  const coverage = job.artifact?.coverage;
  return [summary, coverage ? `审查范围与限制：${coverage}` : '', '以上为 AI 辅助分析，经维护者本地确认。'].filter(Boolean).join('\n\n');
}

export function publicationError(error: unknown): string {
  const message = error instanceof Error ? error.message : '请求未完成，请重新核对预览后重试';
  if (/\b403\b|Resource not accessible|权限不足/i.test(message))
    return `${message}\n请在 GitHub 连接设置中核对当前账号与评论权限；公开仓库可读取不代表当前凭据可发布评论。`;
  if (/\b401\b|Bad credentials/i.test(message))
    return `${message}\n请在 GitHub 连接设置中更新登录，再重新核对预览。`;
  return message;
}

/** Editing, read-only preview, and explicit publication are separate steps. */
export function ReplyPublication({ job, repository, close, published, direct = false }: {
  job: Job; repository: string; direct?: boolean; close: () => void; published: (urls: string[]) => Promise<void>;
}) {
  const { draft, ready, error: draftError } = useItemDraft(job.issueId);
  const initialized = useRef(false);
  const [body, setBody] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [preview, setPreview] = useState<PublicationPreview>();
  const [publishedUrls, setPublishedUrls] = useState<string[]>([]);
  useEffect(() => {
    if (ready && !initialized.current) {
      initialized.current = true;
      const initial = typeof draft.reply === 'string' ? draft.reply : replyFromReport(job);
      setBody(initial);
      if (direct && initial.trim()) void publishDirect(initial);
    }
  }, [ready, draft.reply, job, direct]);
  const edit = (value: string) => { setBody(value); setPreview(undefined); setError(''); };
  const previewReply = async () => {
    if (busy || !body.trim()) return;
    setBusy(true); setError(''); setPreview(undefined);
    try {
      await saveItemDraft(job.issueId, { reply: body });
      await flushItemDraft(job.issueId);
      setPreview(await request('/publish/preview', { id: job.id, action: 'comment' }));
    } catch (e) { setError(publicationError(e)); }
    finally { setBusy(false); }
  };
  const publishDirect = async (text: string) => {
    setBusy(true); setError('');
    try {
      await saveItemDraft(job.issueId, { reply: text });
      await flushItemDraft(job.issueId);
      const checked: PublicationPreview = await request('/publish/preview', { id: job.id, action: 'comment' });
      setPreview(checked);
      if (!publicationPreviewCurrent(checked, job)) throw new Error('回复版本或审批已变化，请重新核对后发布');
      const result = await request('/publish', { id: job.id, action: 'comment', previewStamp: checked.stamp });
      setPublishedUrls(result.urls ?? []);
      await published(result.urls ?? []);
    } catch (e) { setError(publicationError(e)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (busy || error || !publicationPreviewCurrent(preview, job)) return;
    setBusy(true); setError('');
    try {
      const result = await request('/publish', { id: job.id, action: 'comment', previewStamp: preview!.stamp });
      setPublishedUrls(result.urls ?? []);
      await published(result.urls ?? []);
    } catch (e) { setError(publicationError(e)); }
    finally { setBusy(false); }
  };
  return <Modal title="发布回复到 GitHub" busy={busy} close={close}>
    <div className="mw-modal">
      <button className="mw-modal-close" aria-label="关闭回复发布窗口" disabled={busy} onClick={close}>×</button>
      <h2>发布回复到 GitHub</h2>
      {direct && busy && <p role="status">正在核对并发布回复…</p>}
      <p>发布目标：{repository} · #{job.issueSnapshot.number}</p>
      {publishedUrls.length ? <section role="status">
        <h3>回复已发布</h3>
        {publishedUrls.map(url => <p key={url}><a href={url} target="_blank" rel="noreferrer">在 GitHub 查看已发布的回复</a></p>)}
        <button className="mw-button" onClick={close}>完成</button>
      </section> : <>
      <label className="mw-field">回复内容
        <textarea aria-label="回复内容" rows={9} disabled={!ready || busy || !!preview?.alreadyPublished?.length}
          value={body} onChange={e => edit(e.target.value)} placeholder="填写准备发布给贡献者的回复…" />
      </label>
      <p className="mw-muted">先编辑回复，再核对预览，最后确认发布。修改内容后需重新核对。</p>
      {!!draftError && <p role="alert" className="mw-callout amber">{draftError}</p>}
      {!body.trim() && ready && <p role="status">尚未填写回复。可以手动输入，或引用已确认的审查结论。</p>}
      <div className="mw-actions">
        <button className="mw-button" disabled={!ready || busy || !!preview?.alreadyPublished?.length} onClick={() => edit(replyFromReport(job))}>引用审查结论</button>
        <button className="mw-button" disabled={!ready || busy || !body.trim()} onClick={() => void previewReply()}>{busy ? '正在核对…' : preview ? '重新核对预览' : '保存并核对发布预览'}</button>
      </div>
      {!!error && !preview && <p role="alert" className="mw-callout amber" style={{ whiteSpace: 'pre-wrap' }}>{error}</p>}
      {!!preview && <>
        <h3>本次发布预览</h3>
        <div className="mw-publish-preview">{preview.responseDraft ?? body}</div>
        <PublicationConfirm preview={preview} job={job} busy={busy} error={error} confirm={() => void confirm()} />
      </>}
      </>}
    </div>
  </Modal>;
}
