/**
 * Loading placeholders shaped like what they stand in for, so the layout does
 * not jump when data lands.
 */

export function Bone({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Screen-reader text for a region that is loading. */
function Loading({ label }: { label: string }) {
  return <span className="sr-only" role="status">{label}</span>;
}

export function GaugeSkeleton() {
  return (
    <div className="flex flex-col items-center gap-4 py-2">
      <Loading label="Cargando potencia solar" />
      <div className="skeleton h-[190px] w-[190px] rounded-full" />
      <Bone className="h-3 w-32" />
    </div>
  );
}

export function FlowSkeleton() {
  return (
    <div className="relative aspect-[680/408] w-full">
      <Loading label="Cargando flujo de energía" />
      {[
        "left-[8%] top-[8%]",
        "left-[44%] top-[38%]",
        "left-[80%] top-[38%]",
        "left-[8%] top-[68%]",
        "left-[44%] top-[76%]",
      ].map((position) => (
        <div key={position} className={`skeleton absolute h-[18%] w-[11%] rounded-full ${position}`} />
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = "h-[260px]" }: { height?: string }) {
  const bars = [30, 55, 42, 70, 85, 62, 90, 74, 48, 66, 38, 58];
  return (
    <div className={`flex items-end gap-2 ${height}`}>
      <Loading label="Cargando gráfica" />
      {bars.map((h, i) => (
        <div key={i} className="skeleton flex-1 rounded-md" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

export function StatSkeleton() {
  return (
    <div className="rounded-xl border border-line/50 bg-raised/40 px-4 py-3.5">
      <Bone className="h-2.5 w-20" />
      <Bone className="mt-3 h-6 w-16" />
      <Bone className="mt-2.5 h-2.5 w-24" />
    </div>
  );
}

export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5">
      <Loading label="Cargando" />
      {Array.from({ length: rows }, (_, i) => (
        <Bone key={i} className="h-14 w-full rounded-xl" />
      ))}
    </div>
  );
}
