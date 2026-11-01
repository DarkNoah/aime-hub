# Provider configuration fields

Every registered provider inherits `BaseProvider.configuration`. Declare extra
parameters in the provider class; no supplier-specific frontend form or locale
file changes are needed:

```ts
import type { ProviderConfiguration } from '@aime/shared/provider-configuration';

export class ExampleProvider extends BaseProvider {
  static override readonly configuration: ProviderConfiguration = {
    fields: [
      {
        key: 'workspaceId',
        type: 'text',
        label: { en: 'Workspace ID', 'zh-CN': '工作空间 ID' },
        required: true,
      },
      {
        key: 'region',
        type: 'select',
        label: 'Region',
        defaultValue: 'east',
        options: [
          { value: 'east', label: 'East' },
          { value: 'west', label: 'West' },
        ],
      },
    ],
    defaultBaseUrl: 'https://api.example.com/v1',
    description: { en: 'Example provider', 'zh-CN': '示例供应商' },
  };
}
```

- Field types: `text`, `textarea`, `number`, `select`, `switch`.
- All fields support `key`, `label`, `description`, `required` and `defaultValue`.
  Text supports `pattern` and `placeholder`; numbers support `min`, `max`,
  `integer` and `placeholder`; selects declare `options`.
- Labels, hints and placeholders accept a plain string or `{ en, 'zh-CN' }`.
- Extra parameters are stored in administrator-visible `provider.metadata`.
  API credentials continue to use the existing `apiKey` field.
- The same definitions validate create/update operations and apply defaults at
  runtime. Read normalized parameters from `this.provider.metadata`.
- PATCH merges metadata without erasing unrelated values. A field set to `null`
  or blank clears an optional value; a declared default is restored when cleared.
  `false` and `0` remain actual values.
- Override `static getConfiguration(type)` if aliases need different defaults;
  Alibaba uses this for its compatible chat URL. Keep the method pure: discovery
  must not require credentials, instantiate a provider, or call external services.
- Existing providers only need to edit their class. For a new implementation,
  register it in `registry.ts` once, alongside its constructor dependencies, and
  add its type to the provider catalog if it is not already listed.

`GET /api/admin/provider-configurations` exposes the definitions to administrators.
The provider editor renders them with the shared controls and prevents saving
until definitions have loaded. The public model catalog does not expose settings.
