import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
export interface DocumentRange { path: string; start: number; end: number; reason: string }
/** Host planning hints only; the Agent must still execute its own checks. */
export async function documentValidationRanges(root: string, patch: string): Promise<DocumentRange[]> {
  const ranges: DocumentRange[] = []; let path = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) path = line.slice(6);
    const hunk = /^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && path) ranges.push({path,start:Math.max(1,Number(hunk[1])-5),end:Number(hunk[1])+Number(hunk[2]??1)+10,reason:'changed paragraph'});
    if (line.startsWith('+') && !line.startsWith('+++')) for (const link of line.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const [target, anchor] = link[1].split('#');
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
      const full = resolve(root,dirname(path),target), rel = relative(root,full);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      let text: string; try { const canonical = await realpath(full); const inside = relative(await realpath(root), canonical); if (inside.startsWith('..') || isAbsolute(inside) || (await stat(canonical)).size > 256000) continue; text = await readFile(canonical,'utf8'); } catch {continue;}
      const lines=text.split('\n');
      const index=anchor ? lines.findIndex(l=> /^#+\s/.test(l) && l.replace(/^#+\s*/,'').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s+/g,'-')===anchor) : 0;
      ranges.push({path:rel,start:Math.max(1,index+1-5),end:Math.max(20,index+20),reason:anchor?'link heading hint; verify anchor independently':'linked file'});
    }
  }
  return ranges;
}
export function documentInspectionPolicy(root: string, ranges: DocumentRange[]) {
 const seen = new Set<string>(); let attempts = 0;
 return {
  get exhausted() { return attempts >= 18; },
  guard(name: string, args: unknown): string | undefined {
   if (!['read','grep','glob'].includes(name)) return;
   attempts++;
   if (attempts >= 18) return '文档验证无进展：已达18次查阅上限，请保留已执行检查并报告未完成项。';
   if (name==='glob') return '文档验证范围：目标文件已由实际补丁确定，不需要遍历仓库。';
   const a=(args ?? {}) as Record<string,unknown>;
   const file=String(a.file_path ?? a.filePath ?? a.path ?? ''), rel=relative(root,resolve(root,file));
   if (name==='grep') {
    if (!ranges.some(r=>r.path===rel)) return '只在补丁目标或新增链接文件中做定点搜索；禁止全仓库扫描。';
    return;
   }
   const offset=Number(a.offset??1), limit=Number(a.limit);
   if (!Number.isInteger(offset) || !Number.isInteger(limit) || limit<1 || limit>20 || !ranges.some(r=>r.path===rel && offset>=r.start && offset+limit-1<=r.end))
    return `只读取相关段落，limit最多20行。该文件可用 read 参数：${JSON.stringify(ranges.filter(r=>r.path===rel).map(r=>({file_path:r.path,offset:r.start,limit:Math.min(20,r.end-r.start+1)})))}；其他内容用定点grep定位。`;
   const key=`${rel}:${offset}:${limit}`;
   if (seen.has(key)) return '该文档片段本次已读取，请利用现有证据继续链接核验，不重复读取。';
   seen.add(key);
  }
 };
}
