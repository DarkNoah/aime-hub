import type { ErrorKey } from '../i18n/config';

const messages: Record<string, ErrorKey> = {
  USERNAME_RESERVED: 'errors.usernameReserved',
  USERNAME_REQUIRED: 'errors.usernameRequired',
  INVALID_USERNAME_OR_PASSWORD: 'errors.credentials',
  INVALID_EMAIL_OR_PASSWORD: 'errors.credentials',
  INVALID_PASSWORD: 'errors.password',
  USERNAME_IS_ALREADY_TAKEN: 'errors.usernameTaken',
  USER_ALREADY_EXISTS: 'errors.emailTaken',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'errors.anotherEmail',
  USERNAME_TOO_SHORT: 'errors.usernameShort',
  USERNAME_TOO_LONG: 'errors.usernameLong',
  INVALID_USERNAME: 'errors.usernameFormat',
  PASSWORD_TOO_SHORT: 'errors.passwordShort',
  PASSWORD_TOO_LONG: 'errors.passwordLong',
  INVALID_EMAIL: 'errors.email',
  EMAIL_NOT_VERIFIED: 'errors.emailUnverified',
  USER_BANNED: 'errors.banned',
  BANNED_USER: 'errors.banned',
  YOU_CANNOT_BAN_YOURSELF: 'errors.selfBan',
  YOU_CANNOT_REMOVE_YOURSELF: 'errors.selfDelete',
  USER_NOT_FOUND: 'errors.userNotFound',
  TOO_MANY_REQUESTS: 'errors.rateLimit',
  SESSION_EXPIRED: 'errors.sessionExpired',
  SIGNUP_DISABLED: 'errors.signUpDisabled',
};

export function authErrorKey(
  error: unknown,
  fallback: ErrorKey = 'errors.generic',
): ErrorKey {
  if (error instanceof TypeError) return 'errors.network';
  if (typeof error !== 'object' || error === null) return fallback;
  if (
    'code' in error &&
    typeof error.code === 'string' &&
    Object.hasOwn(messages, error.code)
  ) {
    return messages[error.code];
  }
  if ('status' in error) {
    if (error.status === 0) return 'errors.network';
    if (error.status === 401) return 'errors.sessionExpired';
    if (error.status === 403) return 'errors.forbidden';
    if (error.status === 429) return 'errors.rateLimit';
    if (typeof error.status === 'number' && error.status >= 500) {
      return 'errors.server';
    }
  }
  return fallback;
}

export function validateCredentials(
  username: string,
  password: string,
): ErrorKey | null {
  if (username.length < 3 || username.length > 30)
    return 'errors.usernameLength';
  if (!/^[a-zA-Z0-9_.]+$/.test(username)) return 'errors.usernameFormat';
  if (password.length < 8 || password.length > 128)
    return 'errors.passwordLength';
  return null;
}
