import {
  INTELLIGENT_UI_CHANNEL,
  INTELLIGENT_UI_MAX_RESPONSE,
} from '@aime/shared/intelligent-ui';

// The opaque frame uses an explicit bridge; only user-activated links open in the host.
export const INTELLIGENT_UI_CSP =
  "default-src 'none'; base-uri 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: http: data: blob:; font-src data:; media-src data: blob:; worker-src 'none'";

export function getIntelligentUiLinkUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const bootstrap = `(() => {
  const config = document.currentScript.dataset;
  const channel = config.channel;
  const token = config.token;
  const limit = Number(config.limit);
  const nonBlocking = config.mode === 'message';
  let enabled = false;
  let pending = false;
  const send = (type, payload = {}) => parent.postMessage({ channel, token, type, ...payload }, '*');
  const reportError = (error) => send('error', { message: String(error?.message || error).slice(0, 500) });
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const resume = (value) => {
    if (!enabled || pending || (nonBlocking && !navigator.userActivation?.isActive)) return false;
    try {
      if (!object(value)) throw new Error('Submit a JSON object.');
      const json = JSON.stringify(value, (_, item) => {
        if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' || item === undefined || (typeof item === 'number' && !Number.isFinite(item)))
          throw new Error('Submit JSON values only.');
        return item;
      });
      if (json.length > limit) throw new Error('Interaction data is too large.');
      const data = JSON.parse(json);
      if (!object(data)) throw new Error('Submit a JSON object.');
      pending = true;
      send(nonBlocking ? 'message' : 'resume', { data });
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  };
  Object.defineProperty(window, 'IntelligentUI', { value: Object.freeze({ resume, send: resume }), writable: false, configurable: false });
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || data?.channel !== channel || data.token !== token) return;
    if (data.type === 'state') {
      enabled = data.enabled === true;
      if (document.body) document.body.inert = data.locked === true;
      if (data.theme === 'light' || data.theme === 'dark') document.documentElement.style.colorScheme = data.theme;
      for (const [key, value] of Object.entries(data.colors || {}))
        if (key.startsWith('--') && typeof value === 'string') document.documentElement.style.setProperty(key, value);
    }
    if (data.type === 'ack') pending = false;
  });
  const formFor = (element) => element instanceof HTMLFormElement ? element : element.form || element.closest('form');
  const valuesFor = (form, submitter) => {
    const values = Object.create(null);
    if (!form) return values;
    const entries = new FormData(form, submitter);
    for (const [key, value] of entries) {
      if (value instanceof File) throw new Error('File uploads are not supported in this panel.');
      if (!Object.hasOwn(values, key)) values[key] = value;
      else if (Array.isArray(values[key])) values[key].push(value);
      else values[key] = [values[key], value];
    }
    return values;
  };
  const declared = (element) => {
    const value = JSON.parse((element.getAttribute('data-ui-send') ?? element.getAttribute('data-ui-resume'))?.trim() || '{}');
    if (!object(value)) throw new Error('data-ui-resume must contain a JSON object.');
    return value;
  };
  const click = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest('a, area');
    if (link) event.preventDefault();
    const trigger = target?.closest('[data-ui-resume], [data-ui-send]');
    if (!trigger && link) {
      if (event.isTrusted && !document.body.inert && (event.button === 0 || event.button === 1))
        send('open-link', { url: link.getAttribute('href') });
      return;
    }
    if (event.type !== 'click') return;
    if (!trigger || trigger instanceof HTMLFormElement || trigger.matches(':disabled')) return;
    event.preventDefault();
    try {
      const form = formFor(trigger);
      if (form && !form.reportValidity()) return;
      const submitter = (trigger instanceof HTMLButtonElement || trigger instanceof HTMLInputElement) && trigger.type === 'submit' ? trigger : undefined;
      resume({ ...valuesFor(form, submitter), ...declared(trigger) });
    } catch (error) { reportError(error); }
  };
  document.addEventListener('click', click);
  document.addEventListener('auxclick', click);
  document.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || (!form.hasAttribute('data-ui-resume') && !form.hasAttribute('data-ui-send'))) return;
    try { resume({ ...valuesFor(form, event.submitter || undefined), ...declared(form) }); }
    catch (error) { reportError(error); }
  }, true);
  let lastHeight = 0;
  let scheduled = false;
  const resize = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const height = Math.ceil(document.body?.getBoundingClientRect().height || 0);
      if (height !== lastHeight) { lastHeight = height; send('resize', { height }); }
    });
  };
  addEventListener('error', (event) => reportError(event.message || 'Panel script failed.'));
  addEventListener('unhandledrejection', (event) => reportError(event.reason));
  addEventListener('DOMContentLoaded', () => {
    document.body.inert = true;
    new ResizeObserver(resize).observe(document.body);
    send('ready');
    resize();
  });
})();`;

export function buildIntelligentUiDocument(
  html: string,
  token: string,
  mode: 'resume' | 'message' = 'resume',
) {
  // Keep only web links for the host bridge. Inline scripts stay sandboxed;
  // CSP permits image resources while blocking external code and network APIs.
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content
    .querySelectorAll('meta, base, iframe, frame, object, embed, link')
    .forEach((node) => node.remove());
  template.content.querySelectorAll('a, area').forEach((node) => {
    const url = getIntelligentUiLinkUrl(node.getAttribute('href'));
    if (url) node.setAttribute('href', url);
    else node.removeAttribute('href');
    node.removeAttribute('ping');
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
    node.removeAttribute('download');
  });
  const safeToken = token.replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    INTELLIGENT_UI_CSP +
    '">' +
    '<style>' +
    ':root{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;color-scheme:light dark;--background:Canvas;--foreground:CanvasText;--muted:ButtonFace;--muted-foreground:GrayText;--primary:#16805c;--primary-foreground:white;--border:#808080}' +
    '*{box-sizing:border-box}html,body{margin:0;min-width:0;background:var(--background);color:var(--foreground)}' +
    '*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
    'body{display:flow-root;padding:16px;overflow-wrap:anywhere}button,input,select,textarea{font:inherit}button{cursor:pointer}svg,img,canvas{max-width:100%}:focus-visible{outline:2px solid var(--primary);outline-offset:3px}' +
    '@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}' +
    '</style><script data-channel="' +
    INTELLIGENT_UI_CHANNEL +
    '" data-token="' +
    safeToken +
    '" data-mode="' +
    mode +
    '" data-limit="' +
    INTELLIGENT_UI_MAX_RESPONSE +
    '">' +
    bootstrap +
    '</script></head><body>' +
    template.innerHTML +
    '</body></html>'
  );
}
