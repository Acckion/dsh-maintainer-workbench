export class EnvironmentUnavailable extends Error {
  override name = "EnvironmentUnavailable";
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
  }
}
