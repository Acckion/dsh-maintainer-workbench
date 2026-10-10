# State-focused stage content

Integrated master `525260a`. Screenshots contain synthetic PR/Agent data from the
browser timeline fixture, not actual execution of the named GitHub PR.

Validation:

- `npm run check`: 356 tests passed, typecheck and build passed.
- Timeline browser fixture: 1440px/390px passed, including default progress,
  hidden cancel menu, one execution detail entry, visible input form and resume,
  historical read-only state, source cycles and preserved attempt selection.
- Maintenance browser fixture: 1440px/390px passed, including orchestration,
  input continuation, actual command log retrieval, guarded review and themes.
- Navigation browser fixture: desktop/mobile passed, including list restoration,
  dispatch/review races and non-overlapping slow polling. Updated selectors and
  polling observations for the latest master's separate Issues/PR navigation.
- Component tests cover queues, real permission/environment waits, failure,
  latest timestamp ordering, raw session setup evidence, historical and unrelated
  run guards, pending input, secondary cancel, and result arrival while browsing
  execution details. These tests do not claim live Harness permission execution.

Screenshots show running, pending input, execution details and a saved result.
