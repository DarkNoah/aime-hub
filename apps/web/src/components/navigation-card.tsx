import type { ComponentType } from 'react';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';

/** Shared navigation for workspace and administration entry points. */
export function NavigationCard({
  to,
  title,
  description,
  icon: Icon,
}: {
  to: LinkProps['to'];
  title: string;
  description: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}) {
  return (
    <Link to={to} className="navigation-card group">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      <ArrowUpRight
        className="navigation-arrow size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
    </Link>
  );
}
