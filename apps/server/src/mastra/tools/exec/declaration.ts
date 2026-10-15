type Schema = Record<string, unknown>;

function object(value: unknown): Schema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

function reference(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  try {
    return decodeURIComponent(ref.slice(2))
      .split('/')
      .reduce<unknown>((value, key) => {
        const record = object(value);
        const property = key.replace(/~1/g, '/').replace(/~0/g, '~');
        return record && Object.hasOwn(record, property)
          ? record[property]
          : undefined;
      }, root);
  } catch {
    return undefined;
  }
}

function comments(description: unknown, indent: string) {
  if (typeof description !== 'string' || !description.trim()) return '';
  return description
    .trim()
    .split(/\r\n?|\n|\u2028|\u2029/)
    .map((line) => `${indent}// ${line.replaceAll('```', '\\`\\`\\`')}\n`)
    .join('');
}

/** JSON Schema's structural types, rendered for model discovery (validation stays in Mastra). */
export function schemaType(root: unknown) {
  let remaining = 3000;
  const render = (
    value: unknown,
    depth: number,
    parents: Set<unknown>,
  ): string => {
    if (value === false) return 'never';
    const schema = object(value);
    if (!schema || depth > 12 || remaining-- <= 0 || parents.has(schema))
      return 'unknown';
    const seen = new Set(parents).add(schema);
    const child = (value: unknown, nested = depth) =>
      render(value, nested, seen);
    const indent = '  '.repeat(depth);
    const union = (values: unknown[]) =>
      [...new Set(values.map((value) => child(value)))].join(' | ') || 'never';
    if (typeof schema.$ref === 'string') {
      const target = reference(root, schema.$ref);
      if (target === undefined) return 'unknown';
      return child(target);
    }
    if (Object.hasOwn(schema, 'const')) return literal(schema.const);
    if (Array.isArray(schema.enum))
      return schema.enum.map(literal).join(' | ') || 'never';
    if (Array.isArray(schema.anyOf)) return union(schema.anyOf);
    if (Array.isArray(schema.oneOf)) return union(schema.oneOf);
    if (Array.isArray(schema.allOf))
      return (
        schema.allOf.map((part) => `(${child(part)})`).join(' & ') || 'unknown'
      );
    if (Array.isArray(schema.type))
      return union(schema.type.map((type) => ({ ...schema, type })));
    if (schema.nullable === true)
      return `${child({ ...schema, nullable: false })} | null`;
    switch (schema.type) {
      case 'null':
        return 'null';
      case 'boolean':
        return 'boolean';
      case 'integer':
      case 'number':
        return 'number';
      case 'string':
        return 'string';
      case 'array': {
        const tuple = Array.isArray(schema.prefixItems)
          ? schema.prefixItems
          : Array.isArray(schema.items)
            ? schema.items
            : undefined;
        if (tuple) {
          const rest = Array.isArray(schema.items)
            ? schema.additionalItems
            : schema.items;
          const min = typeof schema.minItems === 'number' ? schema.minItems : 0;
          const parts = tuple.map(
            (item, index) =>
              `${index >= min ? `(${child(item)})?` : child(item)}`,
          );
          if (rest !== false && schema.maxItems !== tuple.length)
            parts.push(`...Array<${child(rest)}>`);
          return `[${parts.join(', ')}]`;
        }
        return `Array<${child(schema.items)}>`;
      }
      default: {
        if (
          schema.type !== 'object' &&
          !schema.properties &&
          schema.additionalProperties === undefined
        )
          return 'unknown';
        const properties = object(schema.properties) ?? {};
        const required = new Set(
          Array.isArray(schema.required) ? schema.required : [],
        );
        const entries = Object.entries(properties);
        if (!entries.length)
          return `Record<string, ${schema.additionalProperties === false ? 'never' : child(schema.additionalProperties)}>`;
        const lines = entries.map(([name, property]) => {
          const info = object(property);
          const description =
            info?.description ??
            (typeof info?.$ref === 'string'
              ? object(reference(root, info.$ref))?.description
              : undefined);
          const key = /^[a-zA-Z_$][\w$]*$/.test(name)
            ? name
            : JSON.stringify(name);
          return `${comments(description, `${indent}  `)}${indent}  ${key}${required.has(name) ? '' : '?'}: ${child(property, depth + 1)};`;
        });
        if (
          schema.additionalProperties !== undefined &&
          schema.additionalProperties !== false
        ) {
          // Named properties may differ from the additional-property schema.
          lines.push(`${indent}  [key: string]: unknown;`);
        }
        return `{\n${lines.join('\n')}\n${indent}}`;
      }
    }
  };
  return render(root, 1, new Set());
}

function literal(value: unknown): string {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  const record = object(value);
  return record
    ? `{ ${Object.entries(record)
        .map(([key, value]) => `${JSON.stringify(key)}: ${literal(value)}`)
        .join('; ')} }`
    : 'unknown';
}

export function execToolDescription(
  name: string,
  description: string,
  inputSchema: unknown,
  outputSchema: unknown,
) {
  const parameters =
    inputSchema === undefined ? '' : `args: ${schemaType(inputSchema)}`;
  const output = schemaType(outputSchema);
  const inputComment = comments(object(inputSchema)?.description, '  ');
  const outputComment = comments(object(outputSchema)?.description, '  ');
  const declaration = `declare const tools: {\n${inputComment}${outputComment}  ${name}(${parameters}): Promise<${output}>;\n};`;
  return `${description}\n\nexec tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;
}
