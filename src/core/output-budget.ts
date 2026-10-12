import type {JobKind} from './types.ts';

// Routing now includes an editable plan and structured gaps, in addition to model reasoning.
export const defaultTriageMaxTokens = 6000;
export function effectiveOutputTokens(kind:JobKind, settings:{maxTokens:number;triageMaxTokens?:number}, policy?:{maxTokens?:number}) {
  const limit=policy?.maxTokens ?? settings.maxTokens;
  return ['triage','preflight'].includes(kind) ? Math.min(limit,settings.triageMaxTokens ?? defaultTriageMaxTokens) : limit;
}
export function exhaustedOutputMessage(kind:JobKind, maxTokens:number) {
  const setting=['triage','preflight'].includes(kind)
    ? '请检查全局设置的「分诊 / PR 预检输出 Token 上限」，以及仓库或全局的「输出 Token 上限」；实际额度取两者较小值。'
    : '请提高仓库或全局的「输出 Token 上限」后明确重试。';
  return `模型输出预算已耗尽（本次实际上限 ${maxTokens} Token），尚未生成完整产物。${setting}已有输出和工作区保留，未自动提高上限或重试。`;
}
