import type { MastraBrowser } from '@mastra/core/browser';
import { AgentBrowser } from '@mastra/agent-browser';
import { chromium } from 'playwright-core';

export const getBrowser = (): MastraBrowser =>
  new AgentBrowser({
    headless: true,
    scope: 'thread',
    // Share the Chromium installed for web_fetch, including in containers.
    executablePath: chromium.executablePath(),
  });
