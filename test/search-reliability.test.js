import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessSearchReliability,
  searchAttemptLimit,
  summarizeSearchAttempt,
  usableRankedCandidates,
} from '../src/search-reliability.js';

const config = {
  postalCodes: [],
  venuePreferences: [
    { venue: 'Atlantique', courts: [] },
    { venue: 'Suzanne Lenglen', courts: [] },
    { venue: 'Rigoulot - La Plaine', courts: [] },
  ],
};

function venueState(venue, visibleSlotCount = 0) {
  return {
    venue,
    rowCount: visibleSlotCount,
    visibleSlotCount,
    bookableCount: visibleSlotCount,
  };
}

test('accepts a result that contains the highest-priority visible slot', () => {
  const result = {
    noResult: false,
    venueStates: config.venuePreferences.map(({ venue }) => venueState(venue, venue === 'Atlantique' ? 1 : 0)),
    ranked: [{ venue: 'Atlantique', availability: 'bookable' }],
  };
  const assessment = assessSearchReliability(result, config);
  assert.equal(assessment.shouldRetry, false);
  assert.equal(assessment.reason, 'credible');
});

test('rechecks when a higher-priority venue looks empty but a lower one has a slot', () => {
  const result = {
    noResult: false,
    venueStates: config.venuePreferences.map(({ venue }) => venueState(venue, venue === 'Suzanne Lenglen' ? 1 : 0)),
    ranked: [{ venue: 'Suzanne Lenglen', availability: 'bookable' }],
  };
  const assessment = assessSearchReliability(result, config);
  assert.equal(assessment.shouldRetry, true);
  assert.equal(assessment.reason, 'higher-priority-empty');
  assert.deepEqual(assessment.affectedVenues, ['Atlantique']);
});

test('rechecks an empty result but treats the official no-result marker as structurally complete', () => {
  const assessment = assessSearchReliability({ noResult: true, venueStates: [], ranked: [] }, config);
  assert.equal(assessment.shouldRetry, true);
  assert.equal(assessment.reason, 'no-usable-slot');
  assert.equal(searchAttemptLimit(assessment, { searchAttempts: 3, noAvailabilityAttempts: 20 }), 20);
});

test('keeps structural and priority anomaly retries at the standard limit', () => {
  assert.equal(
    searchAttemptLimit({ reason: 'missing-venue' }, { searchAttempts: 3, noAvailabilityAttempts: 20 }),
    3,
  );
});

test('distinguishes a missing requested venue from a valid empty result', () => {
  const result = {
    noResult: false,
    venueStates: [venueState('Atlantique'), venueState('Suzanne Lenglen')],
    ranked: [],
  };
  const assessment = assessSearchReliability(result, config);
  assert.equal(assessment.reason, 'missing-venue');
  assert.deepEqual(assessment.affectedVenues, ['Rigoulot - La Plaine']);
});

test('ignores unknown/full rows when choosing a usable result and summarizes diagnostics', () => {
  const result = {
    noResult: false,
    venueStates: [venueState('Atlantique', 1)],
    ranked: [
      { venue: 'Atlantique', availability: 'unknown' },
      { venue: 'Atlantique', availability: 'login-required' },
    ],
  };
  const assessment = assessSearchReliability(result, { postalCodes: ['75015'], venuePreferences: [] });
  assert.equal(assessment.shouldRetry, false);
  assert.equal(usableRankedCandidates(result).length, 1);
  assert.deepEqual(summarizeSearchAttempt(result, assessment, 2), {
    attempt: 2,
    reason: 'credible',
    usableCount: 1,
    venues: [{ venue: 'Atlantique', rows: 1, visibleSlots: 1, bookableSlots: 1 }],
  });
});
