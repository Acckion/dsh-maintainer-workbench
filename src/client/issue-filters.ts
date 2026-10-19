import type { Issue } from '../core/types.ts';
export type InboxFacets = {
  state: 'open' | 'closed' | 'all'; category: string; priority: string;
  labels: string[]; labelMode: 'any' | 'all'; analysis: 'all' | 'untriaged' | 'triaged' | 'stale' | 'duplicates';
  sort: 'updated' | 'priority' | 'number';
};
export const defaultInboxFacets: InboxFacets = { state: 'open', category: 'all', priority: 'all', labels: [], labelMode: 'all', analysis: 'all', sort: 'updated' };
export const categoryOptions = [['bug','缺陷 Bug'],['feature','功能 Feature'],['docs','文档 Docs'],['question','提问 Question'],['maintenance','维护 Maintenance']] as const;
export const categoryLabel = (value: string) => categoryOptions.find(([key]) => key === value)?.[1] ?? value;
/** Only routing results determine classification. Review severity must never relabel a PR. */
export function itemClassification(issue: Issue) {
  if (issue.classification) return issue.classification.stale ? undefined : issue.classification;
  return issue.analysis;
}
const labelCategories: Record<string, string> = { bug:'bug', feature:'feature', enhancement:'feature', docs:'docs', documentation:'docs', question:'question', maintenance:'maintenance' };
export function itemCategory(issue: Issue): string | undefined {
  if (issue.plan?.category) return issue.plan.category;
  const remote = [...new Set(issue.labels.map(label=>labelCategories[label.trim().toLowerCase()]).filter(Boolean))];
  return remote.length === 1 ? remote[0] : itemClassification(issue)?.category;
}
export function itemPriority(issue: Issue): string | undefined {
  const remote = [...new Set(issue.labels.map(label=>/^(?:priority[ :/\-]*)?(P[0-3])$/i.exec(label.trim())?.[1]?.toUpperCase()).filter(Boolean))];
  // Conflicting explicit maintainer priorities need resolution, not an AI override.
  return remote.length > 1 ? undefined : remote[0] ?? itemClassification(issue)?.priority;
}
export function itemLabels(issue: Issue): { name: string; source: 'github' | 'suggested' }[] {
  const labels = new Map<string, { name: string; source: 'github' | 'suggested' }>();
  for (const name of issue.labels) labels.set(name.toLowerCase(), {name, source: 'github'});
  for (const name of itemClassification(issue)?.labels ?? []) if (!labels.has(name.toLowerCase())) labels.set(name.toLowerCase(), {name, source: 'suggested'});
  return [...labels.values()];
}
export function filterItems(issues: Issue[], facets: InboxFacets, type: string, search: string, legacy = 'all') {
  const state = legacy === 'closed' ? 'closed' : facets.state;
  const analysis = ['untriaged','duplicates'].includes(legacy) ? legacy : facets.analysis;
  const query = search.trim().toLocaleLowerCase();
  const result = issues.filter(issue => {
    if (issue.origin || (state !== 'all' && issue.state !== state) || (type !== 'all' && issue.type !== type)) return false;
    const classification = itemClassification(issue);
    const category = itemCategory(issue);
    const priority = itemPriority(issue);
    if (facets.category !== 'all' && (facets.category === 'unclassified' ? !!category : category !== facets.category)) return false;
    if (facets.priority !== 'all' && (facets.priority === 'unset' ? !!priority : priority !== facets.priority)) return false;
    if (legacy === 'priority' && !['P0','P1'].includes(priority ?? '')) return false;
    if (analysis === 'untriaged' && (classification || issue.classification?.stale)) return false;
    if (analysis === 'triaged' && !classification) return false;
    if (analysis === 'stale' && !issue.classification?.stale) return false;
    if (analysis === 'duplicates' && (!classification || !issue.analysis?.duplicateOf)) return false;
    const labels = itemLabels(issue).map(label => label.name.toLowerCase());
    const matches = facets.labels.map(label => labels.includes(label.toLowerCase()));
    if (matches.length && !(facets.labelMode === 'all' ? matches.every(Boolean) : matches.some(Boolean))) return false;
    return !query || `${issue.title} ${issue.number} ${issue.author} ${labels.join(' ')}`.toLocaleLowerCase().includes(query);
  });
  const priority = (issue: Issue) => { const value = itemPriority(issue); return value ? Number(value.slice(1)) : 9; };
  return result.sort((a,b) => (facets.sort === 'priority' ? priority(a)-priority(b) : facets.sort === 'number' ? b.number-a.number : 0) || (Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0) || b.number-a.number);
}
export function facetCount(facets: InboxFacets) {
  return Number(facets.state !== 'open') + Number(facets.category !== 'all') + Number(facets.priority !== 'all') + facets.labels.length + Number(facets.analysis !== 'all') + Number(facets.sort !== 'updated');
}
