export interface GitHubTransport {
  request: (
    path: string,
    init?: RequestInit,
    beforeSend?: () => void,
  ) => Promise<unknown>;
  graphql: (
    query: string,
    variables: Record<string, unknown>,
    beforeSend?: () => void,
  ) => Promise<unknown>;
  token?: string;
  fetcher: typeof fetch;
}
export abstract class GitHubResourceClient {
  constructor(private transport: GitHubTransport) {}
  protected request: GitHubTransport["request"] = (...args) =>
    this.transport.request(...args);
  protected graphql(
    query: string,
    variables: Record<string, unknown>,
    beforeSend?: () => void,
  ) {
    return this.transport.graphql(query, variables, beforeSend);
  }
  protected get token() {
    return this.transport.token;
  }
  protected get fetcher() {
    return this.transport.fetcher;
  }
}
