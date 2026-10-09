# Stage action placement UX

Synthetic PR fixture, not live GitHub execution. Integrated master `2dad9e1`.

- Saved review displays its evidence without the next-stage investigation action.
- Selecting investigation exposes its action, preserving source job and expected version.
- Selected icon is a blue rounded square; no full-node background.
- Bottom next-step paragraph removed; live navigation controls retained.
- `npm run check`: 348 tests passed, typecheck and build passed.
- Timeline fixture: desktop 1440px/mobile 390px passed; checks action location,
  request payload, historical read-only behavior, running state and source cycles.
- Maintenance fixture: desktop/mobile passed, including theme and plan operations.

Screenshots are demonstration data captured from the browser fixture.

Header refinement: reduced panel top padding to 16px, aligned title/action/menu
centers, and removed the duplicate future-stage notice. Historical read-only
notice uses the neutral surface color. Browser fixture measures desktop header
alignment (within 1px) and compact spacing, and checks that future stages do not
render a historical notice. Typecheck and build passed after this refinement.
