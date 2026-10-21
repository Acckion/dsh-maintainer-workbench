import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { delimiter } from 'node:path';

/** Preserve the resolved host shell's sandbox, approval and canonical result pipeline. */
export function runtimeShellTool(bash:ToolDefinition,binDirectory:string,inheritedPath=process.env.PATH):ToolDefinition{
  const path=[binDirectory,inheritedPath].filter(Boolean).join(delimiter);
  const quoted="'"+(bash.name==='pwsh'?path.replace(/'/g,"''"):path.replace(/'/g,"'\\''"))+"'";
  const prefix=bash.name==='pwsh'?`$env:PATH = ${quoted}`:`export PATH=${quoted}`;
  return {...bash,async execute(args,execution){
    const input=args as Record<string,unknown>;
    return bash.execute({...input,command:`${prefix}\n${input.command}`},execution);
  }};
}
export const runtimeBashTool=runtimeShellTool;
