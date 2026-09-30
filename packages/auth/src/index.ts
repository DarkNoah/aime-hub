import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { admin, username } from 'better-auth/plugins';
import { parseAdminUsernames } from '@aime/shared';
import type { Pool } from 'pg';

type AuthConfig = {
  pool: Pool;
  secret: string;
  baseURL: string;
  webOrigin: string;
  admins: string;
};

export function createAuthOptions(config: AuthConfig) {
  const reserved = new Set(parseAdminUsernames(config.admins));
  return {
    appName: 'Aime Hub',
    database: config.pool,
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: '/api/auth',
    advanced: {
      cookiePrefix: 'aime-hub',
      ipAddress: { ipAddressHeaders: ['x-aime-client-ip'] },
    },
    trustedOrigins: [new URL(config.webOrigin).origin],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
    },
    session: {
      modelName: 'sessions',
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
      },
    },
    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'accounts',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'verifications',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/username': { window: 60, max: 10 },
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-up/email' && ctx.path !== '/update-user')
          return;
        const value: unknown = ctx.body?.username;
        if (ctx.path === '/sign-up/email' && typeof value !== 'string') {
          throw new APIError('BAD_REQUEST', {
            code: 'USERNAME_REQUIRED',
            message: '请输入用户名',
          });
        }
        if (typeof value === 'string' && reserved.has(value.toLowerCase())) {
          throw new APIError('BAD_REQUEST', {
            code: 'USERNAME_RESERVED',
            message: '此用户名为系统保留账号，请联系管理员',
          });
        }
      }),
    },
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 30,
        immutableUsername: true,
        schema: { user: { fields: { displayUsername: 'display_username' } } },
      }),
      admin({
        defaultRole: 'user',
        bannedUserMessage: '该账号已被停用，请联系管理员',
        schema: {
          user: {
            fields: { banReason: 'ban_reason', banExpires: 'ban_expires' },
          },
          session: { fields: { impersonatedBy: 'impersonated_by' } },
        },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(config: AuthConfig) {
  return betterAuth(createAuthOptions(config));
}

export type Auth = ReturnType<typeof createAuth>;
