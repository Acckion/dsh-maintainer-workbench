import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type { JobKind, ModelChoice, Settings } from "../core/types.ts";

import { configuredModel } from "../core/models.ts";

/** Explicit choices use only currently advertised Harness models. No key or provider configuration is copied. */
export async function taskModel(ctx: Context, settings: Settings, kind: JobKind): Promise<ReturnType<Context["agentDefaultModel"]["currentSelection"]>> {
  const choice = configuredModel(settings, kind);
  const hostSelection = ctx.agentDefaultModel.currentSelection();
  const selection = choice ?? hostSelection;
  if (!ctx.llm.listProviders().some(p => p.id === selection.provider))
    throw new Error(`所选模型提供方 ${selection.provider} 未加载，请在 Harness 模型设置中检查或重新选择模型`);
  if (!choice) return { ...hostSelection };
  if (!(await ctx.llm.listModels(choice.provider)).some(model => model.id === choice.model))
    throw new Error(`所选模型 ${choice.provider}/${choice.model} 已不在 Harness 模型列表中，请重新选择；未自动切换模型`);
  const resolved = await ctx.llm.resolveModelInfo(choice.provider, choice.model);
  if (choice.reasoningEffort && !resolved.reasoning?.efforts.some(e => e.id === choice.reasoningEffort))
    throw new Error(`所选模型不支持推理等级 ${choice.reasoningEffort}，请在插件模型设置中重新选择`);
  const reasoningEffort = choice.reasoningEffort
    ? resolved.reasoning?.efforts.find(e => e.id === choice.reasoningEffort)?.id
    : resolved.reasoning?.defaultEffort;
  return { provider: choice.provider, model: choice.model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}
