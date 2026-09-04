import { normalizeText } from './domain.js';

const VISIBLE_SLOT_STATES = new Set(['bookable', 'login-required', 'account-limit']);

function venueMatches(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft);
}

function includesVenue(venues, expectedVenue) {
  return venues.some((venue) => venueMatches(venue, expectedVenue));
}

export function usableRankedCandidates(searchResult) {
  return (searchResult?.ranked ?? []).filter((candidate) => VISIBLE_SLOT_STATES.has(candidate.availability));
}

export function searchAttemptLimit(assessment, release) {
  return assessment?.reason === 'no-usable-slot'
    ? release.noAvailabilityAttempts
    : release.searchAttempts;
}

export function assessSearchReliability(searchResult, config) {
  const usableCandidates = usableRankedCandidates(searchResult);
  const priorityVenues = (config.venuePreferences ?? []).map((preference) => preference.venue);
  const directlyRequestedVenues = (config.postalCodes ?? []).length === 0 ? priorityVenues.slice(0, 5) : [];
  const returnedVenues = (searchResult?.venueStates ?? []).map((state) => state.venue);

  if (!searchResult?.noResult) {
    const missingVenues = directlyRequestedVenues.filter((venue) => !includesVenue(returnedVenues, venue));
    if (missingVenues.length > 0) {
      return {
        shouldRetry: true,
        reason: 'missing-venue',
        affectedVenues: missingVenues,
        usableCandidates,
      };
    }
  }

  if (usableCandidates.length === 0) {
    return {
      shouldRetry: true,
      reason: 'no-usable-slot',
      affectedVenues: directlyRequestedVenues,
      usableCandidates,
    };
  }

  const bestVenueIndex = priorityVenues.findIndex((venue) => venueMatches(venue, usableCandidates[0].venue));
  if (bestVenueIndex > 0) {
    const emptyHigherPriorityVenues = priorityVenues
      .slice(0, bestVenueIndex)
      .filter((venue) => !usableCandidates.some((candidate) => venueMatches(venue, candidate.venue)));
    if (emptyHigherPriorityVenues.length > 0) {
      return {
        shouldRetry: true,
        reason: 'higher-priority-empty',
        affectedVenues: emptyHigherPriorityVenues,
        usableCandidates,
      };
    }
  }

  return {
    shouldRetry: false,
    reason: 'credible',
    affectedVenues: [],
    usableCandidates,
  };
}

export function summarizeSearchAttempt(searchResult, assessment, attempt) {
  return {
    attempt,
    reason: assessment.reason,
    usableCount: assessment.usableCandidates.length,
    venues: (searchResult.venueStates ?? []).map((state) => ({
      venue: state.venue,
      rows: state.rowCount,
      visibleSlots: state.visibleSlotCount,
      bookableSlots: state.bookableCount,
    })),
  };
}
