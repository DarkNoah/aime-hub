import { useState } from 'react';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  ScrollArea,
} from '@app/plugin-ui';
import { ChevronDown, Settings2 } from 'lucide-react';
import { INDICATORS } from './registry';
import { IndicatorSettingsDialog } from './settings-dialog';
import type {
  IndicatorParameters,
  IndicatorPreferences,
  IndicatorType,
} from './types';

const GROUPS: { type: IndicatorType; label: string }[] = [
  { type: 'main', label: '主图指标' },
  { type: 'sub', label: '副图指标' },
];

export function IndicatorControls({
  preferences,
  onVisibleChange,
  onParametersChange,
  intraday = false,
}: {
  preferences: IndicatorPreferences;
  onVisibleChange: (id: string, visible: boolean) => void;
  onParametersChange: (id: string, parameters: IndicatorParameters) => void;
  intraday?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const definition = INDICATORS.find((indicator) => indicator.id === editing);
  return (
    <>
      <div className="flex shrink-0 items-center gap-2" aria-label="图表指标">
        {GROUPS.map((group) => {
          const indicators = INDICATORS.filter(
            (indicator) => indicator.type === group.type,
          );
          const visible = indicators.filter(
            (indicator) =>
              preferences[indicator.id].visible &&
              !(intraday && indicator.requiresCandles),
          ).length;
          return (
            <DropdownMenu key={group.type}>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 px-2 text-xs"
                  aria-label={group.label}
                >
                  <span>
                    {group.type === 'main' ? '主图' : '副图'}
                    <span className="hidden @min-[460px]/chart-toolbar:inline">
                      指标
                    </span>
                  </span>
                  <Badge
                    variant="secondary"
                    className="px-1.5 tabular-nums @max-[300px]/chart-toolbar:hidden"
                  >
                    {visible}
                  </Badge>
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-64 max-w-[calc(100vw-2rem)] overflow-hidden motion-reduce:animate-none"
              >
                <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
                <ScrollArea
                  viewportProps={{ className: 'max-h-[min(60dvh,360px)]' }}
                >
                  {indicators.map((indicator) => (
                    <div key={indicator.id} className="flex items-center gap-1">
                      <DropdownMenuCheckboxItem
                        className="min-w-0 flex-1"
                        checked={
                          preferences[indicator.id].visible &&
                          !(intraday && indicator.requiresCandles)
                        }
                        disabled={intraday && indicator.requiresCandles}
                        onCheckedChange={(checked) =>
                          onVisibleChange(indicator.id, checked)
                        }
                        onSelect={(event) => event.preventDefault()}
                      >
                        {indicator.name}
                        {intraday && indicator.requiresCandles && (
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            仅 K 线
                          </span>
                        )}
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuItem
                        asChild
                        onSelect={() => setEditing(indicator.id)}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                          aria-label={`设置 ${indicator.name}`}
                          title={`设置 ${indicator.name}`}
                        >
                          <Settings2 className="size-4" />
                        </Button>
                      </DropdownMenuItem>
                    </div>
                  ))}
                </ScrollArea>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}
      </div>
      {definition && (
        <IndicatorSettingsDialog
          key={definition.id}
          definition={definition}
          parameters={preferences[definition.id].parameters}
          onClose={() => setEditing(null)}
          onSave={(parameters) => onParametersChange(definition.id, parameters)}
        />
      )}
    </>
  );
}
