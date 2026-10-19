import { chromium as playwrightChromium } from 'playwright-core';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Share plugin setup, not browser contexts or user profiles. Keep the pinned
// playwright-core runtime and its installed Chromium binary for both callers.
export const chromium = addExtra(playwrightChromium).use(StealthPlugin());
