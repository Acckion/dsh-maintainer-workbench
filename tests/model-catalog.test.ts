import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { buildModelCatalog } from '../src/plugin/model-catalog.ts';

test('host services supply defaults, grouped models and reasoning without controller exports or credentials', async () => {
  const high = ReasoningEffortId('high');
  const selection = { provider: 'primary', model: 'reasoner', reasoningEffort: high };
  const reasoning = {
    efforts: [{ id: high, name: 'High', description: 'More reasoning', internal: 'private' }],
    defaultEffort: high,
    internal: 'private',
  };
  const catalog = await buildModelCatalog({
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      listProviders: () => [{ id: 'primary', name: 'Primary', apiKey: 'secret' }, { id: 'empty', name: 'Empty' }],
      listModels: async provider => provider === 'empty' ? [] : [
        { provider, id: 'reasoner', name: 'Reasoner', description: 'Reasoning model', apiKey: 'secret' },
        { provider, id: 'plain', name: 'Plain' },
      ],
      resolveModelInfo: async (provider, id) => ({ provider, id, name: id, ...(id === 'reasoner' ? { reasoning } : {}), apiKey: 'secret' }),
    },
  });
  assert.deepEqual(catalog, {
    default: selection,
    groups: [{ id: 'primary', name: 'Primary', models: [
      { id: 'reasoner', name: 'Reasoner', description: 'Reasoning model', reasoning: {
        efforts: [{ id: 'high', name: 'High', description: 'More reasoning' }], defaultEffort: 'high',
      } },
      { id: 'plain', name: 'Plain' },
    ] }],
    failures: [],
  });
  assert.notEqual(catalog.default, selection);
  assert.doesNotMatch(JSON.stringify(catalog), /secret|private|apiKey|internal/);
});

test('a provider listing or metadata failure leaves other providers available', async () => {
  const catalog = await buildModelCatalog({
    agentDefaultModel: { currentSelection: () => ({ provider: 'healthy', model: 'plain' }) },
    llm: {
      listProviders: () => ['listing-failed', 'metadata-failed', 'healthy'].map(id => ({ id, name: id })),
      listModels: async provider => {
        if (provider === 'listing-failed') throw Error('Provider unavailable');
        return [{ provider, id: 'plain', name: 'Plain' }];
      },
      resolveModelInfo: async (provider, id) => {
        if (provider === 'metadata-failed') throw Error('Metadata unavailable');
        return { provider, id, name: 'Plain' };
      },
    },
  });
  assert.deepEqual(catalog.groups, [{ id: 'healthy', name: 'healthy', models: [{ id: 'plain', name: 'Plain' }] }]);
  assert.deepEqual(catalog.failures, [
    { id: 'listing-failed', name: 'listing-failed', message: 'Provider unavailable' },
    { id: 'metadata-failed', name: 'metadata-failed', message: 'Metadata unavailable' },
  ]);
});
