/** Preserve saved delegation names while adding each newly selected Agent once. */
export function updateSubagentSelection(
  current: Record<string, string>,
  selectedIds: readonly string[],
): Record<string, string> {
  const selected = new Set(selectedIds);
  const entries = Object.entries(current).filter(([, id]) => selected.has(id));
  const names = new Set(entries.map(([name]) => name));
  const retained = new Set(entries.map(([, id]) => id));
  for (const id of selected) {
    if (retained.has(id)) continue;
    const base = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 58) || 'worker';
    let name = base;
    for (let index = 2; names.has(name); index++) {
      const suffix = `_${index}`;
      name = `${base.slice(0, 58 - suffix.length)}${suffix}`;
    }
    entries.push([name, id]);
    names.add(name);
  }
  return Object.fromEntries(entries);
}
