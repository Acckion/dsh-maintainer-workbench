import { createHash } from 'node:crypto';
import type { MaintenanceInventory, RepositoryAsset, MaintenanceFindingInput } from '../domain/maintenance.ts';
import { inScope } from '../domain/maintenance.ts';
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function assetFor(path: string, oid: string): RepositoryAsset | undefined {
  if (/(^|\/)AGENTS(?:\.override)?\.md$/i.test(path)) return {path,oid,domain:'agents',role:'目录开发指引'};
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) return {path,oid,domain:'ci',role:'GitHub 工作流'};
  if (/(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Package\.swift|Makefile|CMakeLists\.txt|pom\.xml|.*lock.*)$/.test(path)) return {path,oid,domain:'config',role:'依赖或检查命令来源'};
  if (/\.(md|mdx|rst|adoc)$/i.test(path) || /(^|\/)docs?\//i.test(path) && /\.(txt|html)$/i.test(path)) {
    const role = /(^|\/)(changelog|changes|history)|(^|\/)(archive|historical)\//i.test(path) ? '版本记录或历史材料' : /(^|\/)readme[.]/i.test(path) ? '目录入口与使用说明' : /contribut/i.test(path) ? '贡献约定' : '说明文档';
    return {path,oid,domain:'docs',role};
  }
}
export function contextDependencies(files: Record<string,string>): string[] {
  return Object.keys(files).filter(p => ['agents','config','ci'].includes(assetFor(p,files[p])?.domain ?? '') || /(^|\/)(README|CONTRIBUTING)/i.test(p));
}
export function fingerprint(files: Record<string,string>, paths?: string[]): string {
  return digest((paths ?? Object.keys(files)).slice().sort().map(p => [p, files[p] ?? null]));
}
export function scopeFingerprint(inventory: MaintenanceInventory, scope: string[]): string {
  const context=contextDependencies(inventory.files).filter(p=>!scope.length||!p.includes('/')||p.startsWith('.github/workflows/')||scope.some(target=>target.startsWith(p.slice(0,p.lastIndexOf('/')+1))));
  return fingerprint(inventory.files, [...new Set([...Object.keys(inventory.files).filter(p => inScope(p,scope)),...context])]);
}
export function findingFingerprint(files: Record<string,string>, finding: Pick<MaintenanceFindingInput,'paths'|'dependencies'>): string {
  return fingerprint(files,[...new Set([...finding.paths,...finding.dependencies,...contextDependencies(files)])]);
}
