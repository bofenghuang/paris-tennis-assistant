import {
  dateIsoToTimestamp,
  normalizeText,
  normalizeTime,
  parsePrice,
  rankCandidates,
  searchHourRange,
} from './domain.js';
import {
  chooseConfirmationAction,
  chooseExistingPassOption,
  hasExistingCarnetHourChoice,
  hasExistingPassDebitConfirmation,
  hasInsufficientBalanceText,
  hasVisibleCardField,
  looksLikePaymentPage,
} from './payment.js';

export const SEARCH_URL =
  'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau';

const NAVIGATION_TIMEOUT_MS = 30_000;
const PAYMENT_CONTROL_SELECTOR =
  'input[type="radio"], input[type="checkbox"], option, button, input[type="submit"], input[type="button"], a.btn, [role="radio"], [role="button"]';
const RESERVATION_ACTION_SELECTOR =
  'button, input[type="submit"], input[type="button"], a.btn, [role="button"]';
const PARTNER_FIELD_SELECTOR =
  'input:not([type]), input[type="text"], input[type="search"], textarea';

export function isTransientNavigationError(error) {
  return /execution context was destroyed|most likely because of a navigation|cannot find context with specified id|frame was detached|target page, context or browser has been closed|page has been closed|navigation.*interrupted/i
    .test(String(error?.message ?? error));
}

export async function waitForStableDocument(page, delayMs = 300) {
  if (!page || page.isClosed()) return false;
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  if (page.isClosed()) return false;
  await page.waitForTimeout(delayMs).catch(() => {});
  return !page.isClosed();
}

export async function isLoggedOut(page) {
  if (page.url().includes('v70-auth.paris.fr')) return true;
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    // Mon Paris injects this marker only after its userinfo request succeeds.
    const connectedAccount = document.querySelector('.banner-mon-compte__connected-avatar');
    if (connectedAccount) return false;
    const disconnectedNavigation = [...document.querySelectorAll('.navbar-collapse.disconnected')].some(visible);
    const loginWarning = [...document.querySelectorAll('[role="alert"]')].some((element) =>
      visible(element) && /connecter ou créer|compte parisien/i.test(element.textContent ?? ''),
    );
    return disconnectedNavigation || loginWarning;
  });
}

export async function isAuthenticated(page) {
  if (!page.url().startsWith('https://tennis.paris.fr/tennis/')) return false;
  return page.evaluate(() => Boolean(document.querySelector('.banner-mon-compte__connected-avatar')));
}

export async function startLogin(page) {
  const loginLink = page
    .locator('.banner-mon-compte__connexion-avatar:visible, #mobileMonCompte:visible')
    .first();
  await loginLink.waitFor({ state: 'visible', timeout: 15_000 });
  // Schedule the page's own click handler after this evaluation returns so a
  // multi-hop OIDC redirect cannot be mistaken for a stuck click action.
  await loginLink.evaluate((element) => {
    window.setTimeout(() => element.click(), 0);
  });
}

export async function openSearchPage(page, { fresh = false } = {}) {
  await page.setExtraHTTPHeaders({
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  });
  const url = new URL(SEARCH_URL);
  if (fresh) url.searchParams.set('_pt_refresh', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  await page.waitForSelector('#search_form', { timeout: NAVIGATION_TIMEOUT_MS });
}

export async function releasedDates(page) {
  const values = await page.locator('#search_form .date[dateiso]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('dateiso')).filter(Boolean),
  );
  return [...new Set(values)].sort((left, right) => dateIsoToTimestamp(left) - dateIsoToTimestamp(right));
}

export async function waitForReleasedDate(page, targetIso, waitSeconds, retryIntervalSeconds) {
  const deadline = Date.now() + waitSeconds * 1_000;
  let dates = await releasedDates(page);
  while (!dates.includes(targetIso) && Date.now() < deadline) {
    await page.waitForTimeout(retryIntervalSeconds * 1_000);
    await openSearchPage(page, { fresh: true });
    dates = await releasedDates(page);
  }
  return { released: dates.includes(targetIso), dates };
}

async function setSearchCheckbox(locator, checked) {
  await locator.evaluate((element, nextChecked) => {
    element.checked = nextChecked;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

export async function submitAvailabilitySearch(page, config, targetIso) {
  const postalCodes = config.postalCodes.slice(0, 5);
  const venueSearches = postalCodes.length === 0
    ? config.venuePreferences.slice(0, 5).map((preference) => preference.venue)
    : [];
  const hourRange = searchHourRange(config.timePriority);

  // Paris Tennis stores the previous location filters in its JSESSIONID-backed
  // server session. Always remove those tokens before applying this run's
  // configuration, otherwise a refresh can silently search old or mixed venues.
  const oldLocationTokens = page.locator('#whereToken .tokens-delete-token');
  while (await oldLocationTokens.count()) await oldLocationTokens.first().click();

  const input = page.locator('#whereToken .tokens-input-text');
  for (const location of [
    ...postalCodes.map((code) => ({ query: code, label: `${code} PARIS ${code.slice(-2)}` })),
    ...venueSearches.map((venue) => ({ query: venue, label: venue })),
  ]) {
    await input.click();
    await input.fill('');
    await input.pressSequentially(location.query, { delay: 25 });
    const suggestions = page.locator('.tokens-suggestion-selector .tokens-suggestions-list-element');
    await suggestions.first().waitFor({ state: 'visible', timeout: 12_000 });
    const suggestionTexts = await suggestions.allTextContents();
    let index = suggestionTexts.findIndex((text) => normalizeText(text) === normalizeText(location.label));
    if (index === -1) {
      index = suggestionTexts.findIndex((text) => normalizeText(text).includes(normalizeText(location.query)));
    }
    if (index === -1) throw new Error(`Paris Tennis 未找到地点：${location.label}`);
    await suggestions.nth(index).click();
  }

  await page.locator('#when').click();
  const targetDate = page.locator(`#search_form .date[dateiso="${targetIso}"]`).first();
  await targetDate.waitFor({ state: 'visible', timeout: 10_000 });
  await targetDate.locator('..').click();

  await page.locator('#hourRange').evaluate((element, value) => { element.value = value; }, hourRange);
  const covered = page.locator('input[name="selInOut"][value="V"]');
  const outdoor = page.locator('input[name="selInOut"][value="F"]');
  await setSearchCheckbox(covered, config.coveredPreference !== 'outdoor');
  await setSearchCheckbox(outdoor, config.coveredPreference !== 'covered');

  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  await page.locator('#rechercher').click();
  await navigation;
  await page.waitForSelector('#bookmarkList, .no-result, .search-result-block', {
    state: 'attached',
    timeout: NAVIGATION_TIMEOUT_MS,
  });
}

export async function extractCandidates(page, targetIso) {
  const rawCandidates = await page.evaluate((date) => {
    const tabNames = new Map(
      [...document.querySelectorAll('#bookmarkList a[data-toggle="tab"]')].map((anchor) => {
        const target = anchor.getAttribute('href');
        const label = anchor.querySelector('.tennis-label') ?? anchor;
        return [target, (label.textContent ?? '').trim()];
      }),
    );

    const candidates = [];
    for (const [target, venue] of tabNames) {
      const root = document.querySelector(target);
      if (!root) continue;
      const selectedDate = root.querySelector('.date-item.selected .date')?.getAttribute('dateiso') ?? date;

      for (const [panelIndex, panel] of [...root.querySelectorAll('.panel.panel-default')].entries()) {
        const timeLabel = panel.querySelector('.panel-title')?.textContent?.trim() ?? '';
        for (const [rowIndex, row] of [...panel.querySelectorAll('.tennis-court')].entries()) {
          const allOkButton = row.querySelector('button.buttonAllOk, .buttonAllOk');
          const hasReservationButton = row.querySelector('button.buttonHasReservation, .buttonHasReservation');
          const anyButton = allOkButton ?? hasReservationButton ?? row.querySelector('.button.book button, button');
          const buttonText = anyButton?.textContent?.trim() ?? '';
          const classNames = anyButton?.className ?? '';
          let availability = 'unknown';
          if (allOkButton) availability = 'bookable';
          else if (hasReservationButton) availability = 'account-limit';
          else if (/se connecter/i.test(buttonText)) availability = 'login-required';

          const getAttribute = (name) => anyButton?.getAttribute(name) ?? null;
          const description = row.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          const court = row.querySelector('.court')?.textContent?.replace(/\s+/g, ' ').trim() ?? description;
          const priceLabel = row.querySelector('.price')?.textContent?.trim() ?? '';
          const indoorOutdoor =
            getAttribute('indoorOutdoor') ?? row.querySelector('.price-description')?.textContent?.trim() ?? '';

          candidates.push({
            venue,
            tabTarget: target,
            panelIndex,
            rowIndex,
            dateIso: selectedDate,
            timeLabel,
            court,
            description,
            priceLabel,
            indoorOutdoor,
            availability,
            buttonText,
            classNames,
            bookingKey: {
              equipmentId: getAttribute('equipmentId'),
              courtId: getAttribute('courtId'),
              dateDeb: getAttribute('dateDeb'),
              dateFin: getAttribute('dateFin'),
            },
          });
        }
      }
    }
    return candidates;
  }, targetIso);

  return rawCandidates.map((candidate) => ({
    ...candidate,
    time: normalizeTime(candidate.timeLabel),
    priceEuros: parsePrice(candidate.priceLabel),
  }));
}

export async function extractSearchState(page) {
  return page.evaluate(() => {
    const tabs = [...document.querySelectorAll('#bookmarkList a[data-toggle="tab"]')];
    const venueStates = tabs.map((anchor) => {
      const target = anchor.getAttribute('href');
      const root = target ? document.querySelector(target) : null;
      const rows = root ? [...root.querySelectorAll('.tennis-court')] : [];
      const buttons = rows.map((row) => row.querySelector('.button.book button, button')).filter(Boolean);
      const bookableCount = rows.filter((row) => row.querySelector('button.buttonAllOk, .buttonAllOk')).length;
      const accountLimitCount = rows.filter((row) => row.querySelector('button.buttonHasReservation, .buttonHasReservation')).length;
      const loginRequiredCount = buttons.filter((button) => /se connecter/i.test(button.textContent ?? '')).length;
      const label = anchor.querySelector('.tennis-label') ?? anchor;
      return {
        venue: (label.textContent ?? '').trim(),
        rowCount: rows.length,
        bookableCount,
        accountLimitCount,
        loginRequiredCount,
        visibleSlotCount: bookableCount + accountLimitCount + loginRequiredCount,
      };
    });

    return {
      noResult: Boolean(document.querySelector('.no-result')),
      venueStates,
    };
  });
}

export async function searchAndRank(page, config, targetIso) {
  await submitAvailabilitySearch(page, config, targetIso);
  const [candidates, searchState] = await Promise.all([
    extractCandidates(page, targetIso),
    extractSearchState(page),
  ]);
  return {
    ...searchState,
    candidates,
    ranked: rankCandidates(candidates, config),
  };
}

export async function clickCandidate(page, candidate) {
  const navigation = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 })
    .catch(() => null);
  const clicked = await page.evaluate((key) => {
    const buttons = [...document.querySelectorAll('button.buttonAllOk, .buttonAllOk')];
    const matchingButton = buttons.find((button) =>
      ['equipmentId', 'courtId', 'dateDeb', 'dateFin'].every((name) => {
        const expected = key[name];
        return expected == null || button.getAttribute(name) === expected;
      }),
    );
    if (!matchingButton) return false;
    matchingButton.scrollIntoView({ block: 'center' });
    matchingButton.click();
    return true;
  }, candidate.bookingKey);

  if (!clicked) return { clicked: false, navigated: false };
  const navigated = Boolean(await navigation);
  if (!navigated) await page.waitForTimeout(2_000);
  return { clicked: true, navigated };
}

async function findVisibleReservationAction(page, pattern) {
  const actions = await page.locator(RESERVATION_ACTION_SELECTOR).evaluateAll((elements) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    return elements.map((element, index) => ({
      index,
      visible: visible(element),
      disabled: Boolean(
        element.disabled
        || element.getAttribute('aria-disabled') === 'true'
        || element.classList.contains('disabled')
        || window.getComputedStyle(element).pointerEvents === 'none'
      ),
      label: [
        element.textContent,
        element.value,
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
    }));
  });
  const match = actions.find((action) => action.visible && pattern.test(normalizeText(action.label)));
  if (!match) return null;
  return {
    ...match,
    locator: page.locator(RESERVATION_ACTION_SELECTOR).nth(match.index),
  };
}

async function clickAndSettle(page, locator) {
  const beforeUrl = page.url();
  const navigation = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  await locator.click();
  const navigated = await Promise.race([
    navigation,
    page.waitForTimeout(1_000).then(() => false),
  ]);
  if (!navigated) await page.waitForTimeout(350);
  return { navigated, urlChanged: page.url() !== beforeUrl };
}

export async function continueAfterHumanVerification(page) {
  const action = await findVisibleReservationAction(
    page,
    /poursuivre la reservation|continuer la reservation|etape suivante/,
  );
  if (!action || action.disabled || !(await action.locator.isEnabled().catch(() => false))) {
    return {
      status: 'waiting',
      message: '请先在浏览器里完成人机验证；验证通过后助手会自动继续。',
    };
  }
  await clickAndSettle(page, action.locator);
  return {
    status: 'progressed',
    message: '人机验证已通过，正在继续预约。',
  };
}

export async function continueToNextReservationStep(page) {
  const action = await findVisibleReservationAction(
    page,
    /etape suivante|poursuivre la reservation|continuer/,
  );
  if (!action || action.disabled || !(await action.locator.isEnabled().catch(() => false))) {
    return {
      status: 'waiting',
      message: '官网的“下一步”尚未启用；浏览器会保持打开供你核对。',
    };
  }
  await clickAndSettle(page, action.locator);
  return {
    status: 'progressed',
    message: '已确认预约规则，正在进入下一步。',
  };
}

async function collectPartnerFields(page) {
  return page.locator(PARTNER_FIELD_SELECTOR).evaluateAll((elements) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const compact = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    return elements.map((element, index) => {
      const labels = [...(element.labels ?? [])].map((label) => compact(label.textContent));
      const nearby = element.closest('.form-group, .form-field, .control-group, .input-group');
      return {
        index,
        visible: visible(element),
        value: element.value,
        descriptor: [
          ...labels,
          compact(element.getAttribute('aria-label')),
          compact(element.getAttribute('placeholder')),
          compact(element.getAttribute('name')),
          compact(element.getAttribute('id')),
          compact(element.getAttribute('autocomplete')),
          labels.length === 0 ? compact(nearby?.textContent) : '',
        ].filter(Boolean).join(' '),
      };
    }).filter((field) => field.visible);
  });
}

function identifyPartnerField(fields, kind) {
  return fields.find((field) => {
    const descriptor = normalizeText(field.descriptor);
    if (/email|courriel|mail/.test(descriptor)) return false;
    if (kind === 'firstName') {
      return /(?:^| )(?:prenom|first name|given name)(?: |$)/.test(descriptor)
        || /prenom|firstname|givenname/.test(descriptor);
    }
    return !/prenom|firstname|givenname/.test(descriptor)
      && (/(?:^| )(?:nom|last name|family name|surname)(?: |$)/.test(descriptor)
        || /nompartenaire|nominvite|lastname|familyname/.test(descriptor));
  });
}

function partnerBlocked(message, reason) {
  return { status: 'blocked', reason, message };
}

export async function fillConfiguredPartner(page, partner = {}) {
  const firstName = String(partner.firstName ?? '').trim();
  const lastName = String(partner.lastName ?? '').trim();
  if (!firstName || !lastName) {
    return partnerBlocked('默认同行者姓名不完整；浏览器会保持打开，请手动填写后继续。', 'partner-not-configured');
  }

  const fields = await collectPartnerFields(page);
  const firstNameField = identifyPartnerField(fields, 'firstName');
  const lastNameField = identifyPartnerField(fields, 'lastName');
  let nextAction = await findVisibleReservationAction(page, /etape suivante|poursuivre la reservation|continuer/);

  if (!firstNameField || !lastNameField) {
    if (nextAction && !nextAction.disabled && await nextAction.locator.isEnabled().catch(() => false)) {
      await clickAndSettle(page, nextAction.locator);
      return { status: 'progressed', message: '同行者已在官网页面中，正在进入下一步。' };
    }
    return partnerBlocked('无法明确识别同行者的姓与名字段；浏览器会保持打开，请手动填写。', 'partner-fields-not-found');
  }

  for (const [field, value, label] of [
    [lastNameField, lastName, '姓'],
    [firstNameField, firstName, '名'],
  ]) {
    if (field.value.trim() && field.value.trim() !== value) {
      return partnerBlocked(`同行者${label}已有人手填写的内容；没有覆盖，请你在浏览器中核对。`, 'partner-field-conflict');
    }
    if (!field.value.trim()) await page.locator(PARTNER_FIELD_SELECTOR).nth(field.index).fill(value);
  }

  // Paris Tennis validates the final active field only after focus leaves it.
  // "Ajouter un partenaire" creates another blank guest row; it does not save
  // the current row, so never click it for a single configured partner.
  const firstNameLocator = page.locator(PARTNER_FIELD_SELECTOR).nth(firstNameField.index);
  const lastNameLocator = page.locator(PARTNER_FIELD_SELECTOR).nth(lastNameField.index);
  await lastNameLocator.blur().catch(() => {});
  await firstNameLocator.blur().catch(() => {});
  const neutralHeading = page.locator('h1, h2').first();
  if (await neutralHeading.isVisible().catch(() => false)) {
    await neutralHeading.click({ position: { x: 2, y: 2 } }).catch(() => {});
  } else {
    await page.evaluate(() => document.activeElement?.blur()).catch(() => {});
  }
  await page.waitForTimeout(250);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    nextAction = await findVisibleReservationAction(page, /etape suivante|poursuivre la reservation|continuer/);
    if (nextAction && !nextAction.disabled && await nextAction.locator.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(250);
  }
  if (!nextAction || nextAction.disabled || !(await nextAction.locator.isEnabled().catch(() => false))) {
    return partnerBlocked('同行者已填写，但官网尚未开放“下一步”；浏览器会保持打开供你核对。', 'partner-next-disabled');
  }

  await clickAndSettle(page, nextAction.locator);
  return {
    status: 'progressed',
    message: `已填写同行者 ${firstName} ${lastName}，正在进入十次卡确认步骤。`,
  };
}

async function collectPaymentPageState(page) {
  return page.evaluate((controlSelector) => {
    const visible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const compact = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const associatedLabels = (element) => {
      const labels = [...(element.labels ?? [])];
      if (element.id) {
        for (const label of document.querySelectorAll('label')) {
          if (label.htmlFor === element.id && !labels.includes(label)) labels.push(label);
        }
      }
      return labels;
    };
    const elementLabel = (element) => {
      const tagName = element.tagName.toLowerCase();
      const inputType = compact(element.getAttribute('type')).toLowerCase();
      const labels = associatedLabels(element);
      const nearestChoice = ['radio', 'checkbox'].includes(inputType)
        ? element.closest('label, .form-check, .radio, .payment-method, .moyen-paiement, li, tr')
        : null;
      const select = tagName === 'option' ? element.parentElement : null;
      const selectLabels = select ? associatedLabels(select) : [];
      return [...new Set([
        compact(element.textContent),
        ['submit', 'button'].includes(inputType) ? compact(element.value) : '',
        compact(element.getAttribute('aria-label')),
        compact(element.getAttribute('title')),
        ...labels.map((label) => compact(label.textContent)),
        ...selectLabels.map((label) => compact(label.textContent)),
        compact(nearestChoice?.textContent),
      ].filter(Boolean))].join(' ').slice(0, 2_000);
    };

    const allControls = [...document.querySelectorAll(controlSelector)];
    const allSelects = [...document.querySelectorAll('select')];
    const controls = allControls.flatMap((element, controlIndex) => {
      const tagName = element.tagName.toLowerCase();
      const inputType = compact(element.getAttribute('type')).toLowerCase();
      const role = compact(element.getAttribute('role')).toLowerCase();
      const isOption = tagName === 'option';
      const host = isOption ? element.parentElement : element;
      const labels = associatedLabels(element);
      const isVisible = visible(host) || labels.some(visible);
      if (!isVisible) return [];

      const isChoice = isOption || ['radio', 'checkbox'].includes(inputType) || role === 'radio';
      const isAction = tagName === 'button' || tagName === 'a' || ['submit', 'button'].includes(inputType) || role === 'button';
      if (!isChoice && !isAction) return [];

      const hostStyle = window.getComputedStyle(host);
      const classNames = compact(host.getAttribute('class')).toLowerCase();
      const parentClassNames = compact(host.parentElement?.getAttribute('class')).toLowerCase();

      return [{
        controlIndex,
        selectIndex: isOption ? allSelects.indexOf(element.parentElement) : null,
        optionIndex: isOption ? [...element.parentElement.options].indexOf(element) : null,
        tagName,
        inputType,
        kind: isChoice ? 'choice' : 'action',
        label: elementLabel(element),
        checked: isOption ? element.selected : Boolean(element.checked || element.getAttribute('aria-checked') === 'true'),
        disabled: Boolean(
          element.disabled
          || element.getAttribute('aria-disabled') === 'true'
          || element.parentElement?.disabled
          || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/.test(classNames)
          || /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/.test(parentClassNames)
          || hostStyle.pointerEvents === 'none'
        ),
      }];
    });

    const fields = [...document.querySelectorAll('input, textarea')]
      .filter((element) => visible(element) && !['hidden', 'radio', 'checkbox', 'submit', 'button'].includes(element.type))
      .map((element) => ({
        name: element.name,
        id: element.id,
        autocomplete: element.autocomplete,
        label: elementLabel(element),
      }));

    return {
      pageText: compact(document.body?.innerText).slice(0, 20_000),
      controls,
      fields,
    };
  }, PAYMENT_CONTROL_SELECTOR);
}

async function activatePaymentControl(page, control) {
  const beforeUrl = page.url();
  const navigation = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (control.tagName === 'option') {
    await page.locator('select').nth(control.selectIndex).selectOption({ index: control.optionIndex });
  } else {
    const locator = page.locator(PAYMENT_CONTROL_SELECTOR).nth(control.controlIndex);
    if (['radio', 'checkbox'].includes(control.inputType)) await locator.check({ force: true });
    else await locator.click();
  }

  const navigated = await Promise.race([
    navigation,
    page.waitForTimeout(1_200).then(() => false),
  ]);
  if (!navigated) await page.waitForTimeout(350);
  return { navigated, urlChanged: page.url() !== beforeUrl };
}

async function findExistingCarnetHourCard(page) {
  const marker = `pt-carnet-hour-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const match = await page.evaluate((attributeValue) => {
    const normalize = (value) => String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const isExactCarnetChoice = (value) => /\bj utilise (?:1|une) heure de mon carnet en ligne\b/.test(normalize(value));
    const unsafe = (value) => /\b(?:acheter|achat|commander|nouvel abonnement|nouveau forfait|recharger|rechargement|souscrire|carte bancaire|payer par carte|numero de carte|cryptogramme|cvv|cvc|visa|mastercard|paypal)\b/.test(normalize(value));
    const matches = [...document.querySelectorAll('body *')]
      .filter((element) => visible(element) && isExactCarnetChoice(element.innerText))
      .sort((left, right) => normalize(left.innerText).length - normalize(right.innerText).length);
    const content = matches[0];
    if (!content || unsafe(content.innerText)) return null;

    let target = content;
    for (let current = content; current && current !== document.body; current = current.parentElement) {
      const tagName = current.tagName.toLowerCase();
      const role = normalize(current.getAttribute('role'));
      const style = window.getComputedStyle(current);
      const clickable = ['button', 'a', 'label'].includes(tagName)
        || ['button', 'radio'].includes(role)
        || current.hasAttribute('onclick')
        || current.tabIndex >= 0
        || style.cursor === 'pointer';
      if (clickable && isExactCarnetChoice(current.innerText) && !unsafe(current.innerText)) {
        target = current;
        break;
      }
    }

    target.setAttribute('data-pt-existing-carnet-hour', attributeValue);
    return {
      label: String(target.innerText ?? content.innerText).replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }, marker);
  if (!match) return null;
  return {
    ...match,
    locator: page.locator(`[data-pt-existing-carnet-hour="${marker}"]`),
  };
}

async function waitForEnabledPaymentConfirmation(page) {
  let action = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    action = await findVisibleReservationAction(page, /etape suivante|confirmer (?:la )?reservation|finaliser|valider/);
    if (action && !action.disabled && await action.locator.isEnabled().catch(() => false)) return action;
    await page.waitForTimeout(250);
  }
  return null;
}

function paymentBlocked(message, reason) {
  return { status: 'blocked', reason, message };
}

export async function useExistingPassOnly(page, { maxPriceEuros }) {
  let state = await collectPaymentPageState(page);
  if (hasVisibleCardField(state.fields)) {
    return paymentBlocked('页面已进入银行卡填写流程；为避免扣卡或充值，任务已停止。', 'card-fields-visible');
  }
  if (hasInsufficientBalanceText(state.pageText)) {
    return paymentBlocked('官网提示套餐余额不足、不可用或已过期；没有改用其他付款方式。', 'insufficient-balance');
  }

  const implicitExistingPass = hasExistingPassDebitConfirmation(state.pageText);
  const explicitCarnetHourCard = hasExistingCarnetHourChoice(state.pageText);
  const passOption = chooseExistingPassOption(state.controls, {
    pageText: state.pageText,
    maxPriceEuros,
  });
  if (!passOption && !implicitExistingPass && !explicitCarnetHourCard) {
    return paymentBlocked('付款页没有可安全识别的已有 Abonnement 10h 余额；没有购买、充值或使用银行卡。', 'pass-not-found');
  }

  let passLabel = passOption?.label
    ?? (explicitCarnetHourCard
      ? 'J’utilise 1 heure de mon carnet en ligne'
      : 'Carnet existant（官网显示扣除 1h 后仍有余额）');
  let carnetCardSelected = false;
  if (passOption && !passOption.checked) {
    await activatePaymentControl(page, passOption);
    if (page.isClosed()) return paymentBlocked('付款窗口在确认前关闭。', 'closed');
    state = await collectPaymentPageState(page);
  } else if (!passOption && explicitCarnetHourCard) {
    let confirmation = chooseConfirmationAction(state.controls);
    if (!confirmation) {
      const card = await findExistingCarnetHourCard(page);
      if (!card) {
        return paymentBlocked('已看到“使用 carnet 1 小时”，但无法安全定位它的可点击卡片；没有猜测点击。', 'carnet-card-not-clickable');
      }
      await clickAndSettle(page, card.locator);
      if (page.isClosed()) return paymentBlocked('选择 carnet 1 小时时付款窗口关闭。', 'closed');
      passLabel = card.label || passLabel;
      confirmation = await waitForEnabledPaymentConfirmation(page);
      if (!confirmation) {
        return paymentBlocked('已点击“使用 carnet 1 小时”，但官网的“下一步”没有变为可用；没有继续。', 'carnet-card-not-selected');
      }
    }
    carnetCardSelected = true;
    state = await collectPaymentPageState(page);
  }

  if (hasVisibleCardField(state.fields)) {
    return paymentBlocked('选择套餐后出现了银行卡字段；没有继续提交。', 'card-fields-visible');
  }
  if (hasInsufficientBalanceText(state.pageText)) {
    return paymentBlocked('选择套餐后官网提示余额不足或不可用；没有改用其他付款方式。', 'insufficient-balance');
  }

  const selectedPass = chooseExistingPassOption(
    state.controls.filter((control) => control.checked),
    { pageText: state.pageText, maxPriceEuros },
  );
  if (selectedPass) passLabel = selectedPass.label;

  const confirmation = chooseConfirmationAction(state.controls);
  if (!confirmation) {
    if (passOption?.kind === 'action') {
      return {
        status: 'progressed',
        message: '已选择已有 Abonnement 10h；正在检查官网返回结果。',
        passLabel,
      };
    }
    return paymentBlocked('已找到十次卡余额，但无法明确识别安全的确认按钮；没有猜测点击。', 'confirmation-not-found');
  }

  if (!implicitExistingPass && !selectedPass && !carnetCardSelected && passOption?.kind !== 'action') {
    return paymentBlocked('十次卡选项未能保持选中；没有提交付款。', 'selection-not-verified');
  }

  await activatePaymentControl(page, confirmation);
  const advancedToFinalReview = /\betape suivante\b/.test(normalizeText(confirmation.label));
  return {
    status: advancedToFinalReview ? 'progressed' : 'submitted',
    message: advancedToFinalReview
      ? '已选择使用 carnet 1 小时并进入最终确认步骤。'
      : '已仅使用现有 Abonnement 10h 余额提交预约确认。',
    passLabel,
    existingPassSelected: true,
  };
}

export async function confirmFinalReservationReview(page, { existingPassSelected = false } = {}) {
  if (!existingPassSelected) {
    return paymentBlocked('尚未验证本次预约已选择现有 carnet 余额；没有点击最终确认。', 'pass-selection-unverified');
  }

  const state = await collectPaymentPageState(page);
  if (hasVisibleCardField(state.fields)) {
    return paymentBlocked('最终确认页出现了银行卡字段；没有继续提交。', 'card-fields-visible');
  }
  if (hasInsufficientBalanceText(state.pageText)) {
    return paymentBlocked('最终确认页提示 carnet 余额不足或不可用；没有继续提交。', 'insufficient-balance');
  }

  const pageText = normalizeText(state.pageText);
  if (!/\b3 3\b.{0,80}\bconfirmation\b|\bconfirmation de votre reservation\b/.test(pageText)) {
    return paymentBlocked('当前页面不是可明确识别的 3/3 最终确认页；没有猜测点击。', 'final-review-not-recognized');
  }

  const action = await findVisibleReservationAction(
    page,
    /\b(?:confirmer|confirme|valider|finaliser)\b|validation definitive/,
  );
  if (!action || action.disabled || !(await action.locator.isEnabled().catch(() => false))) {
    return paymentBlocked('最终“确认预约”按钮尚未启用；浏览器会保持打开供你核对。', 'final-confirmation-disabled');
  }

  await clickAndSettle(page, action.locator);
  return {
    status: 'submitted',
    message: '已在 3/3 页面点击最终确认，正在等待官网返回成功结果。',
  };
}

export async function assessReservationPage(page) {
  if (page.isClosed()) return { stage: 'closed', message: '浏览器窗口已关闭。' };
  let state = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      state = await page.evaluate(() => {
        const visible = (element) => {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const text = document.body?.innerText?.replace(/\s+/g, ' ').trim() ?? '';
        const visibleCaptcha = [...document.querySelectorAll('iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i]')]
          .some(visible);
        const visibleInputs = [...document.querySelectorAll('input, select, textarea')]
          .filter(visible)
          .map((element) => `${element.name ?? ''} ${element.id ?? ''} ${element.getAttribute('aria-label') ?? ''}`)
          .join(' ');
        const visibleActions = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, [role="button"]')]
          .filter(visible)
          .map((element) => `${element.textContent ?? ''} ${element.value ?? ''} ${element.getAttribute('aria-label') ?? ''}`)
          .join(' ');
        return { text: text.slice(0, 12_000), visibleCaptcha, visibleInputs, visibleActions };
      });
      break;
    } catch (error) {
      if (!isTransientNavigationError(error)) throw error;
      if (!(await waitForStableDocument(page, 250))) {
        return { stage: 'closed', message: '当前预约页面已关闭，正在寻找后续页面。' };
      }
    }
  }

  if (!state) {
    return { stage: 'transitioning', message: '官网正在切换预约步骤，助手会等待新页面加载。' };
  }

  const url = page.url();

  if (url.includes('v70-auth.paris.fr')) {
    return { stage: 'auth-required', message: '登录会话已过期，需要重新登录。' };
  }
  const normalizedState = normalizeText(`${state.text} ${state.visibleInputs}`);
  const normalizedActions = normalizeText(state.visibleActions ?? '');
  const hasPendingFinalConfirmation = /\b(?:confirmer|confirme|valider|finaliser)\b|validation definitive/.test(normalizedActions);
  const isFinalReview = /\b3 3\b.{0,80}\bconfirmation\b|\bconfirmation de votre reservation\b/.test(normalizedState)
    && hasPendingFinalConfirmation;
  if (isFinalReview) {
    return { stage: 'final-review', message: '已进入 3/3 最终确认页，正在确认使用已有 carnet 的预约。' };
  }
  if (/reservation.{0,50}(confirmee|validee|enregistree)|votre reservation a bien ete (?:confirmee|validee|enregistree)|paiement.{0,30}(accepte|valide)/.test(normalizedState)
    || (/confirmation de votre reservation/.test(normalizedState) && !hasPendingFinalConfirmation)) {
    return { stage: 'confirmed', message: '页面显示预约已确认。' };
  }
  if (state.visibleCaptcha || /captcha|verification.{0,20}(humaine|securite)|bloquons les robots|agir a votre place/.test(normalizedState)) {
    return { stage: 'captcha', message: '请在打开的浏览器中完成人机验证；通过后助手会自动继续。' };
  }
  if (/coordonnees de vos partenaires|identite de vos invites|ajouter un partenaire|ajouter un invite/.test(normalizedState)) {
    return { stage: 'guest', message: '正在填写已保存的默认同行者。' };
  }
  if (/points de reglement/.test(normalizedState) && /etape suivante/.test(normalizedState)) {
    return { stage: 'rules', message: '官网已显示预约规则与十次卡扣除说明，正在进入下一步。' };
  }
  if (looksLikePaymentPage(`${state.text} ${state.visibleInputs}`)) {
    return { stage: 'payment', message: '检测到付款步骤；将仅尝试已有 Abonnement 10h 余额。' };
  }
  if (/reserver|valider|confirmer/.test(normalizedState)) {
    return { stage: 'review', message: '预约详情已打开，请你核对并确认。' };
  }
  return { stage: 'unknown', message: '已打开下一步；页面结构未知，请你接管。' };
}
