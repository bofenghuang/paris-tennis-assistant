import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  assessReservationPage,
  confirmFinalReservationReview,
  continueAfterHumanVerification,
  continueToNextReservationStep,
  fillConfiguredPartner,
  isTransientNavigationError,
  useExistingPassOnly,
} from '../src/site.js';

test('selects an existing Abonnement 10h and confirms the reservation', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <h1>Paiement</h1>
      <p>Choisissez votre moyen de paiement</p>
      <label>
        <input type="radio" name="payment" value="subscription" />
        Mon Abonnement 10h — 6 heures restantes
      </label>
      <button id="confirm" type="button">Confirmer la réservation</button>
    </main>
    <script>
      document.querySelector('#confirm').addEventListener('click', () => {
        document.body.innerHTML = '<h1>Confirmation de votre réservation</h1><p>Réservation confirmée</p>';
      });
    </script>
  `);

  const result = await useExistingPassOnly(page, { maxPriceEuros: 12 });
  assert.equal(result.status, 'submitted');
  assert.match(await page.locator('body').innerText(), /Réservation confirmée/);
});

test('does not click anything when card fields are visible', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <h1>Paiement</h1>
      <label><input type="radio" name="payment" />Mon Abonnement 10h — 4 heures restantes</label>
      <label>Numéro de carte <input id="card" autocomplete="cc-number" /></label>
      <button id="confirm" type="button">Confirmer la réservation</button>
    </main>
  `);

  const result = await useExistingPassOnly(page, { maxPriceEuros: 12 });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'card-fields-visible');
  assert.equal(await page.locator('input[type="radio"]').isChecked(), false);
});

test('recognizes the partner form before incidental payment wording and continues automatically', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <h1>1/3 - Validation du court</h1>
      <h2>Coordonnées de vos partenaires</h2>
      <p>Paiement en ligne obligatoire : une heure sera débitée de votre carnet.</p>
      <label>Nom <input id="partner-name" /></label>
      <label>Prénom <input id="partner-first-name" /></label>
      <label>Email (facultatif) <input id="partner-email" type="email" /></label>
      <button id="add" type="button">Ajouter un partenaire</button>
      <button id="next" type="button" disabled>Etape suivante</button>
    </main>
    <script>
      const name = document.querySelector('#partner-name');
      const firstName = document.querySelector('#partner-first-name');
      const add = document.querySelector('#add');
      const next = document.querySelector('#next');
      const update = () => {
        document.body.dataset.focusoutValidated = 'true';
        next.disabled = !name.value || !firstName.value;
      };
      name.addEventListener('focusout', update);
      firstName.addEventListener('focusout', update);
      add.addEventListener('click', () => {
        document.body.dataset.addClicks = String(Number(document.body.dataset.addClicks || 0) + 1);
      });
      next.addEventListener('click', () => {
        document.body.dataset.partner = name.value + '|' + firstName.value;
        document.querySelector('main').innerHTML = '<h1>Paiement</h1><p>Choisissez votre moyen de paiement</p>';
      });
    </script>
  `);

  assert.equal((await assessReservationPage(page)).stage, 'guest');
  const result = await fillConfiguredPartner(page, { firstName: 'alex', lastName: 'morgan' });
  assert.equal(result.status, 'progressed');
  assert.equal(await page.locator('body').getAttribute('data-partner'), 'morgan|alex');
  assert.equal(await page.locator('body').getAttribute('data-focusout-validated'), 'true');
  assert.equal(await page.locator('body').getAttribute('data-add-clicks'), null);
  assert.match(await page.locator('main').innerText(), /Choisissez votre moyen de paiement/);
});

test('advances the enabled rules step before treating the page as payment', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <h1>2/3 - Validation</h1>
      <section><h2>Points de règlement :</h2></section>
      <p>Une heure de votre carnet sera utilisée pour cette réservation. Il vous restera 9h.</p>
      <button type="button">Etape précédente</button>
      <button id="next" type="button">Etape suivante</button>
    </main>
    <script>
      document.querySelector('#next').addEventListener('click', () => {
        document.querySelector('main').innerHTML = '<h1>Paiement</h1><p>Confirmer la réservation</p>';
      });
    </script>
  `);

  assert.equal((await assessReservationPage(page)).stage, 'rules');
  assert.equal((await continueToNextReservationStep(page)).status, 'progressed');
  assert.match(await page.locator('main').innerText(), /Confirmer la réservation/);
});

test('confirms an implicitly selected existing carnet when the remaining balance is explicit', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <h1>Paiement</h1>
      <p>Une heure de votre carnet sera utilisée pour cette réservation. Il vous restera 9h.</p>
      <button id="confirm" type="button">Confirmer la réservation</button>
    </main>
    <script>
      document.querySelector('#confirm').addEventListener('click', () => {
        document.querySelector('main').innerHTML = '<h1>Confirmation de votre réservation</h1><p>Réservation confirmée</p>';
      });
    </script>
  `);

  const result = await useExistingPassOnly(page, { maxPriceEuros: 12 });
  assert.equal(result.status, 'submitted');
  assert.match(result.passLabel, /Carnet existant/);
  assert.match(await page.locator('main').innerText(), /Réservation confirmée/);
});

test('selects the official clickable one-hour carnet card before advancing', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <h1>2 / 3 - Mode de paiement</h1>
      <section id="carnet-card" style="cursor: pointer">
        <h2>J’utilise 1 heure<br />de mon carnet en ligne</h2>
        <p>Tarif plein - Court découvert</p>
        <strong>1 heure</strong>
      </section>
      <button type="button">Etape précédente</button>
      <button id="next" class="disabled" style="pointer-events: none" type="button">Etape suivante</button>
    </main>
    <script>
      const card = document.querySelector('#carnet-card');
      const next = document.querySelector('#next');
      card.addEventListener('click', () => {
        card.dataset.selected = 'true';
        next.classList.remove('disabled');
        next.style.pointerEvents = 'auto';
      });
      next.addEventListener('click', () => {
        document.querySelector('main').innerHTML = '<h1>3 / 3 - Confirmation</h1><p>Confirmer la réservation</p>';
      });
    </script>
  `);

  const result = await useExistingPassOnly(page, { maxPriceEuros: 12 });
  assert.equal(result.status, 'progressed');
  assert.equal(result.existingPassSelected, true);
  assert.equal(await page.locator('#carnet-card').count(), 0);
  assert.match(await page.locator('main').innerText(), /3 \/ 3 - Confirmation/);
});

test('distinguishes the 3/3 review from success and clicks final confirmation once', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <h1>3 / 3 - Confirmation de votre réservation</h1>
      <p>Mode de paiement : 1 heure de mon carnet en ligne</p>
      <button id="confirm" type="button">Confirmer la réservation</button>
    </main>
    <script>
      document.querySelector('#confirm').addEventListener('click', () => {
        document.querySelector('main').innerHTML = '<h1>Confirmation de votre réservation</h1><p>Votre réservation est confirmée.</p>';
      });
    </script>
  `);

  assert.equal((await assessReservationPage(page)).stage, 'final-review');
  const result = await confirmFinalReservationReview(page, { existingPassSelected: true });
  assert.equal(result.status, 'submitted');
  assert.equal((await assessReservationPage(page)).stage, 'confirmed');
});

test('does not confirm the 3/3 review without a verified carnet selection', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <h1>3 / 3 - Confirmation de votre réservation</h1>
      <button id="confirm" type="button">Confirmer la réservation</button>
    </main>
    <script>
      document.querySelector('#confirm').addEventListener('click', () => {
        document.body.dataset.confirmed = 'true';
      });
    </script>
  `);

  const result = await confirmFinalReservationReview(page, { existingPassSelected: false });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'pass-selection-unverified');
  assert.equal(await page.locator('body').getAttribute('data-confirmed'), null);
});

test('waits for the human verification before clicking the continuation button', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <p>Afin de vous permettre de réserver, nous bloquons les robots qui pourraient agir à votre place.</p>
      <button id="continue" type="button" disabled>Poursuivre la réservation</button>
    </main>
    <script>
      document.querySelector('#continue').addEventListener('click', () => {
        document.querySelector('main').innerHTML = '<h2>Coordonnées de vos partenaires</h2>';
      });
    </script>
  `);

  assert.equal((await assessReservationPage(page)).stage, 'captcha');
  assert.equal((await continueAfterHumanVerification(page)).status, 'waiting');
  await page.locator('#continue').evaluate((button) => { button.disabled = false; });
  assert.equal((await continueAfterHumanVerification(page)).status, 'progressed');
  assert.match(await page.locator('main').innerText(), /Coordonnées de vos partenaires/);
});

test('does not guess partner details when the saved name is incomplete', async (context) => {
  const browser = await chromium.launch({ headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <h2>Coordonnées de vos partenaires</h2>
      <label>Nom <input id="partner-name" /></label>
      <label>Prénom <input id="partner-first-name" /></label>
      <button id="add" type="button">Ajouter un partenaire</button>
    </main>
  `);

  const result = await fillConfiguredPartner(page, { firstName: 'alex', lastName: '' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'partner-not-configured');
  assert.equal(await page.locator('#partner-first-name').inputValue(), '');
});

test('treats a destroyed execution context as a normal reservation-page transition', async () => {
  let evaluateCalls = 0;
  let loadWaits = 0;
  const page = {
    isClosed: () => false,
    url: () => 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=reservation',
    evaluate: async () => {
      evaluateCalls += 1;
      if (evaluateCalls === 1) {
        throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
      }
      return {
        text: 'Coordonnées de vos partenaires Ajouter un partenaire',
        visibleCaptcha: false,
        visibleInputs: 'nom prenom',
      };
    },
    waitForLoadState: async () => { loadWaits += 1; },
    waitForTimeout: async () => {},
  };

  assert.equal(isTransientNavigationError(
    new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'),
  ), true);
  assert.equal((await assessReservationPage(page)).stage, 'guest');
  assert.equal(evaluateCalls, 2);
  assert.equal(loadWaits, 1);
});
