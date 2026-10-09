import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ProcessingCase,
  ProcessingEvent,
} from "../../domain/processing.ts";
import { transition } from "../../workflow/engine.ts";

/** One explicit upgrade per case, retaining the old event history and all run identities. */
export function upgradeWorkflow(db: DatabaseSync): void {
  db.exec("SAVEPOINT workflow_upgrade");
  try {
    for (const row of db
      .prepare(
        "SELECT data FROM processing_cases WHERE json_extract(data,'$.workflowDefinitionVersion')='maintainer/1'",
      )
      .all()) {
      const state = JSON.parse(String(row.data)) as ProcessingCase,
        now = new Date().toISOString();
      const event: ProcessingEvent = {
        id: randomUUID(),
        caseId: state.id,
        workItemId: state.workItemId,
        source: "system",
        deduplicationKey: `${state.id}:upgrade:maintainer/2`,
        occurredAt: now,
        receivedAt: now,
        payload: {
          type: "workflow.upgraded",
          from: "maintainer/1",
          to: "maintainer/2",
        },
      };
      const next = transition(state, event);
      if ((next.phase as string) === "legacy") next.phase = "decision";
      db.prepare(
        "INSERT INTO processing_events(id,caseId,deduplicationKey,data) VALUES(?,?,?,?)",
      ).run(event.id, state.id, event.deduplicationKey, JSON.stringify(event));
      db.prepare("UPDATE processing_cases SET data=? WHERE id=?").run(
        JSON.stringify(next),
        state.id,
      );
    }
    db.exec(
      "INSERT OR IGNORE INTO schema_migrations VALUES(2,datetime('now')); RELEASE SAVEPOINT workflow_upgrade",
    );
  } catch (error) {
    db.exec(
      "ROLLBACK TO SAVEPOINT workflow_upgrade; RELEASE SAVEPOINT workflow_upgrade",
    );
    throw error;
  }
}
