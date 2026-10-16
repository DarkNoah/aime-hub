const SVG_OPENING_TAG = /<svg(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/;

function pixelLength(value: string | null, fallback: number) {
  const length = Number(value?.trim().replace(/px$/, ''));
  return Number.isFinite(length) && length > 0 ? length : fallback;
}

export function createSvgPreview(code: string) {
  let aspectRatio = 2;
  let content = code;
  const openingTag = code.match(SVG_OPENING_TAG)?.[0];

  // Parse only the root attributes so incomplete streamed SVGs resize too.
  if (openingTag && typeof DOMParser !== 'undefined') {
    const root = new DOMParser().parseFromString(
      openingTag.replace(/\/?>$/, '/>'),
      'image/svg+xml',
    ).documentElement;

    if (root.localName === 'svg') {
      const viewBox = root
        .getAttribute('viewBox')
        ?.trim()
        .split(/[\s,]+/)
        .map(Number);
      const hasViewBox =
        viewBox?.length === 4 &&
        viewBox.every(Number.isFinite) &&
        viewBox[2] > 0 &&
        viewBox[3] > 0;
      const width = hasViewBox
        ? viewBox[2]
        : pixelLength(root.getAttribute('width'), 300);
      const height = hasViewBox
        ? viewBox[3]
        : pixelLength(root.getAttribute('height'), 150);

      aspectRatio = width / height;
      if (!hasViewBox) root.setAttribute('viewBox', `0 0 ${width} ${height}`);
      root.setAttribute('width', '100%');
      root.setAttribute('height', '100%');
      root.setAttribute(
        'style',
        `${root.getAttribute('style') ?? ''};width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;display:block;margin:0`,
      );
      const normalizedTag = new XMLSerializer()
        .serializeToString(root)
        .replace(/\/>$/, openingTag.endsWith('/>') ? '/>' : '>');
      content = code.replace(openingTag, () => normalizedTag);
    }
  }

  return {
    aspectRatio,
    srcDoc: `<!doctype html><html><head><style>
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
body > svg { display: block; width: 100%; height: 100%; }
</style></head><body>${content}</body></html>`,
  };
}
