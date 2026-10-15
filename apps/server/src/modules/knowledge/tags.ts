// OR within one dimension, AND between dimensions. The values are always bound parameters.
export function tagFilter(parameter: string) {
  return `NOT EXISTS (SELECT 1 FROM jsonb_each(${parameter}::jsonb) wanted
    WHERE NOT COALESCE((d.tags -> wanted.key) ?| ARRAY(SELECT jsonb_array_elements_text(wanted.value)), false))`;
}
