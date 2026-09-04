import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_PATH, DATA_DIR } from './paths.js';

export const DEFAULT_CONFIG = Object.freeze({
  version: 5,
  armed: false,
  mode: 'assist',
  postalCodes: [],
  venuePreferences: [],
  targetWeekdays: [1, 2, 3, 4, 5, 6, 0],
  timePriority: ['18:00', '19:00', '20:00', '21:00'],
  maxPriceEuros: 12,
  coveredPreference: 'any',
  surfaceKeywords: [],
  release: {
    targetOffsetDays: 6,
    waitSeconds: 45,
    retryIntervalSeconds: 3,
    searchAttempts: 3,
    noAvailabilityAttempts: 20,
  },
  browser: {
    headless: false,
    takeoverMinutes: 15,
  },
  partner: {
    firstName: '',
    lastName: '',
  },
  payment: {
    strategy: 'existing-pass-only',
    preferredPass: 'Abonnement 10h',
  },
  safety: {
    maxBookingsPerWeek: 2,
    requireHumanForCaptcha: true,
    requireHumanForGuest: false,
    autoFillConfiguredPartner: true,
    autoConfirmExistingPass: true,
    allowCardPayment: false,
    allowPassPurchase: false,
    allowBalanceTopUp: false,
  },
});

function cleanStringArray(value, maximum = 20) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, maximum);
}

function cleanIntegerArray(value, maximum = 20) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item) && item >= 1 && item <= 99))]
    .slice(0, maximum);
}

function cleanVenuePreferences(input) {
  const legacyCourts = cleanIntegerArray(input.courtPriority, 20);
  const source = Array.isArray(input.venuePreferences)
    ? input.venuePreferences
    : cleanStringArray(input.venuePriority, 20).map((venue) => ({ venue, courts: legacyCourts }));
  const seen = new Set();
  const preferences = [];

  for (const item of source) {
    const venue = String(typeof item === 'string' ? item : item?.venue ?? '').trim();
    const key = venue.toLocaleLowerCase('fr');
    if (!venue || seen.has(key)) continue;
    seen.add(key);
    preferences.push({
      venue,
      courts: cleanIntegerArray(typeof item === 'string' ? [] : item?.courts, 20),
    });
    if (preferences.length === 20) break;
  }

  return preferences;
}

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function clampNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function cleanPersonName(value, maximum = 80) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maximum);
}

export function normalizeConfig(input = {}) {
  const release = input.release ?? {};
  const browser = input.browser ?? {};
  const partner = input.partner ?? {};
  const postalCodes = cleanStringArray(input.postalCodes, 5).filter((value) => /^750(?:0[1-9]|1\d|20)$/.test(value));
  const venuePreferences = cleanVenuePreferences(input);
  const weekdays = Array.isArray(input.targetWeekdays)
    ? [...new Set(input.targetWeekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [...DEFAULT_CONFIG.targetWeekdays];
  const timePriority = cleanStringArray(input.timePriority, 15).filter((value) => /^(?:0[89]|1\d|2[0-1]):00$/.test(value));

  return {
    version: 5,
    armed: input.armed === true,
    mode: input.mode === 'monitor' ? 'monitor' : 'assist',
    postalCodes,
    venuePreferences,
    targetWeekdays: weekdays,
    timePriority,
    maxPriceEuros: clampNumber(input.maxPriceEuros, 0, 50, DEFAULT_CONFIG.maxPriceEuros),
    coveredPreference: ['any', 'covered', 'outdoor'].includes(input.coveredPreference)
      ? input.coveredPreference
      : 'any',
    surfaceKeywords: cleanStringArray(input.surfaceKeywords, 10),
    release: {
      targetOffsetDays: clampInteger(release.targetOffsetDays, 1, 7, DEFAULT_CONFIG.release.targetOffsetDays),
      waitSeconds: clampInteger(release.waitSeconds, 0, 90, DEFAULT_CONFIG.release.waitSeconds),
      retryIntervalSeconds: clampInteger(
        release.retryIntervalSeconds,
        2,
        15,
        DEFAULT_CONFIG.release.retryIntervalSeconds,
      ),
      searchAttempts: clampInteger(release.searchAttempts, 1, 5, DEFAULT_CONFIG.release.searchAttempts),
      noAvailabilityAttempts: clampInteger(
        release.noAvailabilityAttempts,
        1,
        30,
        DEFAULT_CONFIG.release.noAvailabilityAttempts,
      ),
    },
    browser: {
      headless: browser.headless === true,
      takeoverMinutes: clampInteger(browser.takeoverMinutes, 5, 30, DEFAULT_CONFIG.browser.takeoverMinutes),
    },
    partner: {
      firstName: cleanPersonName(partner.firstName),
      lastName: cleanPersonName(partner.lastName),
    },
    payment: {
      // This is intentionally not configurable: only a pass the account already owns may be debited.
      strategy: 'existing-pass-only',
      preferredPass: 'Abonnement 10h',
    },
    safety: {
      // Paris Tennis's published limit is two one-hour reservations per week.
      maxBookingsPerWeek: 2,
      requireHumanForCaptcha: true,
      requireHumanForGuest: false,
      autoFillConfiguredPartner: true,
      autoConfirmExistingPass: true,
      allowCardPayment: false,
      allowPassPurchase: false,
      allowBalanceTopUp: false,
    },
  };
}

export function validateConfig(config, { requireRunnable = false } = {}) {
  const errors = [];
  if ((requireRunnable || config.armed) && config.postalCodes.length === 0 && config.venuePreferences.length === 0) {
    errors.push('请至少填写一个巴黎邮编或一个球场名称。');
  }
  if ((requireRunnable || config.armed) && config.targetWeekdays.length === 0) {
    errors.push('请至少选择一个目标星期。');
  }
  if ((requireRunnable || config.armed) && config.timePriority.length === 0) {
    errors.push('请至少填写一个整点时段（08:00–21:00）。');
  }
  if (config.armed && config.mode === 'assist' && config.browser.headless) {
    errors.push('协助预约模式必须打开可见浏览器，以便在官网要求时完成人机验证或同行者核对。');
  }
  if (config.postalCodes.length + Math.min(config.venuePreferences.length, config.postalCodes.length ? 0 : 5) > 5) {
    errors.push('Paris Tennis 每次搜索最多接受 5 个地点。');
  }
  return errors;
}

export async function ensureDataDirectories() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
}

export async function loadConfig() {
  await ensureDataDirectories();
  try {
    const input = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    return normalizeConfig(input);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const initial = normalizeConfig(DEFAULT_CONFIG);
    await saveConfig(initial);
    return initial;
  }
}

export async function saveConfig(input) {
  await ensureDataDirectories();
  const config = normalizeConfig(input);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    const error = new Error(errors.join(' '));
    error.validationErrors = errors;
    throw error;
  }

  const temporaryPath = path.join(DATA_DIR, `.config-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, CONFIG_PATH);
  return config;
}
