import type { ExecutionRecord } from './types.ts';

function preservesPipelineExit(command: string): boolean {
  const capture = command.match(/\|[^;\n|]*(?:;|\n)\s*([A-Za-z_]\w*)=\$\{?PIPESTATUS\[0\]\}?/);
  if (!capture) return false;
  const name = capture[1];
  const rest = command.slice(capture.index! + capture[0].length);
  return new RegExp(`(?:^|[;\\n])\\s*exit\\s+["']?\\$\\{?${name}\\}?["']?\\s*$`).test(rest) &&
    !new RegExp(`(?:^|[;\\n])\\s*${name}=`).test(rest);
}

/** A shell wrapper's successful exit does not prove its piped check succeeded. */
export function executionOutcome(record: ExecutionRecord): 'passed' | 'failed' | 'not_run' {
  if (record.signal || record.exitCode === null) return 'not_run';
  if (record.isError || record.exitCode !== null && record.exitCode !== 0) return 'failed';
  const command = record.command ?? '';
  if (preservesPipelineExit(command)) return 'passed';
  // Only interpret explicit status lines when the submitted command prints the
  // first pipeline process's status. Arbitrary source/log text is not a status.
  if (/\$\{?PIPESTATUS\[0\]\}?/.test(command) || /\b(?:echo|printf)\b[^;\n]*\$\?/.test(command)) {
    if (/PIPESTATUS\[0\]/.test(command) && !/\|[^;\n|]*(?:;|\n)\s*(?:echo|printf)\b[^;\n]*PIPESTATUS\[0\]/.test(command)) return 'not_run';
    const labels=[...command.matchAll(/\b(?:echo|printf)\s+["']?([a-zA-Z_]\w*)\s*[:=]\s*\$\{?(?:\?|PIPESTATUS\[0\])\}?/g)].map(m=>m[1].toLowerCase());
    const codes = [...record.output.matchAll(/^\s*(?:([a-z_]\w*)\s*[:=]\s*(\d+)|\[exit\s+(\d+)\])\s*$/gim)]
      .filter(m=>m[3]!==undefined&&command.includes('[exit ')||labels.includes(m[1]?.toLowerCase()))
      .map(m => Number(m[2]??m[3]));
    if (codes.some(code => code !== 0)) return 'failed';
    if (!codes.length || record.truncated) return 'not_run';
    return 'passed';
  }
  const shell = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
  if (/[;\n]\s*(?:echo|printf)\b/.test(shell)) return 'not_run';
  if (/(?:^|[^|])\|(?!\|)/.test(shell) &&
    !/\bset\s+-[^;\n]*\bpipefail\b/.test(shell)) return 'not_run';
  return 'passed';
}

/** Accept a single check with a proven exit-preserving output wrapper. */
export function executionCoversCommand(record: ExecutionRecord, expected: string): boolean {
  if (record.command?.trim() === expected.trim()) return true;
  if (!record.command || executionOutcome(record) !== 'passed') return false;
  const shell = record.command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '');
  const pipes=(shell.match(/(?:^|[^|])\|(?!\|)/g) ?? []).length;
  if (pipes>1) return false;
  if(pipes===0&&!/;\s*(?:echo|printf)\b[^;\n]*\$\?[^;\n]*$/.test(record.command)&&record.command.split(/&&/).at(-1)?.trim()!==expected.trim())return false;
  return record.command.split(/[;\n]/).some(line =>
    line.split(/\|(?!\|)/)[0].split(/&&/).at(-1)?.replace(/\s+\d?>.*$/, '').trim() === expected.trim());
}
