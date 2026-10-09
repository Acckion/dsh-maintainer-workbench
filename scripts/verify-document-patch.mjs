import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
const [cwd,base]=process.argv.slice(2);
if (!cwd || !/^[a-f0-9]{40}$/.test(base??'')) throw Error('Expected worktree and pinned commit');
const root=realpathSync(cwd);
const run=args=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',maxBuffer:1024*1024});
let whitespace=true;try{run(['diff','--check',base]);}catch{whitespace=false;}
const patch=run(['diff',base,'--','*.md']);let file='',links=[];
const added=[];
for(const line of patch.split('\n')){
 if(line.startsWith('+++ b/'))file=line.slice(6);
 if(line.startsWith('+')&&!line.startsWith('+++')){
  added.push({file,text:line.slice(1)});
  for(const m of line.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g))if(!/^(?:[a-z]+:|\/)/i.test(m[1]))links.push({file,url:m[1]});
 }
}
let files=true,anchors=true;const details=[];
for(const link of links){
 const [target,anchor]=link.url.split('#');const path=target ? resolve(root,dirname(link.file),target) : resolve(root,link.file);
 let text='';try{const canonical=realpathSync(path),rel=relative(root,canonical);if(rel.startsWith('..')||isAbsolute(rel))throw Error('outside worktree');text=readFileSync(canonical,'utf8');}catch{files=false;anchors=false;details.push({...link,status:'missing_or_outside'});continue;}
 const headings=text.split('\n').filter(l=>/^#+\s/.test(l)).map(l=>l.replace(/^#+\s*/,'').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s+/g,'-'));
 const matched=!anchor||headings.includes(anchor);if(!matched)anchors=false;details.push({...link,status:matched?'resolved':'anchor_missing'});
}
// Detect exact repeated prose against the pinned original. Semantic repetition still needs human review.
const repeated=[];
for(const entry of added){if(entry.text.trim().length<20)continue;let original='';try{original=run(['show',`${base}:${entry.file}`]);}catch{}if(original.split('\n').some(l=>l.trim()===entry.text.trim()))repeated.push(entry);}
const checks={whitespace,link_files:files,link_anchors:anchors,exact_repetition:repeated.length===0};
console.log('DOCUMENT_CHECKS_JSON='+JSON.stringify({checks,links:details,repeated,limitations:['重复检查仅判断完全相同的文本，不证明语义无重复；未执行安装或运行测试。']}));
process.exitCode=Object.values(checks).every(Boolean)?0:1;
