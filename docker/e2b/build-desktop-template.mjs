import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function desktopRecipe(Template, image, startup) {
  // Embed the small startup script to avoid a separate file-upload dependency.
  const encoded = Buffer.from(startup).toString('base64');
  return Template()
    .fromImage(image)
    .setUser('root')
    .setWorkdir('/')
    .runCmd(
      'id -u user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user',
    )
    .runCmd(
      `printf '%s' '${encoded}' | base64 -d > /usr/local/bin/desktop-start && chmod 755 /usr/local/bin/desktop-start`,
    )
    .runCmd('mkdir -p /home/user && chown -R user:user /home/user')
    .setEnvs({
      HOME: '/home/user',
      DISPLAY: ':0',
      XDG_RUNTIME_DIR: '/tmp/desktop-runtime',
    })
    .setUser('user')
    .setWorkdir('/home/user')
    .setStartCmd(
      '/bin/bash /usr/local/bin/desktop-start',
      'xdpyinfo -display :0 >/dev/null 2>&1 && pgrep -u user -x xfce4-session >/dev/null',
    );
}

export async function buildDesktopTemplate(
  Template,
  { env = process.env, fetcher = fetch, startup } = {},
) {
  const {
    E2B_API_URL: apiUrl,
    E2B_API_KEY: apiKey,
    E2B_DESKTOP_IMAGE: image,
  } = env;
  const alias = env.E2B_DESKTOP_TEMPLATE || 'desktop';
  const cpuCount = Number(env.E2B_DESKTOP_CPU_COUNT || 2);
  const memoryMB = Number(env.E2B_DESKTOP_MEMORY_MB || 2048);
  if (
    !apiUrl ||
    !apiKey ||
    !image ||
    !alias.trim() ||
    !Number.isSafeInteger(cpuCount) ||
    cpuCount <= 0 ||
    !Number.isSafeInteger(memoryMB) ||
    memoryMB <= 0
  )
    throw new Error('Invalid desktop template build configuration');
  const response = await fetcher(`${apiUrl.replace(/\/+$/, '')}/templates`, {
    headers: { 'X-API-Key': apiKey },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Template lookup failed (${response.status})`);
  const templates = await response.json();
  if (!Array.isArray(templates))
    throw new Error('Invalid template list response');
  if (
    env.E2B_DESKTOP_FORCE_REBUILD !== '1' &&
    templates.some(
      (template) =>
        [...(template.aliases ?? []), ...(template.names ?? [])].includes(
          alias,
        ) && template.buildStatus === 'ready',
    )
  ) {
    console.log('Desktop template is already ready.');
    return;
  }
  const script =
    startup ??
    (await readFile(new URL('./desktop-start.sh', import.meta.url), 'utf8'));
  await Template.build(desktopRecipe(Template, image, script), alias, {
    apiUrl,
    apiKey,
    cpuCount,
    memoryMB,
    onBuildLogs: (entry) =>
      console.log(String(entry).replaceAll(apiKey, '[REDACTED]')),
  });
  console.log('Desktop template is ready.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { Template } = await import('e2b');
    await buildDesktopTemplate(Template);
  } catch (error) {
    console.error(
      'Desktop template build failed. Inspect the E2B API and orchestrator logs.',
    );
    console.error(error instanceof Error ? error.name : 'UnknownError');
    process.exitCode = 1;
  }
}
