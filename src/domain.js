const PARIS_TIME_ZONE = 'Europe/Paris';

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function parsePrice(value) {
  const match = String(value ?? '').replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function normalizeTime(value) {
  const match = String(value ?? '').match(/\b([01]?\d|2[0-3])\s*h(?:\s*(\d{1,2}))?/i);
  if (!match) return null;
  const hour = String(Number(match[1])).padStart(2, '0');
  const minute = String(Number(match[2] ?? 0)).padStart(2, '0');
  return `${hour}:${minute}`;
}

function parisParts(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PARIS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

export function computeTargetDate(now = new Date(), offsetDays = 6) {
  const { year, month, day } = parisParts(now);
  const utcDate = new Date(Date.UTC(year, month - 1, day + offsetDays, 12));
  const targetYear = utcDate.getUTCFullYear();
  const targetMonth = utcDate.getUTCMonth() + 1;
  const targetDay = utcDate.getUTCDate();
  return {
    iso: `${String(targetDay).padStart(2, '0')}/${String(targetMonth).padStart(2, '0')}/${targetYear}`,
    weekday: utcDate.getUTCDay(),
    year: targetYear,
    month: targetMonth,
    day: targetDay,
  };
}

export function dateIsoToTimestamp(value) {
  const match = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 12);
}

function preferenceIndex(list, value) {
  const normalizedValue = normalizeText(value);
  const index = list.findIndex((item) => {
    const normalizedItem = normalizeText(item);
    return normalizedValue === normalizedItem || normalizedValue.includes(normalizedItem);
  });
  return index === -1 ? list.length + 10 : index;
}

function coveredRank(candidate, preference) {
  if (preference === 'any') return 0;
  const text = normalizeText(`${candidate.indoorOutdoor ?? ''} ${candidate.description ?? ''}`);
  const isCovered = text.includes('couvert') && !text.includes('decouvert');
  if (preference === 'covered') return isCovered ? 0 : 1;
  return isCovered ? 1 : 0;
}

export function extractCourtNumber(value) {
  const text = normalizeText(value);
  const labeled = text.match(/\b(?:court|terrain|piste)\s*(?:n|no|numero)?\s*(\d{1,2})\b/);
  if (labeled) return Number(labeled[1]);
  const standalone = text.match(/^(?:n|no|numero)?\s*(\d{1,2})$/);
  return standalone ? Number(standalone[1]) : null;
}

function venuePreferenceFor(venuePreferences, venue) {
  const normalizedVenue = normalizeText(venue);
  return venuePreferences.find((preference) => {
    const normalizedPreference = normalizeText(preference.venue);
    return normalizedVenue === normalizedPreference || normalizedVenue.includes(normalizedPreference);
  });
}

function courtPreferenceRank(candidate, venuePreferences) {
  const courtPriority = venuePreferenceFor(venuePreferences, candidate.venue)?.courts ?? [];
  if (courtPriority.length === 0) return 0;
  const courtNumber = candidate.courtNumber ?? extractCourtNumber(candidate.court);
  const index = courtPriority.indexOf(courtNumber);
  return index === -1 ? courtPriority.length + 10 : index;
}

export function rankCandidates(candidates, config) {
  const allowedTimes = new Set(config.timePriority);
  const surfaceKeywords = config.surfaceKeywords.map(normalizeText).filter(Boolean);
  const venuePreferences = config.venuePreferences ?? [];
  const venuePriority = venuePreferences.map((preference) => preference.venue);

  return candidates
    .map((candidate) => ({
      ...candidate,
      time: candidate.time ?? normalizeTime(candidate.timeLabel),
      priceEuros: Number.isFinite(candidate.priceEuros) ? candidate.priceEuros : parsePrice(candidate.priceLabel),
      courtNumber: candidate.courtNumber ?? extractCourtNumber(candidate.court),
    }))
    .filter((candidate) => candidate.time && allowedTimes.has(candidate.time))
    .filter((candidate) => candidate.priceEuros <= config.maxPriceEuros)
    .filter((candidate) => {
      if (surfaceKeywords.length === 0) return true;
      const courtText = normalizeText(`${candidate.court ?? ''} ${candidate.description ?? ''}`);
      return surfaceKeywords.some((keyword) => courtText.includes(keyword));
    })
    .sort((left, right) => {
      const leftTuple = [
        preferenceIndex(venuePriority, left.venue),
        config.timePriority.indexOf(left.time),
        courtPreferenceRank(left, venuePreferences),
        coveredRank(left, config.coveredPreference),
        left.priceEuros,
        normalizeText(left.court),
      ];
      const rightTuple = [
        preferenceIndex(venuePriority, right.venue),
        config.timePriority.indexOf(right.time),
        courtPreferenceRank(right, venuePreferences),
        coveredRank(right, config.coveredPreference),
        right.priceEuros,
        normalizeText(right.court),
      ];
      for (let index = 0; index < leftTuple.length; index += 1) {
        if (leftTuple[index] < rightTuple[index]) return -1;
        if (leftTuple[index] > rightTuple[index]) return 1;
      }
      return 0;
    })
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function searchHourRange(timePriority) {
  const hours = timePriority.map((time) => Number(time.slice(0, 2))).filter(Number.isFinite);
  const minimum = Math.max(8, Math.min(...hours));
  const maximum = Math.min(22, Math.max(...hours) + 1);
  return `${minimum}-${Math.max(minimum + 1, maximum)}`;
}
