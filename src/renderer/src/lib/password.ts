/**
 * Local password policy check, shared by the three places that accept a new
 * password (login screen, user menu, account dialog).
 *
 * WHY IT RETURNS A CATALOGUE KEY AND NOT A SENTENCE
 * The check has to run before the call so the user is told what is wrong without
 * a round trip, but the text is user-visible and therefore belongs to the
 * catalogues. Returning the key keeps the rule in one place and the wording in
 * the four catalogues, instead of the same three `if`s (and their translations)
 * copied into every form.
 *
 * The main process re-checks all of this in `assertPasswordAcceptable` and is the
 * only authority; this mirrors the rules so the two cannot disagree in front of
 * the user, and nothing here is a security boundary.
 *
 * THE `{min}` PLACEHOLDER
 * `authUi.errPasswordLength` carries `{min}` rather than a literal 8/6, so the
 * number the user reads is always `PASSWORD_MIN_LENGTH` — the same constant the
 * main process enforces. It used to be a literal, which meant the manual's rule
 * (6, §17.1 line 5199) could be changed in one place and stay wrong in the UI.
 * Callers therefore pass `{ min: PASSWORD_MIN_LENGTH }`.
 */

import { PASSWORD_MIN_LENGTH } from '@shared/domain/auth'

export type PasswordProblemKey =
  | 'authUi.errNewPassword'
  | 'authUi.errPasswordLength'
  | 'authUi.errPasswordWhitespace'

/**
 * First rule the password breaks **on its own**, or `''` when it is acceptable.
 *
 * Deliberately does NOT check "contains the username": that rule only holds for a
 * password the user is CHOOSING. A password that was set before an account was
 * renamed can legitimately contain the new name, and folding the rule in here made
 * that state impossible to leave — the form refused every replacement while the
 * error it showed ("the password cannot contain the username") was about the OLD
 * password, not the new one. `usernameConflictProblemKey()` below is that rule, and
 * only the flows that need it call it.
 */
export function passwordProblemKey(password: string): PasswordProblemKey | '' {
  if (!password) return 'authUi.errNewPassword'
  if (password.length < PASSWORD_MIN_LENGTH) return 'authUi.errPasswordLength'
  // Surrounding whitespace is refused rather than trimmed: it is invisible in a
  // password field, so silently keeping or dropping it produces a support call.
  if (password !== password.trim()) return 'authUi.errPasswordWhitespace'
  return ''
}

/** 与服务端 `assertPasswordAcceptable` 的第三条规则对应（密码不能包含用户名）。 */
export function usernameConflictProblemKey(
  password: string,
  username: string
): 'authUi.errPasswordHasUsername' | '' {
  if (username.length >= 3 && password.toLowerCase().includes(username.toLowerCase())) {
    return 'authUi.errPasswordHasUsername'
  }
  return ''
}
