import type {HostModelCatalog} from "../../src/core/types.ts";
export const modelCatalog: HostModelCatalog = {
  default: {provider:'deepseek',model:'flash',reasoningEffort:'high'},
  groups: [
    {id:'deepseek',name:'DeepSeek',models:[{id:'flash',name:'DeepSeek-V4.1-Flash'},
      {id:'pro',name:'DeepSeek-V4-Pro',reasoning:{defaultEffort:'medium',efforts:[{id:'low',name:'低'},{id:'medium',name:'中'},{id:'high',name:'高'}]}}]},
    {id:'openrouter',name:'openrouter',models:[{id:'laguna',name:'Poolside: Laguna S.1 (free)'}]},
  ], failures: [],
};
