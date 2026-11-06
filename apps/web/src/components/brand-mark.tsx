import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 480 480"
      fill="currentColor"
      className={cn('size-6 shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M339 12c13-5 27 3 27 18v97L124 203v163l-76 24c-18 6-31-4-31-22V153c0-19 9-33 27-39Z" />
      <path d="M435 135c17-9 29 0 29 16v183c0 17-8 28-23 35L195 468V279c0-20 7-30 24-40Z" />
    </svg>
  );
}
