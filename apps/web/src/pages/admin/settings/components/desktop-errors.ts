import { apiErrorCode } from '@/lib/rpc';

export function desktopErrorKey(error: unknown) {
  switch (apiErrorCode(error)) {
    case 'UNAUTHORIZED':
      return 'errors.sessionExpired';
    case 'FORBIDDEN':
    case 'E2B_NOT_MANAGED':
      return 'errors.forbidden';
    case 'E2B_AUTH_FAILED':
      return 'settings.desktopAuthFailed';
    case 'E2B_NOT_CONFIGURED':
    case 'E2B_DISABLED':
      return 'settings.desktopUnavailableConfig';
    case 'E2B_NOT_FOUND':
      return 'settings.desktopNotFound';
    case 'E2B_RATE_LIMITED':
      return 'settings.desktopRateLimited';
    case 'E2B_REQUEST_FAILED':
      return 'settings.desktopRequestFailed';
    case 'E2B_INVALID_RESPONSE':
      return 'settings.desktopInvalidResponse';
    case 'VALIDATION_ERROR':
      return 'settings.desktopInstanceInvalid';
    default:
      return 'settings.desktopUnavailable';
  }
}
