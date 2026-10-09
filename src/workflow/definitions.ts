import { transition } from "./engine.ts";

export const currentWorkflowVersion = "maintainer/2";
/** Version 1 is upgraded explicitly at persistence startup, without replaying execution. */
const definitions = { "maintainer/2": { transition } };
export function workflowDefinition(version: string) {
  if (!Object.hasOwn(definitions, version))
    throw new Error(
      `处理流程版本 ${version} 不受当前程序支持，已保留状态，请勿自动重放`,
    );
  return definitions[version as keyof typeof definitions];
}
