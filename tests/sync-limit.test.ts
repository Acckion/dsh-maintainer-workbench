import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHub} from '../src/core/github.ts';
test('sync limit supports partial pages and unlimited pagination beyond old 1000 ceiling',async()=>{
 const rows=Array.from({length:1055},(_,n)=>({number:n+1,title:'Issue',body:null,user:null,labels:[],state:'open',comments:0,updated_at:'2026-10-08',html_url:`https://github.com/example/repo/issues/${n+1}`}));
 const gh=new GitHub();let pages=0;
 gh.request=async path=>{
  if(path.includes('/issues?')){pages++;const page=Number(new URL('https://api.github.com'+path).searchParams.get('page'));return rows.slice((page-1)*100,page*100);}
  if(path.includes('/commits/'))return {sha:'a'.repeat(40)};
  return {full_name:'example/repo',description:null,default_branch:'main'};
 };
 const limited=await gh.sync('example/repo',125);assert.equal(limited.issues.length,125);assert.equal(pages,2);assert.equal(limited.repo.syncLimited,true);assert.equal(limited.repo.syncWarning,null);
 pages=0;const all=await gh.sync('example/repo',0);assert.equal(all.issues.length,1055);assert.equal(pages,11);assert.equal(all.repo.syncLimited,false);
 await assert.rejects(()=>gh.sync('example/repo',-1));
});
