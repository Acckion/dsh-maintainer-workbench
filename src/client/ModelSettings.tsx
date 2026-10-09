import { useEffect, useState } from "react";
import { kindNames, kinds, type HostModelCatalog, type Settings } from "../core/types.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { request } from "./api.ts";

export function ModelSettings({ settings, update }: { settings: Settings; update: (s: Settings) => void }) {
  const [catalog, setCatalog] = useState<HostModelCatalog>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void request("/models").then(value => { if (active) setCatalog(value); })
      .catch(e => { if (active) setError(e.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);
  const inherited = catalog?.groups.find(g => g.id === catalog.default.provider)?.models.find(m => m.id === catalog.default.model)?.name ?? catalog?.default.model;
  return <div className="mw-model-settings">
    <div className="mw-model-heading"><strong>Harness 模型</strong><button type="button" className="mw-text-button" disabled={loading}
      onClick={() => setRefresh(n => n + 1)}>{loading ? "正在读取…" : "刷新模型列表"}</button></div>
    <p className="mw-muted">使用 Harness 中已配置的模型，无需重复填写密钥。</p>
    {error && <p role="alert" className="mw-model-unavailable">{error}</p>}
    {catalog && <>
      {catalog.failures.length > 0 && <p role="status" className="mw-model-unavailable">部分提供方未能读取：{catalog.failures.map(f => f.name).join("、")}。可在 Harness 模型设置中检查后刷新。</p>}
      {!catalog.groups.length && <p role="status">暂无可选模型，请先在 Harness「设置 → 模型」中添加。</p>}
      <ModelPicker label="默认模型" catalog={catalog} value={settings.nativeDefaultModel}
        inherit={`跟随 Harness 默认${inherited ? ` · ${inherited}` : ""}`}
        select={nativeDefaultModel => update({...settings, nativeDefaultModel})}/>
      <details className="mw-stage-models"><summary>高级设置 · 按阶段选择模型{Object.keys(settings.stageModels ?? {}).length ? ` · ${Object.keys(settings.stageModels!).length} 项覆盖` : ""}</summary>
        <p className="mw-muted">阶段选择优先于插件默认。未单独设置的阶段使用上面的默认模型。</p>
        {kinds.map(kind => <ModelPicker key={kind} label={kindNames[kind]} catalog={catalog}
          value={settings.stageModels?.[kind]} inherit="使用插件默认模型"
          select={choice => {
            const stageModels = {...settings.stageModels};
            if (choice) stageModels[kind] = choice; else delete stageModels[kind];
            update({...settings, stageModels});
          }}/>) }
        {!!Object.keys(settings.stageModels ?? {}).length && <button type="button" className="mw-text-button" onClick={() => update({...settings, stageModels: {}})}>所有阶段恢复默认</button>}
      </details>
    </>}
  </div>;
}
