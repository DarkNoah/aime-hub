import { input, password } from '@inquirer/prompts';
import { Pool } from 'pg';
import { createAuth } from '@aime/auth';
import { parseAdminUsernames } from '@aime/shared';
import { loadEnv } from '@aime/shared/env';

const env = loadEnv();
const allowed = parseAdminUsernames(env.ADMINS);
const username = (await input({ message: '管理员用户名', default: allowed[0] }))
  .trim()
  .toLowerCase();
if (!allowed.includes(username)) throw new Error('该用户名不在 ADMINS 配置中');
if (!/^[a-z0-9_.]{3,30}$/.test(username))
  throw new Error('用户名需为 3–30 位字母、数字、下划线或点');
const email = (await input({ message: '管理员邮箱' })).trim();
const secret = await password({ message: '设置密码（8–128 位）', mask: '*' });
if (secret.length < 8 || secret.length > 128)
  throw new Error('密码需为 8–128 位');
if (secret !== (await password({ message: '再次输入密码', mask: '*' })))
  throw new Error('两次密码不一致');
const pool = new Pool({ connectionString: env.DATABASE_URL });
try {
  const auth = createAuth({
    pool,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    webOrigin: env.WEB_ORIGIN,
    admins: env.ADMINS,
  });
  // Trusted local call: no HTTP request or headers. User management remains in the admin plugin.
  await auth.api.createUser({
    body: {
      email,
      password: secret,
      name: username,
      role: 'admin',
      data: { username },
    },
  });
  console.log(`管理员 ${username} 已创建，可以使用用户名和密码登录。`);
} finally {
  await pool.end();
}
