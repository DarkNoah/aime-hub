import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  INTELLIGENT_UI_TOOL,
  intelligentUiInputSchema,
  intelligentUiResumeSchema,
  parseIntelligentUiResponse,
} from '@aime/shared/intelligent-ui';

export const intelligentUI = createTool({
  id: INTELLIGENT_UI_TOOL,
  description: `Render a rich IntelligentUI HTML panel directly in the conversation: weather, reports, charts, heatmaps, forms, visual selectors, sliders, diagrams, or multi-step interactions.

Provide html, optionally title and tips. Omit waitForResponse (or set false) for weather, reports, and other displays: the tool returns immediately and local interactions still work. Set waitForResponse: true only when the runtime needs the user's result to continue.

For a response, call window.IntelligentUI.resume({ action: 'submit', ...values }) from a user action. The JSON object becomes this tool's result. You can return button IDs, slider values, clicked coordinates, selected heatmap cells, form fields, or completed actions. Each tool call accepts ONE successful response. Accumulate intermediate events locally and submit them together on completion; do not send every pointer movement or automatically submit on load. The user can skip the panel, returning { cancelled: true }.

Declarative forms also work: <form data-ui-resume='{"action":"save"}'>...</form>. Named controls are collected on submit; repeated names become arrays. A button with data-ui-resume merges its JSON object with its associated form values and validates the form. File uploads are not supported; return JSON values only, up to 60,000 characters.

The HTML runs in a sandbox with inline CSS/JavaScript, SVG and canvas. Host DOM, cookies, storage, network calls, external scripts/styles/images/fonts, frames, downloads, popups and form navigation are unavailable. Keep resources inline; fetch real data with other tools first and embed it. Write finite, event-driven scripts. Use this tool directly, not inside exec.

The panel automatically grows and shrinks with its content; the conversation handles scrolling. Keep the document and outer wrapper at natural content height. Avoid fixed/max heights, viewport-relative heights (vh/dvh), and overflow:auto/scroll on the document or outer wrapper. Individual charts may have explicit heights.

Make the panel visually polished and responsive: clear typography, balanced spacing, restrained accent colors, readable charts and legends, labeled inputs, keyboard access, and visible hover/focus/selected states. Use the supplied CSS variables --background, --foreground, --muted, --muted-foreground, --primary, --primary-foreground, --border. Add purposeful, subtle 150–250ms transitions, chart reveals, slider feedback or completion animations with transform/opacity; honor prefers-reduced-motion. Content must remain visible without animation. Avoid fixed widths, gratuitous motion, and external dependencies. Prefer ask_user for ordinary text questions or simple choices.`,
  inputSchema: intelligentUiInputSchema,
  resumeSchema: intelligentUiResumeSchema,
  suspendSchema: z.object({ reason: z.string() }),
  execute: async (input, context) => {
    if (context?.abortSignal?.aborted) return '用户中止了操作';
    if (!input.html.trim())
      throw new Error('Provide HTML content for the panel.');
    if (!input.waitForResponse) return { rendered: true };
    if (context?.agent?.resumeData !== undefined)
      return parseIntelligentUiResponse(context.agent.resumeData);
    if (!context?.agent?.suspend)
      throw new Error(
        'IntelligentUI requires an interactive chat runtime. Call it directly.',
      );
    return context.agent.suspend({
      reason: 'Waiting for the user to complete the IntelligentUI panel.',
    });
  },
});
