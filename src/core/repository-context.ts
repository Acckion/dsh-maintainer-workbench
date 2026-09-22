import type { RepositoryProfile } from './types.ts';
import { git } from './git.ts';
// A repository is recognized from its own tracked files, never from its name.
export function contextPaths(files: string[]): string[] {
  const patterns = [/^AGENTS(?:\.override)?\.md$/i, /^README(?:\.[a-z-]+)?\.md$/i, /^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Package\.swift|project\.yml|CMakeLists\.txt|Makefile|composer\.json|Gemfile|pubspec\.yaml|\.swiftlint\.yml)$/i, /^\.github\/workflows\/[^/]+\.ya?ml$/, /(?:^|\/)AGENTS(?:\.override)?\.md$/, /(?:^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Package\.swift)$/];
  return [...new Set(patterns.flatMap(p => files.filter(f => p.test(f)).sort()))].slice(0, 12);
}
export function repositoryProfile(revision: string, files: string[], sources: { path: string; content: string }[], warnings: string[] = []): RepositoryProfile {
  const languages = new Map<string, number>();
  const extensions: Record<string, string> = { ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', py: 'Python', swift: 'Swift', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', c: 'C', cpp: 'C++', cs: 'C#', rb: 'Ruby', php: 'PHP', dart: 'Dart' };
  for (const path of files) { const lang = extensions[path.split('.').at(-1)!]; if (lang) languages.set(lang, (languages.get(lang) ?? 0) + 1); }
  const roots = [...new Set(files.map(p => p.includes('/') ? `${p.split('/')[0]}/` : p))].slice(0, 70);
  const testPaths = files.filter(p => /(^|\/)(__tests__|tests?|specs?)(\/|$)|[._-](test|spec)\.[^/]+$/i.test(p)).slice(0, 60);
  const workflows = files.filter(p => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
  const manifests = files.filter(p => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Package\.swift|project\.yml|pom\.xml|CMakeLists\.txt|Makefile|composer\.json|Gemfile|pubspec\.yaml)$/.test(p)).slice(0, 60);
  const commands: { source: string; command: string }[] = [];
  // Advertise declared package scripts, but do not execute them or infer missing commands.
  for (const source of sources) if (/(^|\/)package\.json$/.test(source.path)) {
    try { const scripts = JSON.parse(source.content).scripts; if (scripts && typeof scripts === 'object') for (const [name, command] of Object.entries(scripts)) if (typeof command === 'string' && /test|lint|check|build|typecheck/.test(name)) commands.push({ source: `${source.path} scripts.${name}`, command: command.slice(0, 1000) }); } catch { /* Truncated/non-JSON manifests remain raw evidence. */ }
  }
  return { revision, scannedAt: new Date().toISOString(), languages: [...languages].sort((a,b) => b[1]-a[1]).map(([name]) => name), roots, testPaths, workflows, manifests, commands: commands.slice(0, 25), sources, warnings };
}
export async function localRepositoryProfile(path: string, revision: string): Promise<RepositoryProfile> {
  const files = (await git(path, ['ls-tree', '-rz', '--name-only', revision])).split('\0').filter(Boolean);
  const sources: { path: string; content: string }[] = []; const warnings: string[] = [];
  for (const file of contextPaths(files)) {
    try {
      // Read Git blobs at the pinned revision, never follow workspace symlinks.
      const mode = await git(path, ['ls-tree', revision, '--', file]);
      if (!/^100(644|755) blob /.test(mode)) { warnings.push(`Skipped non-regular file: ${file}`); continue; }
      const content = await git(path, ['show', `${revision}:${file}`]);
      sources.push({ path: file, content: content.slice(0, 6000) });
      if (content.length > 6000) warnings.push(`Excerpt truncated: ${file}`);
    } catch { warnings.push(`Could not read ${file}`); }
  }
  if (contextPaths(files).length === 12) warnings.push('At most 12 instruction/document/manifest excerpts; Agent must read relevant scoped files before edits.');
  return repositoryProfile(revision, files, sources, warnings);
}
