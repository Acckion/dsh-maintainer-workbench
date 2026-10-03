export type NavigationOrigin = { repoId: string; page: 'inbox' | 'reviews' | 'tasks'; search: string; filter: string; type: string; selected: string[]; focused?: string; scrollTop: number; focusId: string };
export type NavigationDom = { frame: (cb: () => void) => void; scrollTo: (top: number) => void; focus: (id: string) => boolean };

/** First list origin wins until consumed; detail-to-detail navigation must not replace it. */
export function captureOrigin(current: NavigationOrigin | undefined, next: NavigationOrigin) { return current ?? next; }
export function consumeOrigin(origin: NavigationOrigin | undefined, repoId: string) { return origin?.repoId === repoId ? origin : undefined; }
export function restoreOrigin(origin: NavigationOrigin | undefined, repoId: string, dom: NavigationDom) {
  const valid = consumeOrigin(origin, repoId);
  if (!valid) return undefined;
  dom.frame(() => { if (!dom.focus(valid.focusId)) dom.focus(`mw-list-${valid.page}`); dom.scrollTo(valid.scrollTop); });
  return valid;
}
export function focusDetail(dom: Pick<NavigationDom, 'frame' | 'focus'>) { dom.frame(() => { if (!dom.focus('mw-detail')) dom.focus('mw-main'); }); }
