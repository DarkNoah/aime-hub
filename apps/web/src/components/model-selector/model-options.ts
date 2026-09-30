import {
  modelReference,
  type AvailableModel,
  type AvailableProvider,
} from '@aime/shared/providers';

export type ModelOption = {
  value: string;
  label: string;
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  providerId: string;
  providerName: string;
};

export function modelOptions(
  providers: Pick<AvailableProvider, 'id' | 'name' | 'enabled'>[],
  models: AvailableModel[],
  imageOnly = false,
): ModelOption[] {
  const enabledProviders = new Map(
    providers
      .filter((provider) => provider.enabled)
      .map((provider) => [provider.id, provider]),
  );
  return models.flatMap((model) => {
    const provider = enabledProviders.get(model.providerId);
    if (
      !provider ||
      !model.enabled ||
      (imageOnly && !model.modalitiesOutput.includes('image'))
    )
      return [];
    const displayName = model.displayName || model.name;
    return [
      {
        value: modelReference(model.providerId, model.id),
        label: `${provider.name} / ${displayName} (${model.id})`,
        id: model.id,
        name: model.name,
        displayName,
        description: model.description,
        providerId: provider.id,
        providerName: provider.name,
      },
    ];
  });
}

export function groupModelOptions(options: ModelOption[], search = '') {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<
    string,
    { id: string; name: string; models: ModelOption[] }
  >();
  for (const option of options) {
    const text =
      `${option.providerName} ${option.name} ${option.displayName} ${option.id} ${option.description ?? ''}`.toLocaleLowerCase();
    if (!terms.every((term) => text.includes(term))) continue;
    let group = groups.get(option.providerId);
    if (!group) {
      group = { id: option.providerId, name: option.providerName, models: [] };
      groups.set(option.providerId, group);
    }
    group.models.push(option);
  }
  return [...groups.values()];
}
