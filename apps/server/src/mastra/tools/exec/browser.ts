import type { ToolExecutionContext } from '@mastra/core/tools';
import type { BrowserExecBinding } from '../../../modules/threads/browser/registry.js';

// Named parameters cross the VM boundary as a JSON object. Snapshot and
// screenshot accept their options object directly.
const methods = {
  goto: ['goto', 'url'],
  snapshot: ['snapshot', null],
  click: ['click', 'target'],
  fill: ['type', 'target, value'],
  type: ['type', 'target, text'],
  press: ['press', 'key'],
  select: ['select', 'target, value'],
  scroll: ['scroll', 'direction, amount'],
  hover: ['hover', 'target'],
  drag: ['drag', 'source, target'],
  back: ['back', ''],
  forward: ['back', ''],
  reload: ['goto', ''],
  dialog: ['dialog', 'target, action, text'],
  wait: ['wait', 'target, state, timeout'],
  evaluate: ['evaluate', 'script'],
  screenshot: ['screenshot', null],
  tabs: ['tabs', ''],
  newTab: ['tabs', 'url'],
  switchTab: ['tabs', 'index'],
  closeTab: ['tabs', 'index'],
  close: ['close', ''],
} as const;

const methodExports = Object.entries(methods).map(([name, [, parameters]]) => {
  const args = parameters === null ? 'options = {}' : parameters;
  const input = parameters === null ? 'options' : `{ ${parameters} }`;
  return `export const ${name} = (${args}) => call('browser.${name}', ${input});`;
});
const moduleSource = `
  const call = globalThis.__execModuleCall;
  ${methodExports.join('\n')}
  export const browser = Object.freeze({ ${Object.keys(methods).join(', ')} });
  export default browser;
`;

export function createExecBrowserModule(
  context: ToolExecutionContext,
  disabledTools?: ReadonlySet<string>,
) {
  const binding = context.requestContext?.get('execBrowser');
  function requireBinding(): BrowserExecBinding {
    if (typeof binding !== 'function')
      throw new Error(
        'Browser module unavailable outside a browser-enabled chat thread',
      );
    return binding as BrowserExecBinding;
  }

  return {
    load() {
      requireBinding();
      return moduleSource;
    },
    dispatch(operation: string, input: unknown): Promise<unknown> {
      const execute = requireBinding();
      if (!Object.hasOwn(methods, operation))
        throw new Error(`Unknown browser operation: ${operation}`);
      const [legacyName] = methods[operation as keyof typeof methods];
      if (disabledTools?.has(`browser_${legacyName}`))
        throw new Error(`Browser operation disabled: ${operation}`);
      if (
        operation === 'newTab' &&
        disabledTools?.has('browser_goto') &&
        input &&
        typeof input === 'object' &&
        'url' in input
      )
        throw new Error('Browser operation disabled: goto');
      return execute(operation, input, context.abortSignal);
    },
  };
}
