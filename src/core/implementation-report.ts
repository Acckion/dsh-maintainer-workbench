import type { ExecutionRecord } from './types.ts';
/** A bounded index of original evidence, not a replacement execution log. */
export function implementationReportEvidence(records: readonly ExecutionRecord[], kind: string): string {
  const entries = records.slice(-12).map(record => ({ executionId: record.id, callId: record.callId, tool: record.tool,
    path: record.sourcePath, command: record.command?.slice(0, 600), exitCode: record.exitCode, isError: record.isError,
    output: record.command ? record.output.slice(-400) : record.isError ? record.output.slice(-200) : undefined }));
  let text = JSON.stringify(entries);
  while (text.length > 5000 && entries.length > 1) { entries.shift(); text = JSON.stringify(entries); }
  return JSON.stringify({ note: 'Bounded evidence index; omitted source bodies remain in original Session logs. Do not infer unexecuted checks.', records: JSON.parse(text) });
}
export const documentVerificationGuidance = `DOCUMENT VERIFICATION PHASE: perform the requested document checks now with native tools, no edits or installation. Actually run git diff --check. Inspect git diff -- README.md; check newly added relative Markdown links against real files and headings, including CONTRIBUTING.md and docs/install/index.md#from-source when present. Use targeted grep or bounded reads instead of full files. Execute a real file/link check command, print DOCUMENT_LINKS_VERIFIED only after the relevant new links resolve. Do not claim installation/runtime tests passed. Return brief factual status; the host requests the final report separately.`;
