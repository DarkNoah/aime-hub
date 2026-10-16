export function browserRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseBrowserOutput(
  value: unknown,
): Record<string, unknown> | undefined {
  // Stored tool results can be JSON strings or AI SDK JSON envelopes.
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return undefined;
      }
    }
    const record = browserRecord(value);
    if (record?.type === 'json' && 'value' in record) {
      value = record.value;
      continue;
    }
    return record;
  }
  return undefined;
}

export function browserScreenshotOutput(output: unknown) {
  const record = parseBrowserOutput(output);
  // The URL is the captured page, not the image. AgentBrowser always emits PNG.
  return typeof record?.base64 === 'string'
    ? {
        type: 'image',
        mediaType: 'image/png',
        data: record.base64,
        filename: 'screenshot.png',
      }
    : (record ?? output);
}

export type BrowserTab = {
  index: number;
  url: string;
  title?: string;
  active?: boolean;
};

export function parseBrowserTabs(value: unknown): BrowserTab[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => {
    const tab = browserRecord(entry);
    return (
      tab &&
      typeof tab.index === 'number' &&
      Number.isInteger(tab.index) &&
      tab.index >= 0 &&
      typeof tab.url === 'string' &&
      (tab.title === undefined || typeof tab.title === 'string') &&
      (tab.active === undefined || typeof tab.active === 'boolean') &&
      Object.keys(tab).every((key) =>
        ['index', 'url', 'title', 'active'].includes(key),
      )
    );
  })
    ? (value as BrowserTab[])
    : undefined;
}
