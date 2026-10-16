import { z } from 'zod';

const modifiers = z.number().int().min(0).max(15).optional();
const coordinate = z.number().finite().min(0).max(16384);
export const browserActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    event: z.object({
      type: z.enum([
        'mousePressed',
        'mouseReleased',
        'mouseMoved',
        'mouseWheel',
      ]),
      x: coordinate,
      y: coordinate,
      button: z.enum(['left', 'right', 'middle', 'none']).optional(),
      clickCount: z.number().int().min(0).max(3).optional(),
      deltaX: z.number().finite().min(-10000).max(10000).optional(),
      deltaY: z.number().finite().min(-10000).max(10000).optional(),
      modifiers,
    }),
  }),
  z.object({
    kind: z.literal('keyboard'),
    event: z.object({
      type: z.enum(['keyDown', 'keyUp']),
      key: z.string().max(64),
      code: z.string().max(64),
      windowsVirtualKeyCode: z.number().int().min(0).max(255).optional(),
      modifiers,
    }),
  }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(10000) }),
  z.object({
    kind: z.literal('navigate'),
    url: z
      .string()
      .max(8192)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      }),
  }),
  z.object({ kind: z.enum(['back', 'forward', 'reload', 'close']) }),
  z.object({
    kind: z.literal('tab'),
    index: z.number().int().min(0).max(1000),
  }),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;

export type BrowserState = {
  status: 'waiting' | 'ready' | 'closed' | 'error';
  url: string;
  tabs: { url: string; title?: string }[];
  activeTabIndex: number;
  busy: boolean;
};
export type BrowserFrame = {
  data: string;
  viewport: { width: number; height: number };
};
export type BrowserEvent =
  | { type: 'state'; state: BrowserState }
  | { type: 'frame'; frame: BrowserFrame };
export type BrowserSummary = {
  threadId: string;
  tabCount: number;
  title: string;
  projectId: string | null;
  url: string;
  busy: boolean;
};
export const emptyBrowserState: BrowserState = {
  status: 'waiting',
  url: '',
  tabs: [],
  activeTabIndex: 0,
  busy: false,
};
