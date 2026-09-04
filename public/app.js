import { translations } from './i18n.js';

const form = document.querySelector('#settingsForm');
const toast = document.querySelector('#toast');
const loginButton = document.querySelector('#loginButton');
const testButton = document.querySelector('#testButton');
const realRunButton = document.querySelector('#realRunButton');
const saveButton = document.querySelector('#saveButton');
const testButtonLabel = testButton.querySelector('span');
const testButtonHint = testButton.querySelector('small');
const realRunButtonLabel = realRunButton.querySelector('span');
const realRunButtonHint = realRunButton.querySelector('small');
const venuePreferenceList = document.querySelector('#venuePreferenceList');
const addVenueButton = document.querySelector('#addVenueButton');
const runFeedback = document.querySelector('#runFeedback');
const languageSwitcher = document.querySelector('.language-switcher');
const LANGUAGE_STORAGE_KEY = 'paris-tennis-language';
let currentConfig = null;
let toastTimer = null;
let pendingRun = null;
let runDeadline = null;
let notifiedRunnerKey = null;
let latestStatus = null;
let currentLanguage = (() => {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
})();

function t(key, variables = {}) {
  let value = translations[currentLanguage]?.[key] ?? translations.en[key] ?? key;
  for (const [name, replacement] of Object.entries(variables)) {
    value = value.split(`{${name}}`).join(String(replacement ?? ''));
  }
  return value;
}

function statusLabel(code) {
  return translations[currentLanguage]?.[`status_${code}`]
    ?? translations.en[`status_${code}`]
    ?? code;
}

function localizeRunnerMessage(runner) {
  if (!runner) return '';
  const rawMessage = String(runner.message ?? '').split('\n')[0];
  if (currentLanguage === 'zh') return rawMessage || statusLabel(runner.code);
  if (runner.code === 'ACTION_REQUIRED' && runner.stage === 'captcha') return t('captchaAction');
  const key = `runner_${runner.code}`;
  return (translations.en[key] ?? statusLabel(runner.code))
    .split('{date}')
    .join(runner.targetDate ?? runner.candidate?.dateIso ?? 'the target date');
}

function applyLanguage() {
  document.documentElement.lang = currentLanguage === 'zh' ? 'zh-CN' : 'en';
  document.title = t('pageTitle');
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll('[data-i18n-html]')) {
    element.innerHTML = t(element.dataset.i18nHtml);
  }
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }
  for (const element of document.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  }
  for (const button of document.querySelectorAll('[data-language]')) {
    button.setAttribute('aria-pressed', String(button.dataset.language === currentLanguage));
  }
  syncVenuePreferenceRows();
  if (latestStatus) renderStatus(latestStatus);
  else setRunButtonsState(false);
}

const runningCodes = new Set([
  'STARTING',
  'VERIFYING_AVAILABILITY',
  'ACTION_REQUIRED',
  'RESERVATION_CONTINUING',
  'PARTNER_PROCESSING',
  'PARTNER_SUBMITTED',
  'PAYMENT_PROCESSING',
  'PAYMENT_SUBMITTED',
  'FINAL_CONFIRMATION_PROCESSING',
  'FINAL_CONFIRMATION_SUBMITTED',
]);
const failureCodes = new Set([
  'ERROR',
  'AUTH_REQUIRED',
  'CONFIG_REQUIRED',
  'PAYMENT_BLOCKED',
  'SITE_UNSTABLE',
  'SITE_CHANGED',
  'TAKEOVER_TIMEOUT',
  'TAKEOVER_CLOSED',
]);

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast show${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.details?.join(' ') || value.error || t('requestFailed'));
  return value;
}

function splitValues(value) {
  return [...new Set(value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean))];
}

function createVenuePreferenceRow(preference = {}) {
  const row = document.createElement('div');
  row.className = 'venue-preference-row';

  const rank = document.createElement('span');
  rank.className = 'venue-preference-rank';

  const venueLabel = document.createElement('label');
  venueLabel.className = 'venue-input-group';
  const venueCaption = document.createElement('span');
  venueCaption.className = 'mobile-field-label';
  venueCaption.textContent = t('venueName');
  const venueInput = document.createElement('input');
  venueInput.className = 'venue-name';
  venueInput.placeholder = t('venuePlaceholder');
  venueInput.autocomplete = 'off';
  venueInput.value = preference.venue ?? '';
  venueLabel.append(venueCaption, venueInput);

  const courtLabel = document.createElement('label');
  courtLabel.className = 'venue-input-group';
  const courtCaption = document.createElement('span');
  courtCaption.className = 'mobile-field-label';
  courtCaption.textContent = t('venueCourtsCaption');
  const courtInput = document.createElement('input');
  courtInput.className = 'venue-courts';
  courtInput.placeholder = t('courtsPlaceholder');
  courtInput.inputMode = 'numeric';
  courtInput.value = (preference.courts ?? []).join(', ');
  courtLabel.append(courtCaption, courtInput);

  const actions = document.createElement('div');
  actions.className = 'venue-row-actions';
  for (const [action, symbol, labelKey] of [
    ['up', '↑', 'moveUp'],
    ['down', '↓', 'moveDown'],
    ['remove', '×', 'remove'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `venue-row-button ${action === 'remove' ? 'remove' : ''}`;
    button.dataset.action = action;
    button.textContent = symbol;
    button.title = t(labelKey);
    actions.append(button);
  }

  row.append(rank, venueLabel, courtLabel, actions);
  return row;
}

function syncVenuePreferenceRows() {
  const rows = [...venuePreferenceList.querySelectorAll('.venue-preference-row')];
  rows.forEach((row, index) => {
    row.querySelector('.venue-preference-rank').textContent = String(index + 1).padStart(2, '0');
    row.querySelector('.venue-input-group:first-of-type .mobile-field-label').textContent = t('venueName');
    row.querySelector('.venue-name').placeholder = t('venuePlaceholder');
    row.querySelector('.venue-input-group:nth-of-type(2) .mobile-field-label').textContent = t('venueCourtsCaption');
    row.querySelector('.venue-courts').placeholder = t('courtsPlaceholder');
    const upButton = row.querySelector('[data-action="up"]');
    const downButton = row.querySelector('[data-action="down"]');
    const removeButton = row.querySelector('[data-action="remove"]');
    upButton.disabled = index === 0;
    upButton.title = t('moveUp');
    downButton.disabled = index === rows.length - 1;
    downButton.title = t('moveDown');
    removeButton.title = t('remove');
    removeButton.setAttribute('aria-label', t('removeVenueAria', { index: index + 1 }));
  });
  addVenueButton.disabled = rows.length >= 20;
}

function renderVenuePreferences(preferences = []) {
  const rows = preferences.length > 0 ? preferences : [{}];
  venuePreferenceList.replaceChildren(...rows.map(createVenuePreferenceRow));
  syncVenuePreferenceRows();
}

function fillForm(config) {
  document.querySelector('#postalCodes').value = config.postalCodes.join(', ');
  renderVenuePreferences(config.venuePreferences);
  document.querySelector('#coveredPreference').value = config.coveredPreference;
  document.querySelector('#surfaceKeywords').value = config.surfaceKeywords.join(', ');
  document.querySelector('#timePriority').value = config.timePriority.join(', ');
  document.querySelector('#maxPriceEuros').value = config.maxPriceEuros;
  document.querySelector('#partnerFirstName').value = config.partner?.firstName ?? '';
  document.querySelector('#partnerLastName').value = config.partner?.lastName ?? '';
  document.querySelector('#armed').checked = config.armed;
  for (const input of document.querySelectorAll('#weekdayRow input')) {
    input.checked = config.targetWeekdays.includes(Number(input.value));
  }
  const mode = document.querySelector(`input[name="mode"][value="${config.mode}"]`);
  if (mode) mode.checked = true;
}

function gatherConfig() {
  const venuePreferences = [...venuePreferenceList.querySelectorAll('.venue-preference-row')]
    .map((row) => ({
      venue: row.querySelector('.venue-name').value.trim(),
      courts: splitValues(row.querySelector('.venue-courts').value).map(Number),
    }))
    .filter((preference) => preference.venue);

  return {
    ...currentConfig,
    armed: document.querySelector('#armed').checked,
    mode: document.querySelector('input[name="mode"]:checked')?.value ?? 'monitor',
    postalCodes: splitValues(document.querySelector('#postalCodes').value),
    venuePreferences,
    targetWeekdays: [...document.querySelectorAll('#weekdayRow input:checked')].map((input) => Number(input.value)),
    timePriority: splitValues(document.querySelector('#timePriority').value),
    maxPriceEuros: Number(document.querySelector('#maxPriceEuros').value),
    partner: {
      firstName: document.querySelector('#partnerFirstName').value.trim(),
      lastName: document.querySelector('#partnerLastName').value.trim(),
    },
    coveredPreference: document.querySelector('#coveredPreference').value,
    surfaceKeywords: splitValues(document.querySelector('#surfaceKeywords').value),
  };
}

function formatUpdatedAt(value) {
  if (!value) return t('noRunsYet');
  return new Intl.DateTimeFormat(currentLanguage === 'zh' ? 'zh-CN' : 'en-GB', {
    timeZone: 'Europe/Paris',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function setRunButtonsState(running, kind = null) {
  testButton.disabled = running;
  realRunButton.disabled = running;
  testButtonLabel.textContent = t(running && kind === 'dry' ? 'testSearchRunning' : 'testSearch');
  testButtonHint.textContent = t(running && kind === 'dry' ? 'testSearchRunningHint' : 'testSearchHint');
  realRunButtonLabel.textContent = t(running && kind === 'live' ? 'realBookingRunning' : 'realBooking');
  realRunButtonHint.textContent = t(running && kind === 'live' ? 'realBookingRunningHint' : 'realBookingHint');
}

function renderRunFeedback(runner) {
  if (!runner) {
    runFeedback.hidden = true;
    return;
  }
  const running = runningCodes.has(runner.code);
  const failure = failureCodes.has(runner.code);
  runFeedback.hidden = false;
  runFeedback.className = `run-feedback ${running ? 'running' : failure ? 'error' : 'success'}`;
  const runKind = runner.dryRun ? t('runKindDry') : runner.manualLive ? t('runKindLive') : t('runKindAutomatic');
  document.querySelector('#runFeedbackTitle').textContent = `${runKind} · ${statusLabel(runner.code)}`;
  document.querySelector('#runFeedbackTime').textContent = formatUpdatedAt(runner.updatedAt);
  document.querySelector('#runFeedbackMessage').textContent = localizeRunnerMessage(runner);
}

function renderCandidates(runner) {
  const candidates = runner?.candidates ?? (runner?.candidate ? [runner.candidate] : []);
  const panel = document.querySelector('#resultsPanel');
  const list = document.querySelector('#resultList');
  if (!candidates.length) {
    panel.hidden = true;
    list.replaceChildren();
    return;
  }

  panel.hidden = false;
  const resultMeta = [];
  if (runner.targetDate) resultMeta.push(t('targetDate', { date: runner.targetDate }));
  const verificationCount = runner.verification?.attempts?.length ?? 0;
  if (runner.verification?.refreshed && verificationCount > 1) {
    resultMeta.push(t('resultsRechecked', { count: verificationCount }));
  }
  document.querySelector('#resultMeta').textContent = resultMeta.join(' · ');
  list.replaceChildren(
    ...candidates.slice(0, 8).map((candidate, index) => {
      const item = document.createElement('article');
      item.className = 'result-item';
      const rank = document.createElement('span');
      rank.className = 'result-rank';
      rank.textContent = String(candidate.rank ?? index + 1).padStart(2, '0');
      const venue = document.createElement('div');
      const venueName = document.createElement('strong');
      venueName.textContent = candidate.venue ?? t('unknownVenue');
      const availability = document.createElement('small');
      availability.textContent = t(candidate.availability === 'bookable' ? 'bookable' : 'confirmAfterLogin');
      venue.append(venueName, availability);
      const court = document.createElement('div');
      court.className = 'result-court';
      const courtName = document.createElement('strong');
      courtName.textContent = `${candidate.time ?? candidate.timeLabel ?? '—'} · ${candidate.court ?? ''}`;
      const detail = document.createElement('small');
      detail.textContent = candidate.indoorOutdoor ?? '';
      court.append(courtName, detail);
      const price = document.createElement('span');
      price.className = 'result-price';
      price.textContent = Number.isFinite(candidate.priceEuros) ? `${candidate.priceEuros} €` : candidate.priceLabel ?? '—';
      item.append(rank, venue, court, price);
      return item;
    }),
  );
}

function renderStatus(status, { preserveForm = true } = {}) {
  latestStatus = status;
  currentConfig = status.config;
  if (!preserveForm) fillForm(status.config);

  const authStatus = document.querySelector('#authStatus');
  authStatus.textContent = status.authenticated
    ? t('connected')
    : translations[currentLanguage]?.[`login_${status.login?.code}`] ?? t('notLoggedIn');
  authStatus.title = translations[currentLanguage]?.[`loginMessage_${status.authenticated ? 'AUTHENTICATED' : status.login?.code}`] ?? '';
  document.querySelector('#authIcon').classList.toggle('ready', status.authenticated);
  loginButton.textContent = status.authenticated ? t('logInAgain') : status.login?.code === 'ERROR' ? t('retryLogin') : t('logIn');
  document.querySelector('#armedStatus').textContent = t(status.config.armed ? 'enabled' : 'notEnabled');
  document.querySelector('#modeStatus').textContent = t(status.config.mode === 'assist' ? 'autoPass' : 'monitor');

  const runner = status.runner;
  document.querySelector('#runStatus').textContent = runner ? `${statusLabel(runner.code)} · ${formatUpdatedAt(runner.updatedAt)}` : t('noRunsYet');
  document.querySelector('#runMessage').textContent = localizeRunnerMessage(runner);
  renderRunFeedback(runner);
  renderCandidates(runner);

  const runnerTime = runner?.updatedAt ? new Date(runner.updatedAt).getTime() : 0;
  const pendingResultArrived = pendingRun && runnerTime >= pendingRun.requestedAt;
  if (pendingResultArrived && !runningCodes.has(runner?.code)) {
    const completedRun = pendingRun;
    pendingRun = null;
    clearTimeout(runDeadline);
    const runnerKey = `${runner.code}:${runner.updatedAt}`;
    if (notifiedRunnerKey !== runnerKey) {
      notifiedRunnerKey = runnerKey;
      const label = t(completedRun.kind === 'live' ? 'runKindLive' : 'runKindDry');
      showToast(`${label}: ${localizeRunnerMessage(runner)}`, failureCodes.has(runner.code));
    }
  }
  const running = Boolean(pendingRun) || runningCodes.has(runner?.code);
  const runKind = pendingRun?.kind ?? (runner?.dryRun ? 'dry' : 'live');
  setRunButtonsState(running, runKind);

}

async function refreshStatus(options) {
  const status = await api('/api/status');
  renderStatus(status, options);
  return status;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  try {
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify(gatherConfig()) });
    currentConfig = result.config;
    renderStatus(await api('/api/status'));
    showToast(t('settingsSaved'));
  } catch (error) {
    showToast(error.message, true);
  } finally {
    saveButton.disabled = false;
  }
});

loginButton.addEventListener('click', async () => {
  loginButton.disabled = true;
  try {
    await api('/api/login', { method: 'POST', body: '{}' });
    showToast(t('loginWindowOpened'));
    await refreshStatus();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setTimeout(() => { loginButton.disabled = false; }, 2500);
  }
});

addVenueButton.addEventListener('click', () => {
  if (venuePreferenceList.children.length >= 20) return;
  const row = createVenuePreferenceRow();
  venuePreferenceList.append(row);
  syncVenuePreferenceRows();
  row.querySelector('.venue-name').focus();
});

venuePreferenceList.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('.venue-preference-row');
  if (button.dataset.action === 'up') row.previousElementSibling?.before(row);
  if (button.dataset.action === 'down') row.nextElementSibling?.after(row);
  if (button.dataset.action === 'remove') {
    if (venuePreferenceList.children.length === 1) {
      row.querySelector('.venue-name').value = '';
      row.querySelector('.venue-courts').value = '';
    } else {
      row.remove();
    }
  }
  syncVenuePreferenceRows();
});

async function startRun(kind) {
  const live = kind === 'live';
  if (live && !window.confirm(t('liveConfirmation'))) return;

  const requestedAt = Date.now();
  pendingRun = { kind, requestedAt };
  setRunButtonsState(true, kind);
  renderRunFeedback({
    code: 'STARTING',
    dryRun: !live,
    manualLive: live,
    updatedAt: new Date().toISOString(),
    message: t(live ? 'liveStarting' : 'dryStarting'),
  });
  try {
    const saved = await api('/api/config', { method: 'POST', body: JSON.stringify(gatherConfig()) });
    currentConfig = saved.config;
    await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({ dryRun: !live, confirmLiveBooking: live }),
    });
    showToast(t(live ? 'liveLaunched' : 'dryLaunched'));
    setTimeout(() => refreshStatus().catch(() => {}), 500);
    runDeadline = setTimeout(async () => {
      if (pendingRun?.requestedAt !== requestedAt) return;
      pendingRun = null;
      await refreshStatus().catch(() => {});
      showToast(t(live ? 'liveStillRunning' : 'dryStillRunning'), true);
    }, live ? 17 * 60_000 : 3 * 60_000);
  } catch (error) {
    pendingRun = null;
    setRunButtonsState(false);
    showToast(error.message, true);
  }
}

testButton.addEventListener('click', () => startRun('dry'));
realRunButton.addEventListener('click', () => startRun('live'));

languageSwitcher.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-language]');
  if (!button || button.dataset.language === currentLanguage) return;
  currentLanguage = button.dataset.language;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, currentLanguage);
  } catch {
    // Language still changes for this page when storage is unavailable.
  }
  applyLanguage();
});

applyLanguage();

try {
  await refreshStatus({ preserveForm: false });
  setInterval(() => refreshStatus().catch(() => {}), 1_000);
} catch (error) {
  showToast(t('localServiceUnavailable', { message: error.message }), true);
}
