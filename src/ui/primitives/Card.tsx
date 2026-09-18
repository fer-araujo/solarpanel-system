import type { ReactNode } from "react";

interface CardProps {
  title?: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Card({ title, hint, action, children, className = "" }: CardProps) {
  return (
    <section
      className={`rounded-2xl border border-line/70 bg-surface/90 grain ${className}`}
    >
      {(title || action) && (
        <header className="flex items-baseline justify-between gap-4 px-5 pt-4 pb-1">
          <div>
            {title && (
              <h2 className="text-[13px] font-medium tracking-wide text-ink-dim uppercase">
                {title}
              </h2>
            )}
            {hint && <p className="mt-1 text-[12px] text-ink-faint">{hint}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="px-5 pt-2 pb-5">{children}</div>
    </section>
  );
}

interface StatProps {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  tone?: "solar" | "grid" | "batt" | "plain";
  className?: string;
}

const TONE: Record<NonNullable<StatProps["tone"]>, string> = {
  solar: "text-solar",
  grid: "text-grid",
  batt: "text-batt",
  plain: "text-ink",
};

export function Stat({ label, value, unit, detail, tone = "plain", className = "" }: StatProps) {
  return (
    <div className={`rounded-xl border border-line/50 bg-raised/60 px-4 py-3.5 ${className}`}>
      <p className="text-[11px] font-medium tracking-[0.08em] text-ink-faint uppercase">
        {label}
      </p>
      <p className="mt-2 flex items-baseline gap-1">
        <span className={`tnum text-[26px] leading-none font-medium ${TONE[tone]}`}>
          {value}
        </span>
        {unit && <span className="text-[13px] text-ink-dim">{unit}</span>}
      </p>
      {detail && <p className="mt-1.5 text-[12px] text-ink-faint">{detail}</p>}
    </div>
  );
}
