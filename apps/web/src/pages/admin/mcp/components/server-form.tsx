import { useTranslation } from 'react-i18next';
import { mcpOAuthCallbackPath } from '@aime/shared/mcp';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { McpForm } from '../config';

export function ServerForm({
  value,
  onChange,
  disabled,
}: {
  value: McpForm;
  onChange: (value: McpForm) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const id = `mcp-${value.key}`;
  const change = (patch: Partial<McpForm>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-[1fr_13rem]">
        <div className="space-y-2">
          <Label htmlFor={`${id}-name`}>{t('mcp.name')}</Label>
          <Input
            id={`${id}-name`}
            value={value.name}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            placeholder="chrome_devtools"
            onChange={(e) => change({ name: e.target.value })}
            aria-describedby={`${id}-name-hint`}
          />
          <p id={`${id}-name-hint`} className="text-xs text-muted-foreground">
            {t('mcp.nameHint')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-transport`}>{t('mcp.transport')}</Label>
          <Select
            value={value.transport}
            disabled={disabled}
            onValueChange={(transport) => {
              if (transport === 'stdio' || transport === 'http')
                change({ transport });
            }}
          >
            <SelectTrigger id={`${id}-transport`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">Stdio</SelectItem>
              <SelectItem value="http">Streamable HTTP / SSE</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {value.transport === 'stdio' ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${id}-command`}>command</Label>
            <Input
              id={`${id}-command`}
              value={value.command}
              placeholder="npx"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => change({ command: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-args`}>args</Label>
            <Textarea
              id={`${id}-args`}
              value={value.args}
              rows={4}
              className="font-mono text-xs"
              spellCheck={false}
              placeholder={
                '-y\nchrome-devtools-mcp@latest\n--browser-url=http://127.0.0.1:9222'
              }
              onChange={(e) => change({ args: e.target.value })}
              aria-describedby={`${id}-args-hint`}
            />
            <p id={`${id}-args-hint`} className="text-xs text-muted-foreground">
              {t('mcp.argsHint')}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-env`}>env</Label>
            <Textarea
              id={`${id}-env`}
              value={value.env}
              rows={3}
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
              placeholder="API_KEY=your-api-key"
              onChange={(e) => change({ env: e.target.value })}
              aria-describedby={`${id}-env-hint`}
            />
            <p id={`${id}-env-hint`} className="text-xs text-muted-foreground">
              {t('mcp.envHint')}
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${id}-url`}>url</Label>
            <Input
              id={`${id}-url`}
              value={value.url}
              placeholder="https://example.com/mcp"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => change({ url: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${id}-headers`}>headers</Label>
            <Textarea
              id={`${id}-headers`}
              value={value.headers}
              rows={4}
              className="font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
              placeholder="Authorization=Bearer your-token"
              onChange={(e) => change({ headers: e.target.value })}
              aria-describedby={`${id}-headers-hint`}
            />
            <p
              id={`${id}-headers-hint`}
              className="text-xs text-muted-foreground"
            >
              {t('mcp.headersHint')}
            </p>
          </div>
          <div className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor={`${id}-oauth`}>{t('mcp.oauth.enable')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('mcp.oauth.hint')}
                </p>
              </div>
              <Switch
                id={`${id}-oauth`}
                checked={value.oauth}
                disabled={disabled}
                onCheckedChange={(oauth) => change({ oauth })}
              />
            </div>
            {value.oauth ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor={`${id}-callback`}>
                    {t('mcp.oauth.callback')}
                  </Label>
                  <Input
                    id={`${id}-callback`}
                    readOnly
                    value={`${window.location.origin}${mcpOAuthCallbackPath}`}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-client-id`}>
                    {t('mcp.oauth.clientId')}
                  </Label>
                  <Input
                    id={`${id}-client-id`}
                    value={value.clientId}
                    disabled={disabled}
                    autoComplete="off"
                    onChange={(event) =>
                      change({ clientId: event.target.value })
                    }
                    placeholder={t('mcp.oauth.clientIdHint')}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-scope`}>{t('mcp.oauth.scope')}</Label>
                  <Input
                    id={`${id}-scope`}
                    value={value.scope}
                    disabled={disabled}
                    onChange={(event) => change({ scope: event.target.value })}
                    placeholder={t('mcp.oauth.scopeHint')}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
