import type { ComponentProps } from 'react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export function Slider({
  className,
  value,
  defaultValue = [0],
  min = 0,
  max = 100,
  thumbProps,
  ...props
}: ComponentProps<typeof SliderPrimitive.Root> & {
  thumbProps?: Pick<
    ComponentProps<typeof SliderPrimitive.Thumb>,
    'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-valuetext'
  >;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      className={cn(
        'relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5">
        <SliderPrimitive.Range className="absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full" />
      </SliderPrimitive.Track>
      {(value ?? defaultValue).map((_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          {...thumbProps}
          className="block size-4 shrink-0 rounded-full border border-primary bg-background outline-none transition-shadow hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  );
}
