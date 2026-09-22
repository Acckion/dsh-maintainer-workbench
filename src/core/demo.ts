import type { Store } from './store.ts';
import type { Analysis, Issue, JobKind, Repo } from './types.ts';
export const demoRepo: Repo = { id: 'demo/atlas', fullName: 'demo/atlas', description: '用于体验维护流程的虚构 TypeScript 项目 · 所有执行结果均为模拟', defaultBranch: 'main', headSha: 'demo-9f42a7c', localPath: '', mode: 'demo', syncedAt: null, syncWarning: null };
const rows: [number, Issue['type'], string, string, string[], number][] = [
  [128, 'issue', '并发刷新令牌时，第二个请求偶发返回 401', '版本 2.4.0。两个请求同时收到 401 后分别刷新 token，第二个刷新会令第一个 token 失效。复现：开启两个标签页，同时点击刷新。预期只发起一次刷新请求。日志：TokenExpiredError at src/auth/refresh.ts:48。', ['bug', 'auth'], 8],
  [131, 'issue', '刷新页面后登录状态丢失', '浏览器 Firefox 130，v2.4.0；同时打开两个标签后刷新，经常被退出登录。日志显示 refresh token invalid。可能与 #128 有关。', ['bug'], 3],
  [132, 'issue', '增加离线缓存和网络恢复后自动同步', '希望网络中断时能继续编辑，恢复网络时同步。建议使用 IndexedDB，冲突时由用户选择保留的版本。', ['enhancement'], 12],
  [135, 'issue', '快速入门中的环境变量名称已过期', 'README 使用 ATLAS_API_URL，但 2.4 的代码改为 ATLAS_BASE_URL。按快速入门启动会连接到 localhost:3000。请更新 README 和 docs/deployment.md。', ['documentation', 'good first issue'], 2],
  [137, 'issue', '导出大数据集时内存持续上升', '导出 10 万行后内存达到 2GB，最后浏览器崩溃。Chrome 129，macOS 15。没有最小复现。预期：分块导出，UI 可显示进度。', ['bug', 'performance'], 5],
  [139, 'pr', 'fix(auth): 合并并发 token 刷新请求', '通过共享 Promise 合并并发刷新，修复 #128。新增 3 个单元测试。请重点检查 Promise 在请求失败之后的清理及跨账号切换。', ['needs review', 'auth'], 4],
  [141, 'issue', '这个功能怎么用？', '我想把数据放在自己服务器，不知道要配什么。', ['question'], 0],
  [142, 'pr', 'docs: 补充 Docker 部署和反向代理示例', '新增 Docker Compose 示例，更新环境变量说明和健康检查步骤。关联 #135。', ['documentation'], 1],
  [144, 'issue', '关闭编辑器后快捷键监听没有释放', 'v2.4.1。连续打开关闭编辑器 5 次，再按 Ctrl+S 会发出 5 次保存请求。src/editor/shortcuts.ts 的 addEventListener 没有对应 cleanup。', ['bug', 'good first issue'], 2],
  [146, 'issue', 'CI 在 Node 24 环境下无法通过', '升级 Node 后，测试套件报 ERR_REQUIRE_ESM。Node 22 正常。pnpm 10，Linux。失败步骤是 test:unit。', ['ci', 'maintenance'], 3],
];
export function seedDemo(store: Store): void {
  if (store.get('repos', demoRepo.id)) return;
  store.transaction(() => {
    store.put('repos', { ...demoRepo, syncedAt: new Date().toISOString() });
    rows.forEach(([number, type, title, body, labels, comments], i) => store.put('issues', { id: `${demoRepo.id}#${number}`, repoId: demoRepo.id, number, type, title, body, labels, comments, state: 'open', author: ['lin-dev', 'nova', 'river', 'kai'][i % 4], updatedAt: new Date(Date.now() - i * 3600000).toISOString(), url: '', ...(type === 'pr' ? { headSha: `demo-pr-${number}` } : {}) } as Issue));
    store.audit('demo.seed', '已载入 10 条虚构 Issue/PR；演示执行不调用模型，也不修改仓库。');
  });
}
export function demoAnalysis(issue: Issue, kind: JobKind): Analysis {
  const docs = issue.labels.includes('documentation');
  const question = issue.labels.includes('question');
  const category = docs ? 'docs' : question ? 'question' : issue.labels.includes('enhancement') ? 'feature' : issue.labels.includes('maintenance') ? 'maintenance' : 'bug';
  return {
    summary: `[演示] ${issue.number === 131 ? '与 #128 都指向并发刷新时的令牌竞争，建议维护者核对后合并处理。' : docs ? '报告中的文档与配置名称不一致，应同步检查快速入门和部署文档。' : question ? '问题缺少部署环境和已尝试的配置，应先收集必要信息。' : `${issue.title}。已整理复现线索、影响范围与下一步验证计划。`}${kind === 'review' ? ' 审查重点：失败路径、状态清理和回归测试覆盖。' : ''}`,
    category, priority: [128, 137].includes(issue.number) ? 'P1' : question ? 'P3' : 'P2', confidence: question ? 0.57 : 0.88,
    labels: [category, ...(issue.labels.includes('auth') ? ['auth'] : [])], missingInfo: question ? ['部署方式与操作系统', '已尝试的步骤和错误日志'] : issue.number === 137 ? ['最小复现数据', '内存性能剖析记录'] : [],
    duplicateOf: issue.number === 131 ? 128 : null, duplicateReason: issue.number === 131 ? '两份报告均涉及多标签页、并发刷新与 token invalid；尚需验证是否同一根因。' : '',
    evidence: [{ source: `Issue #${issue.number}`, detail: issue.body }, { source: '演示模式', detail: '此分析由确定性演示程序生成，未读取真实代码、未调用 AI、未运行测试。' }],
    nextSteps: ['核对报告中的版本和最小复现', '定位相关模块，增加修复前失败的回归测试', '检查修复后测试结果，再交给维护者审核'],
    responseDraft: question ? '感谢反馈！请补充部署方式、操作系统和目前的配置（请隐去密钥），以便进一步定位。' : `感谢提供 #${issue.number} 的线索。我们已整理调查计划，将优先核对复现步骤与回归测试。`,
    tests: [{ command: '尚未运行测试', status: 'not_run', output: '演示流程没有执行代码。' }],
  };
}
