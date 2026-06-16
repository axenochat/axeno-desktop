import { PasswordStrength, MIN_PASSWORD_LENGTH } from "../../passwordStrength";
import "./PasswordStrengthMeter.css";

/**
 * A four-segment strength bar plus the library's own warning/suggestion text.
 *
 * Takes a pre-computed `strength` (from `evaluatePassword`) and the password
 * `length` rather than the raw password, so callers can keep the passphrase out
 * of React state and wipe it from the DOM after submit. Renders nothing until
 * something has been typed (`length > 0`).
 */
export default function PasswordStrengthMeter({ strength, length }: { strength: PasswordStrength | null; length: number }) {
  if (!strength || length === 0) return null;

  const tooShort = length < MIN_PASSWORD_LENGTH;
  // Clamp the visible level to 1 while below the length floor so a short but
  // pattern-free string can't show a reassuring "Strong".
  const level = tooShort ? Math.min(strength.score, 1) : strength.score;

  return (
    <div className="pw-strength" aria-live="polite">
      <div className="pw-strength-bars">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`pw-strength-bar ${i < level ? `filled level-${level}` : ""}`} />
        ))}
      </div>
      <div className={`pw-strength-label level-${level}`}>
        {tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters` : strength.label}
      </div>
      {!tooShort && strength.warning && <div className="pw-strength-hint">{strength.warning}</div>}
      {!tooShort && !strength.warning && strength.suggestions[0] && (
        <div className="pw-strength-hint">{strength.suggestions[0]}</div>
      )}
    </div>
  );
}
