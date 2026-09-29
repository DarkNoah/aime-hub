import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstance } from 'i18next';
import { i18nOptions, resolveLocale } from './config';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';
import { authErrorKey, validateCredentials } from '../lib/auth-errors';

test('浏览器语言按偏好匹配，中英文区域变体及未知语言回退', () => {
  for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-Hant-HK', ' ZH_cn ']) {
    assert.equal(resolveLocale([language]), 'zh-CN');
  }
  assert.equal(resolveLocale(['en-US', 'zh-CN']), 'en');
  assert.equal(resolveLocale(['fr-FR', 'zh-CN', 'en']), 'zh-CN');
  assert.equal(resolveLocale(['en-GB']), 'en');
  assert.equal(resolveLocale(['fr-FR']), 'en');
  assert.equal(resolveLocale([]), 'en');
});

test('两种语言的翻译键与插值变量保持一致', () => {
  assert.deepEqual(Object.keys(zhCN).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    assert.ok(zhCN[key].trim(), key);
    assert.deepEqual(
      zhCN[key].match(/{{\w+}}/g) ?? [],
      en[key].match(/{{\w+}}/g) ?? [],
      key,
    );
  }
});

test('语言切换后已保存的错误与组合提示使用当前语言', async () => {
  const instance = createInstance();
  await instance.init({ ...i18nOptions, lng: 'en' });
  const savedError = authErrorKey({ code: 'USERNAME_RESERVED' });
  const validation = validateCredentials('ab', 'valid-password');
  assert.equal(instance.t(savedError), en['errors.usernameReserved']);
  assert.equal(instance.t(validation!), en['errors.usernameLength']);
  await instance.changeLanguage('zh-CN');
  assert.equal(instance.t(savedError), zhCN['errors.usernameReserved']);
  assert.equal(instance.t(validation!), zhCN['errors.usernameLength']);
  assert.equal(
    instance.t('auth.createdError', { message: instance.t(savedError) }),
    `账号已创建，但自动登录未完成。${zhCN['errors.usernameReserved']}`,
  );
});

test('服务端错误码、网络错误与未知错误使用稳定翻译键', () => {
  assert.equal(
    authErrorKey({ code: 'INVALID_USERNAME_OR_PASSWORD' }),
    'errors.credentials',
  );
  assert.equal(authErrorKey(new TypeError('fetch failed')), 'errors.network');
  assert.equal(authErrorKey({ status: 0 }), 'errors.network');
  assert.equal(authErrorKey({ status: 401 }), 'errors.sessionExpired');
  assert.equal(authErrorKey({ status: 403 }), 'errors.forbidden');
  assert.equal(authErrorKey({ code: 'BANNED_USER' }), 'errors.banned');
  assert.equal(
    authErrorKey({ code: 'YOU_CANNOT_BAN_YOURSELF' }),
    'errors.selfBan',
  );
  assert.equal(
    authErrorKey({ code: 'YOU_CANNOT_REMOVE_YOURSELF' }),
    'errors.selfDelete',
  );
  assert.equal(authErrorKey({ code: 'USER_NOT_FOUND' }), 'errors.userNotFound');
  assert.equal(authErrorKey({ status: 429 }), 'errors.rateLimit');
  assert.equal(authErrorKey({ status: 503 }), 'errors.server');
  assert.equal(
    authErrorKey(
      { message: 'Do not display server internals' },
      'errors.signIn',
    ),
    'errors.signIn',
  );
  assert.equal(authErrorKey({ code: 'toString' }), 'errors.generic');
  assert.equal(authErrorKey(null), 'errors.generic');
  assert.equal(validateCredentials('valid_user', 'valid-password'), null);
});

test('缺失的中文资源会回退到英文', async () => {
  const instance = createInstance();
  await instance.init({
    ...i18nOptions,
    resources: { en: { translation: en }, 'zh-CN': { translation: {} } },
    lng: 'zh-CN',
  });
  assert.equal(instance.t('auth.username'), 'Username');
});
