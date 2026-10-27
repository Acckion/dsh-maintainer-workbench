import type {ExecutionRecord, Job} from '../core/types.ts';

export type Evidence = {source:string;detail:string};
export type EvidenceBlock = {kind:'text'|'code'|'diff';text:string;path?:string;language?:string};
export type CodeLine = {number?:number;text:string};

/** Link only an unambiguous citation in this job. Never guess by a session ID or array position. */
export function citedExecution(evidence:Evidence, job?:Job):ExecutionRecord|undefined {
  const source=evidence.source.trim().replace(/^Harness execution\s+/i,'');
  const records=(job?.executionRecords??[]).filter(record=>record.id===source||!!record.callId&&record.callId===source);
  return records.length===1?records[0]:undefined;
}

export function analysisEvidence(job:Job):Evidence[] {
  return job.result?.evidence.length?job.result.evidence:job.artifact?.evidence??[];
}

export function relativeEvidencePath(path:string,job?:Job):string {
  for(const root of [job?.worktree,job?.analysisPath]) {
    if(root&&path.startsWith(root.replace(/\/$/,'')+'/'))return path.slice(root.replace(/\/$/,'').length+1);
  }
  return path;
}

/** Read formatting envelopes as text, never HTML. Original bytes remain available in raw mode. */
export function evidenceBlocks(raw:string):EvidenceBlock[] {
  const text=raw.replace(/\r\n/g,'\n');
  const file=/<path>([^\n]*?)<\/path>\s*<type>file<\/type>\s*<content>([\s\S]*?)(?:<\/content>|$)/.exec(text);
  if(file) {
    const prefix=text.slice(0,file.index).trim(),tail=text.slice(file.index+file[0].length).trim();
    const blocks:EvidenceBlock[]=[];
    // Read tools often repeat the path immediately before their envelope.
    if(prefix&&prefix!==file[1]&&!file[1].endsWith('/'+prefix))blocks.push({kind:'text',text:prefix});
    blocks.push({kind:'code',path:file[1],text:file[2].replace(/^\n/,'').replace(/\n$/,'')});
    if(tail)blocks.push(...evidenceBlocks(tail));
    return blocks;
  }
  const diffStarts=[...text.matchAll(/^diff --git .+$/gm)].map(match=>match.index!);
  if(diffStarts.length) {
    const blocks:EvidenceBlock[]=[];
    if(diffStarts[0]>0)blocks.push({kind:'text',text:text.slice(0,diffStarts[0]).trimEnd()});
    for(let i=0;i<diffStarts.length;i++) {
      const patch=text.slice(diffStarts[i],diffStarts[i+1]??text.length).trimEnd();
      const path=/^\+\+\+ b\/(.+)$/m.exec(patch)?.[1]??/^--- a\/(.+)$/m.exec(patch)?.[1];
      blocks.push({kind:'diff',text:patch,path});
    }
    return blocks;
  }
  if(/^--- .+\n\+\+\+ .+\n@@ -\d/m.test(text))return [{kind:'diff',text}];
  const fence=/^```([\w+-]*)[^\n]*\n([\s\S]*?)^```\s*$/gm;
  const blocks:EvidenceBlock[]=[];let end=0;
  for(const match of text.matchAll(fence)) {
    if(match.index!>end)blocks.push({kind:'text',text:text.slice(end,match.index).trim()});
    const language=match[1];
    const code=match[2].trimEnd();
    blocks.push(...(language==='diff'||language==='patch'?(/^diff --git /m.test(code)?evidenceBlocks(code):[{kind:'diff' as const,text:code}]):[{kind:'code' as const,text:code,language}]));
    end=match.index!+match[0].length;
  }
  if(blocks.length) {
    if(end<text.length&&text.slice(end).trim())blocks.push({kind:'text',text:text.slice(end).trim()});
    return blocks;
  }
  return [{kind:numberedCode(text).sourceNumbers?'code':'text',text}];
}

/** Source coordinates are shown only for a strictly increasing, tool-numbered excerpt. */
export function numberedCode(text:string):{lines:CodeLine[];sourceNumbers:boolean;note?:string} {
  const raw=text.split('\n');
  const note=/^\((?:End of file|File has more lines|Showing lines)[^\n]*\)$/i.test(raw.at(-1)?.trim()??'')?raw.pop():undefined;
  const matches=raw.map(line=>/^\s*(\d+): ?(.*)$/.exec(line));
  const sourceNumbers=matches.length>0&&matches.every((match,index)=>!!match&&Number(match[1])>0&&(index===0||Number(match[1])>Number(matches[index-1]![1])));
  if(!sourceNumbers)return {lines:text.split('\n').map(text=>({text})),sourceNumbers:false};
  return {lines:matches.map(match=>({number:Number(match![1]),text:match![2]})),sourceNumbers:true,note};
}

export function evidenceTitle(evidence:Evidence,job?:Job):{title:string;kind:'file'|'diff'|'command'|'text'} {
  const record=citedExecution(evidence,job),blocks=evidenceBlocks(record?.output||evidence.detail);
  const sourceFile=/^(?!https?:)[^\n<>:]+\.[a-zA-Z0-9]{1,12}$/.test(evidence.source.trim())?evidence.source.trim():undefined;
  const path=blocks.find(block=>block.path)?.path??record?.sourcePath??sourceFile;
  const kind=blocks.some(block=>block.kind==='diff')?'diff':path?'file':record?.command?'command':'text';
  return {kind,title:path?relativeEvidencePath(path,job):record?.command?.split('\n')[0]??(/^Harness execution\s/i.test(evidence.source)?'工具输出':evidence.source)};
}
