import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RepositoryDetail, RepositoryMarkdown } from '../src/client/RepositoryDetail.tsx';
import type { Issue } from '../src/core/types.ts';
import { diffLines } from '../src/client/diff-lines.ts';

test('GitHub Markdown supports tables and task lists, skips HTML and does not auto-load remote images', () => {
  const html = renderToStaticMarkup(React.createElement(RepositoryMarkdown, { text: '# Summary\n\n- [x] tested\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1\n```\n\n![tracking](https://example.com/image.png)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))' }));
  assert.match(html, /<h1>Summary<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /language-ts/);
  assert.doesNotMatch(html, /<img|<script|href="javascript:/);
});

test('PR and Issue have appropriate traditional browsing tabs and retain original body', () => {
  const issue: Issue = { id: 'other/public#1', repoId: 'other/public', number: 1, type: 'issue', title: 'Title', body: '## Original body', author: 'author', labels: ['bug'], state: 'open', comments: 0, updatedAt: '', url: '' };
  const props = { issue, repository: 'other/public', hasGitHub: true, agentPanel: 'Agent', close() {} };
  const html = renderToStaticMarkup(React.createElement(RepositoryDetail, props));
  assert.match(html, /Activity/); assert.match(html, /Original body/); assert.doesNotMatch(html, /Files changed/);
  const pr = renderToStaticMarkup(React.createElement(RepositoryDetail, { ...props, issue: { ...issue, type: 'pr' } }));
  for (const name of ['Summary', 'Activity', 'Files changed', 'Commits', 'Checks', 'Agent']) assert.ok(pr.includes(name));
});

test('diff coordinates preserve old/new locations across deletions, additions and separate hunks', () => {
  const rows = diffLines('@@ -10,2 +20,2 @@\n same\n-old\n+new\n\\ No newline at end of file\n@@ -50 +60 @@\n-next\n+replacement');
  assert.deepEqual(rows.map(row => [row.oldLine, row.newLine]), [[undefined, undefined], [10, 20], [11, undefined], [undefined, 21], [undefined, undefined], [undefined, undefined], [50, undefined], [undefined, 60]]);
});


test('embedded task details expose the complete Agent panel without a modal or background Summary fetch', () => {
  const issue: Issue = { id: 'r#2', repoId: 'r', number: 2, type: 'pr', title: 'Task', body: 'Original', author: 'author', labels: [], state: 'open', comments: 0, updatedAt: '', url: '' };
  const html = renderToStaticMarkup(React.createElement(RepositoryDetail, { issue, repository: 'r', hasGitHub: true, embedded: true, initialTab: 'agent', agentPanel: React.createElement('button', null, '审核产物'), close() {} }));
  assert.doesNotMatch(html, /<dialog/);
  assert.match(html, /<section class="mw-reader-embedded"/);
  assert.match(html, /审核产物/);
  assert.match(html, /aria-current="page"[^>]*>Agent/);
  assert.doesNotMatch(html, /正在读取|同步时的快照/);
});
