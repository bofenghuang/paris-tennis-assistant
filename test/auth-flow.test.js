import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { isAuthenticated, isLoggedOut, startLogin } from '../src/site.js';

test('uses the visible login control and recognizes the injected Mon Paris account marker', async (testContext) => {
  const browser = await chromium.launch({ headless: true });
  testContext.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.setContent(`
    <style>#mobileMonCompte { display: none; }</style>
    <a id="mobileMonCompte" href="#">mon compte</a>
    <a class="banner-mon-compte__connexion-avatar" href="#">Mon Paris</a>
    <script>
      window.loginClicks = { mobile: 0, desktop: 0 };
      document.querySelector('#mobileMonCompte').addEventListener('click', (event) => {
        event.preventDefault();
        window.loginClicks.mobile += 1;
      });
      document.querySelector('.banner-mon-compte__connexion-avatar').addEventListener('click', (event) => {
        event.preventDefault();
        window.loginClicks.desktop += 1;
      });
    </script>
  `);
  await startLogin(page);
  await page.waitForFunction(() => window.loginClicks.desktop === 1);
  assert.deepEqual(await page.evaluate(() => window.loginClicks), { mobile: 0, desktop: 1 });

  await page.route('https://tennis.paris.fr/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <nav class="navbar-collapse disconnected">stale mobile navigation</nav>
      <div class="banner-mon-compte__connected-avatar">B</div>
    `,
  }));
  await page.goto('https://tennis.paris.fr/tennis/test-auth');
  assert.equal(await isAuthenticated(page), true);
  assert.equal(await isLoggedOut(page), false);
});
