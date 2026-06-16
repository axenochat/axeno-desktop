// Centralised passphrase-strength estimation, backed by zxcvbn-ts (a maintained
// TypeScript port of Dropbox's zxcvbn). We do not roll our own scoring — this
// uses the library's dictionary/keyboard-pattern model so the meter reflects how
// guessable a passphrase actually is, not just its length.

import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as zxcvbnCommon from "@zxcvbn-ts/language-common";
import * as zxcvbnEn from "@zxcvbn-ts/language-en";

// The hard floor for any vault passphrase, enforced in addition to the strength
// score below. A short string can still score well on patterns; require length.
export const MIN_PASSWORD_LENGTH = 12;

// Minimum acceptable zxcvbn score (0–4). 0 = too guessable, 1 = very guessable;
// we reject both. 2 ("somewhat guessable") is the floor we allow, while the meter
// nudges toward 3–4. The vault is unrecoverable, so we bias toward stronger.
export const MIN_ACCEPTABLE_SCORE = 2;

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
  score: StrengthScore;
  label: string;
  warning: string;
  suggestions: string[];
}

const SCORE_LABELS = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];

// Built once, lazily, so the (sizeable) dictionaries are only parsed when a
// password field is actually used.
let factory: ZxcvbnFactory | null = null;
function zxcvbn(): ZxcvbnFactory {
  if (!factory) {
    factory = new ZxcvbnFactory({
      dictionary: { ...zxcvbnCommon.dictionary, ...zxcvbnEn.dictionary },
      graphs: zxcvbnCommon.adjacencyGraphs,
      translations: zxcvbnEn.translations,
    });
  }
  return factory;
}

/**
 * Estimate the strength of `password`. `userInputs` (e.g. the display name) are
 * penalised so a passphrase built from public profile data scores lower.
 */
export function evaluatePassword(password: string, userInputs: string[] = []): PasswordStrength {
  if (!password) {
    return { score: 0, label: SCORE_LABELS[0], warning: "", suggestions: [] };
  }
  const result = zxcvbn().check(password, userInputs.filter(Boolean));
  const score = result.score as StrengthScore;
  return {
    score,
    label: SCORE_LABELS[score],
    warning: result.feedback.warning ?? "",
    suggestions: result.feedback.suggestions ?? [],
  };
}

/**
 * Whether a candidate passphrase clears both the length floor and the strength
 * floor. Returns a human-readable reason when it does not, for inline display.
 */
export function checkPasswordAcceptable(
  password: string,
  userInputs: string[] = [],
): { ok: true } | { ok: false; reason: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters. A 4–5 word passphrase is better.` };
  }
  const strength = evaluatePassword(password, userInputs);
  if (strength.score < MIN_ACCEPTABLE_SCORE) {
    const hint = strength.warning || strength.suggestions[0] || "Use a longer passphrase of several uncommon words.";
    return { ok: false, reason: `That password is too easy to guess. ${hint}` };
  }
  return { ok: true };
}
