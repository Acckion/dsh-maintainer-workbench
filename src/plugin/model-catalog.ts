import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import type { HostModelCatalog } from '../core/types.ts';

interface ModelCatalogHost {
  llm: Pick<Context['llm'], 'listProviders' | 'listModels' | 'resolveModelInfo'>;
  agentDefaultModel: Pick<Context['agentDefaultModel'], 'currentSelection'>;
}

/** Project model choices from injected host services without importing a session controller. */
export async function buildModelCatalog(ctx: ModelCatalogHost): Promise<HostModelCatalog> {
  const selection = ctx.agentDefaultModel.currentSelection();
  const results = await Promise.all(
    ctx.llm.listProviders().map(async (provider): Promise<
      | { kind: 'group'; group: HostModelCatalog['groups'][number] }
      | { kind: 'failure'; failure: HostModelCatalog['failures'][number] }
    > => {
      try {
        const models = await ctx.llm.listModels(provider.id);
        const entries = await Promise.all(
          models.map(async (model) => {
            const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id);
            const reasoning = resolved.reasoning === undefined
              ? undefined
              : {
                  efforts: resolved.reasoning.efforts.map((effort) => ({
                    id: effort.id,
                    name: effort.name,
                    ...(effort.description === undefined ? {} : { description: effort.description }),
                  })),
                  ...(resolved.reasoning.defaultEffort === undefined
                    ? {}
                    : { defaultEffort: resolved.reasoning.defaultEffort }),
                };
            return {
              id: model.id,
              name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
              ...(reasoning === undefined ? {} : { reasoning }),
            };
          }),
        );
        return {
          kind: 'group',
          group: { id: provider.id, name: provider.name, models: entries },
        };
      } catch (error) {
        return {
          kind: 'failure',
          failure: {
            id: provider.id,
            name: provider.name,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );
  const groups = results
    .flatMap((item) => (item.kind === 'group' ? [item.group] : []))
    .filter((group) => group.models.length > 0);
  return {
    default: { ...selection },
    groups,
    failures: results.flatMap((item) => (item.kind === 'failure' ? [item.failure] : [])),
  };
}
