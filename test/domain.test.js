import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTargetDate,
  extractCourtNumber,
  normalizeText,
  normalizeTime,
  parsePrice,
  rankCandidates,
  searchHourRange,
} from '../src/domain.js';

const config = {
  venuePreferences: [
    { venue: 'Suzanne Lenglen', courts: [] },
    { venue: 'Atlantique', courts: [] },
  ],
  timePriority: ['19:00', '18:00', '20:00'],
  maxPriceEuros: 12,
  coveredPreference: 'any',
  surfaceKeywords: [],
};

test('normalizes French labels and slot values', () => {
  assert.equal(normalizeText('René et André Mourlon'), 'rene et andre mourlon');
  assert.equal(normalizeTime('19h'), '19:00');
  assert.equal(normalizeTime('08 h 00'), '08:00');
  assert.equal(parsePrice(' 12,50 € '), 12.5);
});

test('computes the Paris booking target across a month boundary', () => {
  const target = computeTargetDate(new Date('2026-09-28T23:30:00Z'), 6);
  assert.equal(target.iso, '05/10/2026');
  assert.equal(target.weekday, 1);
});

test('ranks venue before time and rejects expensive slots', () => {
  const ranked = rankCandidates(
    [
      { venue: 'Atlantique', timeLabel: '19h', court: 'Court 1', priceLabel: '12 €' },
      { venue: 'Suzanne Lenglen', timeLabel: '18h', court: 'Court 2', priceLabel: '12 €' },
      { venue: 'Suzanne Lenglen', timeLabel: '19h', court: 'Court 3', priceLabel: '14 €' },
    ],
    config,
  );
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].venue, 'Suzanne Lenglen');
  assert.equal(ranked[0].time, '18:00');
  assert.equal(ranked[1].venue, 'Atlantique');
});

test('builds the narrowest whole-hour search range', () => {
  assert.equal(searchHourRange(['18:00', '20:00', '19:00']), '18-21');
  assert.equal(searchHourRange(['21:00']), '21-22');
});

test('extracts and applies a different court-number priority for each venue', () => {
  assert.equal(extractCourtNumber('Court n° 12'), 12);
  assert.equal(extractCourtNumber('Terrain 3'), 3);
  assert.equal(extractCourtNumber('12 rue du Stade'), null);

  const ranked = rankCandidates(
    [
      { venue: 'Atlantique', timeLabel: '19h', court: 'Court n° 1', priceLabel: '12 €' },
      { venue: 'Atlantique', timeLabel: '19h', court: 'Court n° 3', priceLabel: '12 €' },
      { venue: 'Suzanne Lenglen', timeLabel: '19h', court: 'Court n° 1', priceLabel: '12 €' },
      { venue: 'Suzanne Lenglen', timeLabel: '19h', court: 'Court n° 3', priceLabel: '12 €' },
    ],
    {
      ...config,
      venuePreferences: [
        { venue: 'Atlantique', courts: [3, 1] },
        { venue: 'Suzanne Lenglen', courts: [1, 3] },
      ],
    },
  );
  assert.deepEqual(
    ranked.map((candidate) => `${candidate.venue}:${candidate.courtNumber}`),
    ['Atlantique:3', 'Atlantique:1', 'Suzanne Lenglen:1', 'Suzanne Lenglen:3'],
  );
});

test('always ranks venue priority ahead of court-number preference', () => {
  const ranked = rankCandidates(
    [
      { venue: 'Atlantique', timeLabel: '19h', court: 'Court n° 2', priceLabel: '12 €' },
      { venue: 'Suzanne Lenglen', timeLabel: '19h', court: 'Court n° 1', priceLabel: '12 €' },
    ],
    {
      ...config,
      venuePreferences: [
        { venue: 'Atlantique', courts: [1] },
        { venue: 'Suzanne Lenglen', courts: [1] },
      ],
    },
  );
  assert.equal(ranked[0].venue, 'Atlantique');
  assert.equal(ranked[0].courtNumber, 2);
});
