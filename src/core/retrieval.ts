import type { Issue } from './types.ts';
function tokens(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[a-z0-9_./-]{3,}|[\u4e00-\u9fff]{2,}/g) ?? []).filter(w => !['the', 'and', 'for', 'with', 'this', 'that', 'issue', 'error', 'github', 'https'].includes(w));
  return new Set(words.flatMap(word => /[\u4e00-\u9fff]/.test(word) ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]));
}
/** Lexical candidate retrieval only. The model must still justify any duplicate suggestion. */
export function retrieveRelated(issue: Issue, candidates: Issue[], limit = 20): Issue[] {
  const query = tokens(`${issue.title} ${issue.body.slice(0, 4000)}`);
  const documents = candidates.map(candidate => ({ candidate, terms: tokens(`${candidate.title} ${candidate.title} ${candidate.body.slice(0, 4000)}`) }));
  const frequencies = new Map<string, number>();
  for (const { terms } of documents) for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const mentions = new Set([...issue.body.matchAll(/#(\d+)/g)].map(m => Number(m[1])));
  return documents.map(({ candidate, terms }) => {
    let score = mentions.has(candidate.number) ? 20 : 0;
    for (const term of query) if (terms.has(term)) score += Math.log(1 + documents.length / (frequencies.get(term) ?? 1));
    score /= Math.sqrt(1 + terms.size / 100);
    score += candidate.labels.filter(label => issue.labels.includes(label) && !['bug', 'question', 'enhancement'].includes(label)).length * 1.5;
    return { candidate, score };
  }).sort((a, b) => b.score - a.score || b.candidate.updatedAt.localeCompare(a.candidate.updatedAt)).slice(0, limit).map(r => r.candidate);
}
