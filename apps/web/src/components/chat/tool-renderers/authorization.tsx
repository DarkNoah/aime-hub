import { useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { LogIn, ShieldCheck, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { mcpAuthorizationSchema } from '@aime/shared/mcp';
import { api } from '@/lib/rpc';
import { SessionContext } from '@/features/auth/session-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ToolInteractionProps } from '../chat-tool-interaction';
import { useToolResponse } from './use-tool-response';

const payloadSchema = z.object({
  services: z.array(mcpAuthorizationSchema),
  reason: z.string().optional(),
  userId: z.string().optional(),
});
const outputSchema = payloadSchema.partial().extend({
  authorized: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  error: z.string().optional(),
});

export function AuthorizationCard(props: ToolInteractionProps) {
  const { t } = useTranslation();
  const session = useContext(SessionContext);
  const payload = payloadSchema.safeParse(
    props.interaction?.suspendPayload,
  ).data;
  const output =
    props.tool?.state === 'output-available'
      ? outputSchema.safeParse(props.tool.output).data
      : undefined;
  const services = payload?.services ?? output?.services ?? [];
  const owner =
    !!session?.data?.user.id && session.data.user.id === payload?.userId;
  const done =
    props.tool?.state === 'output-available' ||
    props.tool?.state === 'output-error' ||
    props.tool?.state === 'output-denied' ||
    !!props.interaction?.response;
  const response = useToolResponse({
    ...props,
    disabled: props.disabled || !owner || done,
  });
  const [starting, setStarting] = useState<string>();
  const startingRef = useRef(false);
  const handledCallback = useRef(false);
  const busy = response.unavailable || !!starting;

  async function complete(mcpId: string) {
    try {
      const current = await api.mcpAuth.get({ params: { id: mcpId } });
      if (current.authStatus !== 'authorized') {
        toast.error(t('mcp.oauth.requiredHint'));
        return;
      }
      await response.submit({ action: 'resume', data: { mcpId } });
    } catch {
      toast.error(t('mcp.oauth.failed'));
    }
  }

  useEffect(() => {
    if (!owner || response.unavailable || handledCallback.current) return;
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('mcp_oauth');
    const id = url.searchParams.get('server');
    if (!outcome || !id || !services.some((service) => service.id === id))
      return;
    handledCallback.current = true;
    url.searchParams.delete('mcp_oauth');
    url.searchParams.delete('server');
    window.history.replaceState(window.history.state, '', url);
    if (outcome === 'success' || outcome === 'connection-failed')
      void complete(id);
    else
      toast.error(
        t(outcome === 'denied' ? 'mcp.oauth.denied' : 'mcp.oauth.failed'),
      );
  });

  async function login(id: string) {
    if (busy || startingRef.current) return;
    startingRef.current = true;
    setStarting(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('mcp_oauth');
      url.searchParams.delete('server');
      const result = await api.mcpAuth.authorize({
        params: { id },
        body: { returnTo: `${url.pathname}${url.search}` },
      });
      window.location.assign(result.authorizationUrl);
    } catch {
      startingRef.current = false;
      setStarting(undefined);
      toast.error(t('mcp.oauth.failed'));
    }
  }

  return (
    <section
      className="my-3 min-w-0 overflow-hidden rounded-xl border bg-card text-sm"
      aria-label={t('chat.authorization.title')}
    >
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-3">
        <ShieldCheck className="size-4 text-primary" />
        <span className="font-medium">{t('chat.authorization.title')}</span>
        {done ? (
          <Badge variant="secondary" className="ml-auto">
            {t(
              output?.authorized
                ? 'mcp.oauth.authorized'
                : output?.cancelled
                  ? 'chat.authorization.cancelled'
                  : 'chat.authorization.finished',
            )}
          </Badge>
        ) : null}
      </div>
      <div className="space-y-2 px-4 pt-3">
        {payload?.reason ? (
          <p className="break-words">{payload.reason}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t('chat.authorization.private')}
        </p>
        {output?.error ? (
          <p role="alert" className="text-destructive">
            {output.error}
          </p>
        ) : null}
        {!done && payload && !owner ? (
          <p className="text-xs text-muted-foreground">
            {t('chat.authorization.ownerOnly')}
          </p>
        ) : null}
      </div>
      <ScrollArea
        className="max-h-72"
        viewportProps={{ className: 'max-h-72' }}
      >
        <div className="divide-y px-4">
          {services.map((service) => (
            <div
              key={service.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className="break-all font-medium">{service.name}</p>
                {!done ? (
                  <Badge variant="outline">
                    {t(
                      service.authStatus === 'authorized'
                        ? 'mcp.oauth.authorized'
                        : 'mcp.oauth.required',
                    )}
                  </Badge>
                ) : null}
              </div>
              {!done ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => void login(service.id)}
                  >
                    {starting === service.id ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <LogIn />
                    )}
                    {t('mcp.oauth.authorize')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void complete(service.id)}
                  >
                    {t('chat.authorization.check')}
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </ScrollArea>
      {!done && payload ? (
        <div className="flex justify-end border-t px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void response.submit({
                action: 'resume',
                data: { cancelled: true },
              })
            }
          >
            {t('mcp.cancel')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
