import {after} from 'node:test';
import {chromium} from 'playwright';

// Never fall back to the user's installed Chrome. Reuse a headless-shell process
// within each test file; fixtures own isolated contexts, not browser processes.
let browser;
export function testBrowser() {
  return browser ??= chromium.launch({headless:true});
}
after(async () => { if (browser) await (await browser).close(); });
