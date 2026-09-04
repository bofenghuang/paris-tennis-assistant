import { normalizeText } from './domain.js';

const TEN_HOUR_PASS_PATTERN = /\babonnement(?: de)? 10 ?(?:h|heure|heures)\b/;
const EXISTING_BALANCE_PATTERN = /\b(?:mon|mes) abonnement\b|\babonnement (?:actif|en cours|disponible)\b|\b(?:solde|credit|credits|heure restante|heures restantes)\b|\b(?:utiliser|debiter|payer avec|paiement par) (?:mon )?abonnement\b/;
const PURCHASE_PATTERN = /\b(?:acheter|achat|commander|commande|nouvel abonnement|nouveau forfait|recharger|rechargement|souscrire)\b/;
const CARD_PATTERN = /\b(?:carte bancaire|payer par carte|numero de carte|cryptogramme|cvv|cvc|3d secure|visa|mastercard|paypal|apple pay|google pay|virement)\b|\bcb\b/;
const INSUFFICIENT_PATTERN = /\b(?:solde|credit|credits|abonnement).{0,35}\b(?:insuffisant|epuise|expire|indisponible)\b|\baucun abonnement\b|\b(?:0|0[,.]0+) (?:h|heure|heures|credit|credits) (?:restant|restante|restants|restantes|disponible|disponibles)\b/;
const CONFIRM_PATTERN = /\b(?:confirmer|confirmation|valider|validation|finaliser|reserver|reservation|payer|continuer|suivant|suivante)\b/;
const CANCEL_PATTERN = /\b(?:annuler|retour|precedent|abandonner|fermer)\b/;
const CARD_FIELD_PATTERN = /\b(?:cc number|cc exp|cc csc|card number|numero carte|carte bancaire|cryptogramme|cvv|cvc|date expiration)\b/;
const EXISTING_CARNET_DEBIT_PATTERN = /\b(?:une )?heure de votre carnet (?:sera|va etre) (?:utilisee|debitee)\b/;
const REMAINING_HOURS_PATTERN = /\bil vous restera \d+(?:[,.]\d+)? ?h\b|\b\d+(?:[,.]\d+)? (?:heure|heures) restantes?\b/;
const EXISTING_CARNET_HOUR_CHOICE_PATTERN = /\bj utilise (?:1|une) heure de mon carnet en ligne\b/;

function normalized(value) {
  return normalizeText(value);
}

function moneyAmounts(value) {
  return [...String(value ?? '').matchAll(/(\d+(?:[,.]\d+)?)\s*€/g)].map((match) => Number(match[1].replace(',', '.')));
}

export function isUnsafePaymentText(value) {
  const text = normalized(value);
  return PURCHASE_PATTERN.test(text) || CARD_PATTERN.test(text) || INSUFFICIENT_PATTERN.test(text);
}

export function isExistingPassText(value) {
  const text = normalized(value);
  return TEN_HOUR_PASS_PATTERN.test(text)
    || EXISTING_BALANCE_PATTERN.test(text)
    || EXISTING_CARNET_HOUR_CHOICE_PATTERN.test(text);
}

export function hasExistingCarnetHourChoice(value) {
  const text = normalized(value);
  return EXISTING_CARNET_HOUR_CHOICE_PATTERN.test(text) && !isUnsafePaymentText(text);
}

export function hasInsufficientBalanceText(value) {
  return INSUFFICIENT_PATTERN.test(normalized(value));
}

export function hasVisibleCardField(fields = []) {
  return fields.some((field) => {
    const autocomplete = normalized(field.autocomplete);
    if (['cc number', 'cc exp', 'cc csc', 'cc name'].includes(autocomplete)) return true;
    return CARD_FIELD_PATTERN.test(normalized(`${field.name ?? ''} ${field.id ?? ''} ${field.label ?? ''}`));
  });
}

export function hasExistingPassDebitConfirmation(value) {
  const text = normalized(value);
  return EXISTING_CARNET_DEBIT_PATTERN.test(text) && REMAINING_HOURS_PATTERN.test(text);
}

function existingPassScore(option, pageText, maxPriceEuros) {
  if (option.disabled || isUnsafePaymentText(option.label)) return Number.NEGATIVE_INFINITY;
  const label = normalized(option.label);
  const context = normalized(pageText);
  const hasTenHourName = TEN_HOUR_PASS_PATTERN.test(label);
  const hasExistingEvidence = EXISTING_BALANCE_PATTERN.test(label);
  const paymentContext = /\b(?:mes abonnements|mode de paiement|moyen de paiement|paiement|payer avec|utiliser un abonnement)\b/.test(context);
  if (!hasExistingEvidence && !(hasTenHourName && paymentContext)) return Number.NEGATIVE_INFINITY;

  const amounts = moneyAmounts(option.label);
  if (amounts.some((amount) => amount > maxPriceEuros)) return Number.NEGATIVE_INFINITY;

  let score = hasTenHourName ? 100 : 45;
  if (hasExistingEvidence) score += 25;
  if (option.checked) score += 15;
  if (option.kind === 'choice') score += 8;
  if (/\b(?:restant|restante|restants|restantes|disponible|disponibles|solde|credit|credits)\b/.test(label)) score += 8;
  return score;
}

export function chooseExistingPassOption(options = [], { pageText = '', maxPriceEuros = 50 } = {}) {
  return options
    .map((option, index) => ({ option, index, score: existingPassScore(option, pageText, maxPriceEuros) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.option ?? null;
}

function confirmationScore(action) {
  if (action.disabled || action.kind !== 'action' || isUnsafePaymentText(action.label)) {
    return Number.NEGATIVE_INFINITY;
  }
  const text = normalized(action.label);
  if (CANCEL_PATTERN.test(text) || !CONFIRM_PATTERN.test(text)) return Number.NEGATIVE_INFINITY;
  if (/\bconfirmer (?:la )?reservation\b|\bvalidation definitive\b/.test(text)) return 100;
  if (/\bvalider (?:le )?paiement\b|\bpayer avec\b/.test(text)) return 90;
  if (/\bconfirmer\b|\bfinaliser\b/.test(text)) return 80;
  if (/\bvalider\b|\breserver\b|\bpayer\b/.test(text)) return 70;
  return 50;
}

export function chooseConfirmationAction(actions = []) {
  return actions
    .map((action, index) => ({ action, index, score: confirmationScore(action) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.action ?? null;
}

export function looksLikePaymentPage(value) {
  const text = normalized(value);
  return /\b(?:paiement|payer|mode de paiement|moyen de paiement|abonnement 10 ?h|solde|credit|credits)\b/.test(text);
}
