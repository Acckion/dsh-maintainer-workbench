import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { delimiter } from 'node:path';

/** Preserve the host bash tool's sandbox, approval and canonical result pipeline. */
export function runtimeBashTool(bash:ToolDefinition,binDirectory:string,inheritedPath=process.env.PATH):ToolDefinition{
  const path=[binDirectory,inheritedPath].filter(Boolean).join(delimiter);
  const quoted="'"+path.replace(/'/g,"'\\''")+"'";
  return {...bash,async execute(args,execution){
    const input=args as Record<string,unknown>;
    return bash.execute({...input,command:`export PATH=${quoted}\n${input.command}`},execution);
  }};
}
