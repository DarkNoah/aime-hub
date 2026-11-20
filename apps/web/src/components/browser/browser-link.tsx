import { useContext, type ComponentProps } from 'react';
import { BrowserLinkOpenContext } from './layout-context';

/** Open loopback services in the browser that shares the workspace's network. */
export function BrowserLink({
  href,
  target,
  onClick,
  ...props
}: ComponentProps<'a'>) {
  const openBrowser = useContext(BrowserLinkOpenContext);
  const url = href && URL.canParse(href) ? new URL(href) : undefined;
  const local =
    url &&
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  return (
    <a
      {...props}
      href={href}
      target={local && openBrowser ? undefined : target}
      onClick={(event) => {
        onClick?.(event);
        if (
          !local ||
          !openBrowser ||
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        openBrowser(url.href);
      }}
    />
  );
}
