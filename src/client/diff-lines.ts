/** Unified GitHub patch coordinates; metadata never advances either file. */
export function diffLines(patch: string) {
  let oldLine: number | undefined, newLine: number | undefined;
  return patch.split('\n').map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text, kind: 'hunk', oldLine: undefined, newLine: undefined }; }
    if (text.startsWith('\\') || oldLine === undefined || newLine === undefined) return { text, kind: '', oldLine: undefined, newLine: undefined };
    if (text.startsWith('+')) return { text, kind: 'add', oldLine: undefined, newLine: newLine++ };
    if (text.startsWith('-')) return { text, kind: 'del', oldLine: oldLine++, newLine: undefined };
    if (text.startsWith(' ')) return { text, kind: '', oldLine: oldLine++, newLine: newLine++ };
    return { text, kind: '', oldLine: undefined, newLine: undefined };
  });
}
