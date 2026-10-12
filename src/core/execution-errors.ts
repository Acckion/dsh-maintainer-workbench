/** Only output/schema failures may reuse a completed execution for format recovery. */
export class ArtifactFormatError extends Error {
  override name = 'ArtifactFormatError';
  constructor(message: string, readonly failure: { kind: ReportFailureKind; repairAttempts: number } = { kind: 'schema', repairAttempts: 0 }) {
    super(message);
  }
}
export type ReportFailureKind = 'syntax' | 'schema' | 'truncated' | 'oversized' | 'recovery_failed';

export class ReportParseError extends Error {
  constructor(message: string, readonly kind: ReportFailureKind) { super(message); }
}
