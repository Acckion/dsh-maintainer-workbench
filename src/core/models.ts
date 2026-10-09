import type { HostModelCatalog, JobKind, ModelChoice, Settings } from "./types.ts";

export function configuredModel(settings: Settings, kind: JobKind): ModelChoice | undefined {
  return settings.stageModels?.[kind] ?? settings.nativeDefaultModel;
}


export function assertCatalogChoice(choice: ModelChoice, catalog: HostModelCatalog): void {
  const model = catalog.groups.find(group => group.id === choice.provider)?.models.find(model => model.id === choice.model);
  if (!model) throw new Error(`模型 ${choice.provider}/${choice.model} 不在 Harness 当前列表中，请刷新后重新选择`);
  if (choice.reasoningEffort && !model.reasoning?.efforts.some(effort => effort.id === choice.reasoningEffort))
    throw new Error(`模型 ${choice.model} 不支持推理等级 ${choice.reasoningEffort}`);
}
