import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataSource } from 'typeorm';
import { createTool } from '@mastra/core/tools';
import { PLUGIN_API_VERSION, pluginManifestSchema } from '@app/plugin-sdk';
import { PluginTool } from '@app/plugin-sdk/server';
import { PluginService } from './service.js';
import { summarizeTurn } from '../threads/turns.js';

test('plugin display flags work for historical calls without database reads or tool construction', () => {
  class CardTool extends PluginTool {
    override readonly forceRender = true;
    protected override create(): never {
      throw new Error('Display reads must never construct execution tools');
    }
  }
  class HiddenTool extends CardTool {
    override readonly hidden = true;
  }
  class RegularTool extends PluginTool {}
  const definition = (id: string) =>
    createTool({
      id,
      description: 'Display test',
      execute: async () => ({ title: 'Card' }),
    });
  const service = new PluginService(
    {
      query: () => {
        throw new Error('Display reads must never read enabled settings');
      },
    } as unknown as DataSource,
    [
      {
        manifest: pluginManifestSchema.parse({
          id: 'example',
          name: 'Example',
          description: '',
          version: '1.0.0',
          apiVersion: PLUGIN_API_VERSION,
        }),
        database: { entities: [], migrations: [] },
        createServer: () => ({
          tools: [
            new CardTool(definition('plugin_example_card')),
            new RegularTool(definition('plugin_example_regular')),
            new HiddenTool(definition('plugin_example_hidden')),
          ],
        }),
      },
    ],
  );
  assert.equal(service.isToolForceRendered('plugin_example_card'), true);
  assert.equal(service.isToolForceRendered('plugin_example_regular'), false);
  assert.equal(service.isToolForceRendered('plugin_example_hidden'), false);
  assert.equal(service.isToolForceRendered('plugin_example_unknown'), false);
  const turn = summarizeTurn(
    {
      id: 'turn',
      messages: [
        {
          id: 'assistant',
          role: 'assistant',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'plugin_example_card',
              toolCallId: 'card',
              state: 'output-available',
              input: {},
              output: { title: 'Card' },
            },
          ],
        },
      ],
    },
    undefined,
    { forceRender: service.isToolForceRendered.bind(service) },
  );
  assert.equal(turn.assistant?.parts[0].type, 'dynamic-tool');
  assert.ok(
    turn.assistant?.parts[0] &&
      'forceRender' in turn.assistant.parts[0] &&
      turn.assistant.parts[0].forceRender === true,
  );
  assert.equal(turn.hasDetails, false);
});
