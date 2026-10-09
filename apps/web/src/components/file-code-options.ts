import type { CSSProperties } from 'react';

export const fileCodeStyles = {
  '--diffs-font-family': 'var(--font-mono)',
  '--diffs-font-size': '12px',
  '--diffs-line-height': '21px',
  '--diffs-gap-inline': '8px',
  '--diffs-gap-block': '6px',
} as CSSProperties;

export const fileCodeOptions = {
  theme: { light: 'pierre-light', dark: 'pierre-dark' },
  overflow: 'wrap',
  disableFileHeader: true,
  // The upstream wrap option covers code lines but not this EOF marker.
  unsafeCSS:
    '[data-no-newline] { white-space: normal; overflow-wrap: anywhere; }',
} as const;
