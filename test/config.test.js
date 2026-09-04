import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, validateConfig } from '../src/config.js';

test('enforces the official weekly limit and existing-pass-only payment policy', () => {
  const config = normalizeConfig({
    payment: {
      strategy: 'card',
      preferredPass: 'Anything else',
    },
    safety: {
      maxBookingsPerWeek: 99,
      requireHumanForCaptcha: false,
      autoConfirmExistingPass: false,
      allowCardPayment: true,
      allowPassPurchase: true,
      allowBalanceTopUp: true,
    },
  });
  assert.deepEqual(config.payment, {
    strategy: 'existing-pass-only',
    preferredPass: 'Abonnement 10h',
  });
  assert.deepEqual(config.safety, {
    maxBookingsPerWeek: 2,
    requireHumanForCaptcha: true,
    requireHumanForGuest: false,
    autoFillConfiguredPartner: true,
    autoConfirmExistingPass: true,
    allowCardPayment: false,
    allowPassPurchase: false,
    allowBalanceTopUp: false,
  });
});

test('an armed configuration requires a place, weekday, and time', () => {
  const config = normalizeConfig({ armed: true, postalCodes: [], venuePreferences: [], targetWeekdays: [], timePriority: [] });
  assert.equal(validateConfig(config).length, 3);
});

test('cleans postal codes, venue-bound courts, and whole-hour times', () => {
  const config = normalizeConfig({
    postalCodes: ['75015', '75015', '75000', '69001'],
    venuePreferences: [
      { venue: 'Atlantique', courts: ['3', 1, '3', 0, 120, 'not-a-number'] },
      { venue: 'Atlantique', courts: [2] },
      { venue: 'Suzanne Lenglen', courts: [8] },
    ],
    timePriority: ['18:00', '18:30', '21:00'],
  });
  assert.deepEqual(config.postalCodes, ['75015']);
  assert.deepEqual(config.venuePreferences, [
    { venue: 'Atlantique', courts: [3, 1] },
    { venue: 'Suzanne Lenglen', courts: [8] },
  ]);
  assert.deepEqual(config.timePriority, ['18:00', '21:00']);
});

test('migrates legacy global court preferences onto each existing venue', () => {
  const config = normalizeConfig({
    venuePriority: ['Atlantique', 'Suzanne Lenglen'],
    courtPriority: [3, 1],
  });
  assert.deepEqual(config.venuePreferences, [
    { venue: 'Atlantique', courts: [3, 1] },
    { venue: 'Suzanne Lenglen', courts: [3, 1] },
  ]);
});

test('uses twenty attempts for an all-empty availability result', () => {
  assert.equal(normalizeConfig({}).release.noAvailabilityAttempts, 20);
  assert.equal(normalizeConfig({ release: { noAvailabilityAttempts: 99 } }).release.noAvailabilityAttempts, 30);
});

test('stores only trimmed default partner names', () => {
  const config = normalizeConfig({
    partner: {
      firstName: '  alex  ',
      lastName: '  morgan  ',
    },
  });
  assert.deepEqual(config.partner, { firstName: 'alex', lastName: 'morgan' });
  assert.equal(config.version, 5);
});
