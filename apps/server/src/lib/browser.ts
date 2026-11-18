import { chromium as playwrightChromium } from 'playwright-core';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createUserAgentPlugin } from './browser-stealth.js';

// web_fetch uses a temporary context with its own request routing.
export const chromium = addExtra(playwrightChromium).use(StealthPlugin());
chromium.plugins.setDependencyResolution(
  'stealth/evasions/user-agent-override',
  createUserAgentPlugin,
);
