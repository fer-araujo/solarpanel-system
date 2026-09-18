import type { ReactNode } from "react";

/**
 * Floating readout that follows the cursor inside a chart.
 *
 * Replaces the readout strip under the charts, which forced the eye to leave
 * the data to read it. Flips to the left of the cursor past the midpoint so it
 * never runs off the edge.
 */
export function ChartTooltip({ xPct, children }: { xPct: number; children: ReactNode }) {
  const flip = xPct > 55;
  return (
    <div
      className="pointer-events-none absolute top-3 z-10 min-w-[150px] rounded-lg border border-line bg-raised/95 px-3 py-2 text-[12px] shadow-lg shadow-black/40 backdrop-blur"
      style={{
        left: `${xPct}%`,
        transform: flip ? "translateX(calc(-100% - 14px))" : "translateX(14px)",
      }}
    >
      {children}
    </div>
  );
}

export function TooltipRow({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <span className="flex items-center gap-1.5 text-ink-dim">
        {color && <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
        {label}
      </span>
      <span className="tnum text-ink">{value}</span>
    </div>
  );
}
