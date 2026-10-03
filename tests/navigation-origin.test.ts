import assert from 'node:assert/strict';
import test from 'node:test';
import { captureOrigin, consumeOrigin, restoreOrigin, type NavigationOrigin } from '../src/client/navigation-origin.ts';
const inbox: NavigationOrigin = { repoId:'a', page:'inbox', search:'bug', filter:'priority', type:'issue', selected:['i1'], focused:'i1', scrollTop:120, focusId:'mw-item-i1' };

test('inbox A to B to evidence retains first origin and consumes it once', () => {
  const origin = captureOrigin(captureOrigin(captureOrigin(undefined, inbox), { ...inbox, focused:'i2' }), { ...inbox, page:'tasks' });
  const calls:string[]=[]; const restored = restoreOrigin(origin, 'a', { frame: cb => cb(), scrollTo: top => calls.push(`scroll:${top}`), focus: id => { calls.push(`focus:${id}`); return id === 'mw-item-i1'; } });
  assert.equal(restored?.focused, 'i1'); assert.deepEqual(calls, ['focus:mw-item-i1','scroll:120']); assert.equal(consumeOrigin(undefined,'a'), undefined);
});
test('reviews return, cross-repo invalidation, and deleted row fallback use the list container', () => {
  const review = { ...inbox, page:'reviews' as const, focusId:'mw-item-j1' }; const calls:string[]=[];
  assert.equal(consumeOrigin(review,'b'), undefined);
  restoreOrigin(review, 'a', { frame: cb => cb(), scrollTo: top => calls.push(`scroll:${top}`), focus: id => { calls.push(id); return id === 'mw-list-reviews'; } });
  assert.deepEqual(calls, ['mw-item-j1','mw-list-reviews','scroll:120']);
});
