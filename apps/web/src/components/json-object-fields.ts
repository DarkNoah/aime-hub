export type JsonField = {
  key: string;
  kind: 'string' | 'number' | 'boolean' | 'json';
  value: string;
};

export function parseJsonFields(source: string): JsonField[] {
  const value = JSON.parse(source, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item))
      throw new Error('数字必须有限');
    return item;
  });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('参数必须是 JSON 对象');
  return Object.entries(value).map(([key, item]) => ({
    key,
    kind: ['string', 'number', 'boolean'].includes(typeof item)
      ? (typeof item as 'string' | 'number' | 'boolean')
      : 'json',
    value: typeof item === 'string' ? item : JSON.stringify(item, null, 2),
  }));
}

// Preserve unfinished numeric / JSON input so the caller cannot save stale values.
export function serializeJsonFields(fields: JsonField[]): string {
  return `{\n${fields
    .map(
      (field) =>
        `  ${JSON.stringify(field.key)}: ${field.kind === 'string' ? JSON.stringify(field.value) : field.value}`,
    )
    .join(',\n')}\n}`;
}

export function jsonFieldsError(source: string): string {
  try {
    parseJsonFields(source);
    return '';
  } catch {
    return '请输入有效的 JSON 对象；数字和 JSON 值不能为空。';
  }
}
