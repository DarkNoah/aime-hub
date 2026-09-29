'use client';

import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
import {
  type CSSProperties,
  type ElementType,
  type JSX,
  memo,
  useMemo,
} from 'react';

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
};

const createMotionComponent = (component: ElementType) =>
  motion.create(component as keyof JSX.IntrinsicElements);

const motionComponents = new Map<
  ElementType,
  ReturnType<typeof createMotionComponent>
>();

const getMotionComponent = (component: ElementType) => {
  let cached = motionComponents.get(component);
  if (!cached) {
    cached = createMotionComponent(component);
    motionComponents.set(component, cached);
  }
  return cached;
};

const ShimmerComponent = ({
  children,
  as: Component = 'p',
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const MotionComponent = getMotionComponent(Component);

  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread],
  );

  return (
    // eslint-disable-next-line react-hooks/static-components -- The module-level cache preserves component identity for each `as` type across renders.
    <MotionComponent
      animate={{ backgroundPosition: '0% center' }}
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
        '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      style={
        {
          '--spread': `${dynamicSpread}px`,
          backgroundImage:
            'var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
        } as CSSProperties
      }
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: 'linear',
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
