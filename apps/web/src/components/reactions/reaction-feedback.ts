import './reaction-feedback.css';

const easeOut = 'cubic-bezier(0.22, 1, 0.36, 1)';
const particles = [
  [-36, -26, -24],
  [-20, -52, 18],
  [10, -58, -15],
  [36, -38, 25],
  [43, -4, -12],
  [-40, 8, 16],
] as const;

/** Transient decoration only: never changes the reaction's data or layout. */
export function playReactionFeedback(
  anchor: HTMLElement,
  emoji: string,
  added: boolean,
): () => void {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const bounds = anchor.getBoundingClientRect();
  const viewport = anchor
    .closest('[data-slot="scroll-area-viewport"]')
    ?.getBoundingClientRect();
  const x = bounds.left + bounds.width / 2;
  const y = bounds.top + bounds.height / 2;
  if (
    motion.matches ||
    document.visibilityState === 'hidden' ||
    !anchor.checkVisibility() ||
    x < Math.max(0, viewport?.left ?? 0) ||
    x > Math.min(window.innerWidth, viewport?.right ?? window.innerWidth) ||
    y < Math.max(0, viewport?.top ?? 0) ||
    y > Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight)
  ) {
    return () => {};
  }
  // A visible scroll viewport can still be covered by the composer or a dialog.
  const hit = document.elementFromPoint(x, y);
  if (!hit || (!anchor.contains(hit) && !hit.contains(anchor))) {
    return () => {};
  }

  const animations: Animation[] = [];
  const events = new AbortController();
  let scene: HTMLSpanElement | undefined;
  const cleanup = () => {
    clearTimeout(timer);
    events.abort();
    for (const animation of animations) animation.cancel();
    scene?.remove();
  };
  const animate = (
    element: HTMLElement,
    frames: Keyframe[],
    duration: number,
    delay = 0,
  ) => {
    animations.push(
      element.animate(frames, {
        duration,
        delay,
        easing: easeOut,
        fill: 'both',
      }),
    );
  };

  animate(
    anchor,
    added
      ? [
          { transform: 'scale(1)' },
          { transform: 'scale(1.35) rotate(-12deg)', offset: 0.35 },
          { transform: 'scale(1) rotate(0)' },
        ]
      : [
          { transform: 'scale(1)' },
          { transform: 'scale(0.8)', offset: 0.35 },
          { transform: 'scale(1)' },
        ],
    added ? 360 : 180,
  );

  if (added) {
    // A fixed decoration layer escapes the message scroll area's clipping.
    // Cancel on scroll/resize so the effect never floats away from its message.
    scene = document.createElement('span');
    scene.className = 'reaction-feedback';
    scene.setAttribute('aria-hidden', 'true');
    const origin = document.createElement('span');
    origin.className = 'reaction-feedback-origin';
    origin.style.left = `${x}px`;
    origin.style.top = `${y}px`;
    scene.append(origin);
    const part = (className: string, text = '') => {
      const element = document.createElement('span');
      element.className = className;
      element.textContent = text;
      origin.append(element);
      return element;
    };
    const ring = part('reaction-feedback-ring');
    const hero = part('reaction-feedback-emoji', emoji);
    document.body.append(scene);
    animate(
      ring,
      [
        { transform: 'scale(0.3)', opacity: 0.6 },
        { transform: 'scale(1.8)', opacity: 0 },
      ],
      420,
    );
    animate(
      hero,
      [
        { transform: 'translateY(0) scale(0.4) rotate(-15deg)', opacity: 0 },
        {
          transform: 'translateY(-30px) scale(1.15) rotate(8deg)',
          opacity: 1,
          offset: 0.28,
        },
        {
          transform: 'translateY(-32px) scale(1) rotate(0)',
          opacity: 1,
          offset: 0.55,
        },
        { transform: 'translateY(-12px) scale(0.6)', opacity: 0 },
      ],
      680,
    );
    particles.forEach(([dx, dy, rotation], index) => {
      const particle = part(
        `reaction-feedback-particle ${index % 2 ? 'reaction-feedback-spark' : ''}`,
        index % 2 ? '✦' : emoji,
      );
      animate(
        particle,
        [
          { transform: 'translate(0, 0) scale(0.25)', opacity: 0 },
          { opacity: 1, offset: 0.12 },
          {
            transform: `translate(${dx}px, ${dy}px) scale(0.9) rotate(${rotation}deg)`,
            opacity: 0,
          },
        ],
        500,
        index * 16,
      );
    });
  }

  window.addEventListener('scroll', cleanup, {
    capture: true,
    passive: true,
    signal: events.signal,
  });
  window.addEventListener('resize', cleanup, { signal: events.signal });
  document.addEventListener('visibilitychange', cleanup, {
    signal: events.signal,
  });
  motion.addEventListener('change', cleanup, { signal: events.signal });
  const timer = setTimeout(cleanup, added ? 720 : 200);
  return cleanup;
}
