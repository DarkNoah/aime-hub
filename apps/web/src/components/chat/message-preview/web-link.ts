export function webPreviewLink(href: string) {
  try {
    const url = new URL(href);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    return { href: url.href, hostname: url.hostname };
  } catch {
    return null;
  }
}
