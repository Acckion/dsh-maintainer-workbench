/** Only output/schema failures may reuse a completed execution for format recovery. */
export class ArtifactFormatError extends Error {
  override name = 'ArtifactFormatError';
}
