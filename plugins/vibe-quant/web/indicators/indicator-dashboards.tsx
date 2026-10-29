import { Badge, ScrollArea } from '@app/plugin-ui';
import type { IndicatorDashboard } from './types';

const positions = ['top-center', 'top-right', 'right-center'] as const;
const placement = {
  'top-center':
    'top-2 left-2 @min-[700px]/indicator-panels:left-1/2 @min-[700px]/indicator-panels:-translate-x-1/2',
  'top-right': 'top-2 right-16',
  'right-center': 'top-1/2 right-16 -translate-y-1/2',
};

/** Shared chart panels: same-position tables stack instead of covering each other. */
export function IndicatorDashboards({
  dashboards,
}: {
  dashboards: IndicatorDashboard[];
}) {
  if (!dashboards.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 @container/indicator-panels">
      {positions.map((position) => {
        const items = dashboards.filter((panel) => panel.position === position);
        if (!items.length) return null;
        return (
          <div
            key={position}
            className={`absolute w-44 max-w-[calc(50%-2.5rem)] ${placement[position]}`}
          >
            <ScrollArea
              className="pointer-events-auto"
              viewportProps={{ className: 'max-h-64 [&>div]:!block' }}
            >
              <div className="space-y-2 pr-2">
                {items.map((panel) => (
                  <section
                    key={panel.id}
                    aria-label={panel.title}
                    className="w-full min-w-0 rounded-md border bg-card/95 px-2.5 py-2 text-[11px] text-foreground"
                  >
                    <p className="mb-1.5 font-semibold">{panel.title}</p>
                    <dl className="space-y-1">
                      {panel.rows.map((row) => (
                        <div
                          key={row.label}
                          className="flex flex-wrap items-center justify-between gap-x-2"
                        >
                          <dt className="text-muted-foreground">{row.label}</dt>
                          <dd className="break-all tabular-nums">
                            {row.status ? (
                              <Badge
                                variant="secondary"
                                className="px-1 py-0 text-[10px]"
                              >
                                {row.value}
                              </Badge>
                            ) : (
                              row.value
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {panel.note && (
                      <p className="mt-2 border-t pt-1.5 text-[10px] text-muted-foreground">
                        {panel.note}
                      </p>
                    )}
                  </section>
                ))}
              </div>
            </ScrollArea>
          </div>
        );
      })}
    </div>
  );
}
