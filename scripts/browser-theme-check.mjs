import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { join } from 'node:path';

/** Exercise actual theme cascade and controls on the fixture app, without model/network writes. */
export async function verifyTheme(page, dir, width) {
  const background = selector => page.locator(selector).first().evaluate(el => getComputedStyle(el).backgroundColor);
  const scheme = () => page.locator('.mw').evaluate(el => getComputedStyle(el).colorScheme);
  const dark = async selector => assert.ok((await background(selector)).match(/\d+/g).slice(0,3).every(n=>Number(n)<100), `${selector} has a dark surface`);
  const contrast = async selector => {
    const measure = () => page.locator(selector).first().evaluate(el => {
      const rgb = s => s.match(/[\d.]+/g).map(Number);
      let bg = [255,255,255]; const chain=[];
      for(let p=el;p;p=p.parentElement)chain.unshift(p);
      for(const p of chain){const c=rgb(getComputedStyle(p).backgroundColor);const a=c[3]??1;bg=bg.map((v,i)=>c[i]*a+v*(1-a));}
      const lum=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const a=lum(rgb(getComputedStyle(el).color)),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    });
    await expect.poll(measure,{message: `${selector} text contrast >= 4.5`}).toBeGreaterThanOrEqual(4.5);
  };
  await page.emulateMedia({colorScheme:'light'});
  assert.equal(await scheme(),'light');
  const lightBackground=await background('.mw');
  await page.emulateMedia({colorScheme:'dark'});
  assert.equal(await scheme(),'dark'); await dark('.mw-reader-embedded');
  await contrast('.mw-issue-title strong');await contrast('.mw-reader-header h2');
  await page.getByRole('button',{name:'展开筛选',exact:true}).click();
  await dark('.mw-filter-popover');await contrast('.mw-filter-popover button');
  await page.screenshot({path:join(dir,`theme-dark-filter-${width}.png`)});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'接入仓库',exact:true}).click();
  assert.ok(await page.getByRole('dialog',{name:'连接 GitHub 仓库'}).evaluate(el=>el.matches(':modal')));
  await dark('.mw-modal');await contrast('.mw-modal p');await contrast('.mw-modal h2');
  await page.screenshot({path:join(dir,`theme-dark-dialog-${width}.png`)});
  await page.emulateMedia({colorScheme:'light'});assert.equal(await scheme(),'light');
  assert.ok((await background('.mw-modal')).match(/\d+/g).slice(0,3).every(n=>Number(n)>200), 'open top-layer dialog switches to light live');
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  // A host explicitly in light mode wins over a dark OS. No plugin theme storage is involved.
  await page.locator('.mw').evaluate(el=>el.setAttribute('data-mw-host',''));
  await page.emulateMedia({colorScheme:'dark'});assert.equal(await scheme(),'light');
  assert.equal(await background('.mw'),lightBackground);
  await page.evaluate(()=>document.body.setAttribute('data-ds-dark-theme',''));
  assert.equal(await scheme(),'dark');await dark('.mw-reader-embedded');
  await page.emulateMedia({colorScheme:'light'});assert.equal(await scheme(),'dark');
  for(const name of ['Repository','Tasks','仓库设置','全局设置']){
    await page.getByRole('button',{name:new RegExp('^'+name+'(?:\\s|$)')}).click();await dark('.mw');
    await page.screenshot({path:join(dir,`theme-${name}-${width}.png`)});
  }
  await page.getByRole('button',{name:'Issues & PRs',exact:false}).click();
  await page.locator('[id="mw-item-fixture/queue#135"]').click();
  if(width>760)await page.getByRole('button',{name:'Diff',exact:true}).click();
  else await page.locator('select[aria-label="GitHub 原始内容"]').selectOption('files');
  await page.locator('.mw-reader-diff .add').waitFor();
  assert.notEqual(await background('.mw-reader-diff .add'),await background('.mw-reader-diff .del'));
  await contrast('.mw-reader-diff .add');await contrast('.mw-reader-diff .del');await contrast('.mw-reader-diff .hunk');
  await page.screenshot({path:join(dir,`theme-dark-diff-${width}.png`)});
  await page.evaluate(()=>document.body.removeAttribute('data-ds-dark-theme'));
  assert.equal(await scheme(),'light');
  await page.locator('.mw').evaluate(el=>el.removeAttribute('data-mw-host'));
  await page.emulateMedia({colorScheme:'light'});
  await page.locator('[id="mw-item-fixture/queue#128"]').click();
  console.log(`Theme switching, top-layer dialogs, panels and Diff passed at ${width}px`);
}
