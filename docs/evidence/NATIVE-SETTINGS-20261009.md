# Native global settings integration · 0.3.9

## Implementation

- Register `settings.section` as “维护工作台” through the public Harness slot contract. Keep the native launcher and its existing sections intact.
- Native section and workbench shortcut use the same `GlobalSettings` controller and `SettingsView` form, with Automation, Execution, Connections and Workspaces categories. Repository policies and local bindings remain in Repository Settings.
- `GET /maintainer/api/settings/global` reads only settings and host capabilities, excluding Issues, jobs, repository contents and credentials. It retains the same host connection/origin guard.
- Save the existing SQLite settings with a SHA-256 configuration revision. Obsolete saves return `409 SETTINGS_CONFLICT` and preserve the draft. Explicit reload confirms draft discard. Failed saves retain input; switching categories retains draft values.
- Read model/provider/preset status from Harness. Native settings have no additional model key or endpoint fields. Tokens are write-only and remain on the established credentials path.
- SQLite row metadata and JSON property order do not count as an unsaved edit. This was found and corrected during actual native UI acceptance.

## Verification

- `npm run check`: TypeScript, 294 tests and full build passed before the native acceptance follow-up.
- After that follow-up: TypeScript, the 4 settings tests, client build and settings browser fixture passed again, including unchanged-save cleanliness.
- Final isolated staged snapshot (excluding concurrent dirty-workspace work): TypeScript, all 295 tests, complete build and settings browser fixture passed. A distribution package was built from this snapshot.
- `test:browser:settings`: real client slot registration in a fixture settings shell; save/reopen, tabs, conflicts, reload/cancel, failed-save recovery, inherited host model, empty token input and dialog width passed. Uses a local fixture API/store, no paid model or GitHub mutation.
- Maintenance browser regression passed at 1440px and 390px, including themes, dialogs, review/Diff, and workspace cleanup in a synthetic repository.
- User Mac: Harness App 0.2.0-rc.2, plugin 0.3.9 visibly loaded. Opened native Settings with Cmd+, and selected “维护工作台”; all four categories rendered. Saved unchanged configuration and observed “设置已保存” with no unsaved indicator. Closed/reopened settings, checked inherited model and existing task workspaces, then opened the workbench shortcut and confirmed the same values and plugin version.
- At native acceptance, installed `dist/plugin.js` and `dist/client.js` hashes matched the settings build. A concurrent task subsequently replaced the installed 0.3.9 artifacts with its dirty-workspace update; that installation was preserved rather than overwritten. This commit excludes that task's source and tests. Previous plugin, profile metadata and consistent SQLite backup retained locally. Existing automation switches and model selection were not changed.
- Native screenshots are in the ignored local verification directory, not published to GitHub. Browser fixture screenshots are disposable synthetic evidence.

## Boundary

The SDK does not expose a public service to open a specific native settings section from another panel. The workbench button therefore remains a shortcut to the shared form in the workbench, while the native section is directly available in Harness Settings. No private shell state, simulated keyboard event, or launcher override is used.

No paid model call, token replacement, real workspace cleanup, GitHub comment, or PR publication was performed for this milestone. The native model display verifies configuration inheritance, not model execution quality.
