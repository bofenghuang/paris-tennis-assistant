import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseConfirmationAction,
  chooseExistingPassOption,
  hasExistingCarnetHourChoice,
  hasExistingPassDebitConfirmation,
  hasInsufficientBalanceText,
  hasVisibleCardField,
  isUnsafePaymentText,
  looksLikePaymentPage,
} from '../src/payment.js';

test('prioritizes an owned Abonnement 10h over a generic account credit', () => {
  const option = chooseExistingPassOption(
    [
      { kind: 'choice', label: 'Solde de crédits disponible : 3 heures', checked: false, disabled: false },
      { kind: 'choice', label: 'Mon Abonnement 10h — 6 heures restantes', checked: false, disabled: false },
    ],
    { pageText: 'Choisissez votre moyen de paiement', maxPriceEuros: 12 },
  );
  assert.equal(option.label, 'Mon Abonnement 10h — 6 heures restantes');
});

test('accepts the official ten-hour pass label in payment context', () => {
  const option = chooseExistingPassOption(
    [{ kind: 'choice', label: 'Abonnement 10h', checked: false, disabled: false }],
    { pageText: 'Mode de paiement', maxPriceEuros: 12 },
  );
  assert.equal(option.label, 'Abonnement 10h');
});

test('never selects a new pass purchase or an option above the booking price guard', () => {
  const options = [
    { kind: 'action', label: 'Acheter un nouvel Abonnement 10h', checked: false, disabled: false },
    { kind: 'choice', label: 'Abonnement 10h — 145 €', checked: false, disabled: false },
  ];
  assert.equal(chooseExistingPassOption(options, { pageText: 'Paiement', maxPriceEuros: 12 }), null);
  assert.equal(isUnsafePaymentText('Recharger puis payer par carte bancaire'), true);
});

test('detects an unusable balance and visible card fields', () => {
  assert.equal(hasInsufficientBalanceText('Le solde de votre abonnement est insuffisant.'), true);
  assert.equal(hasVisibleCardField([{ autocomplete: 'cc-number', name: '', id: '', label: '' }]), true);
  assert.equal(hasVisibleCardField([{ autocomplete: '', name: 'partnerName', id: '', label: 'Partenaire' }]), false);
});

test('chooses a safe confirmation action and rejects purchase actions', () => {
  const action = chooseConfirmationAction([
    { kind: 'action', label: 'Acheter et valider', disabled: false },
    { kind: 'action', label: 'Retour', disabled: false },
    { kind: 'action', label: 'Confirmer la réservation', disabled: false },
  ]);
  assert.equal(action.label, 'Confirmer la réservation');
  assert.equal(chooseConfirmationAction([
    { kind: 'action', label: 'Etape précédente', disabled: false },
    { kind: 'action', label: 'Etape suivante', disabled: false },
  ]).label, 'Etape suivante');
});

test('recognizes a stored-pass payment page', () => {
  assert.equal(looksLikePaymentPage('Choisir le mode de paiement — Abonnement 10h'), true);
  assert.equal(looksLikePaymentPage('Renseignez votre partenaire'), false);
});

test('recognizes an explicit debit from an already-owned carnet', () => {
  assert.equal(hasExistingPassDebitConfirmation(
    'Une heure de votre carnet sera utilisée pour cette réservation. Il vous restera 9h.',
  ), true);
  assert.equal(hasExistingPassDebitConfirmation('Acheter un carnet de dix heures.'), false);
});

test('recognizes the official one-hour carnet card without accepting a purchase', () => {
  assert.equal(hasExistingCarnetHourChoice("J’utilise 1 heure de mon carnet en ligne"), true);
  assert.equal(hasExistingCarnetHourChoice("Acheter puis j’utilise 1 heure de mon carnet en ligne"), false);
});
