import { useCallback, useRef, useState } from "react";

/**
 * Width of an element in CSS pixels, kept current with a ResizeObserver.
 *
 * Charts draw in real pixels instead of scaling a fixed viewBox, so labels
 * stay legible on a phone instead of shrinking to a third of their size.
 * A callback ref, so it also works when the element mounts after a loading
 * or empty state.
 */
export function useMeasuredWidth(fallback: number) {
  const [width, setWidth] = useState(fallback);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((element: Element | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    const update = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    update();
    observer.current = new ResizeObserver(update);
    observer.current.observe(element);
  }, []);

  return [ref, width] as const;
}
