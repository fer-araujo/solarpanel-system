import type { PowerSnapshot } from "@core/energy/model/power";
import { useMeasuredWidth } from "./useMeasuredWidth";

/**
 * Live energy routing. Each link's dashes march at a speed proportional to the
 * watts actually moving, and in the direction the sign says.
 *
 * Takes the DOMAIN snapshot, so `battery` and `grid` may be null — no battery
 * fitted, or no meter/CT so grid flow is unmeasurable. A null is drawn as an
 * inert node reading "no medible", never as a zero: a zero claims the grid is
 * idle, which is a different and possibly false statement.
 */

interface Point {
  x: number;
  y: number;
}

interface NodeSpec {
  id: string;
  at: Point;
  label: string;
  glyph: "sun" | "inverter" | "house" | "battery" | "grid";
  color: string;
}

const NODES: NodeSpec[] = [
  { id: "sun", at: { x: 96, y: 74 }, label: "Paneles", glyph: "sun", color: "var(--color-solar)" },
  { id: "inv", at: { x: 340, y: 196 }, label: "Inversor", glyph: "inverter", color: "var(--color-ink-dim)" },
  { id: "house", at: { x: 584, y: 196 }, label: "Casa", glyph: "house", color: "var(--color-ink)" },
  { id: "batt", at: { x: 340, y: 348 }, label: "Batería", glyph: "battery", color: "var(--color-batt)" },
  { id: "grid", at: { x: 96, y: 318 }, label: "Red", glyph: "grid", color: "var(--color-grid)" },
];

const LINKS = {
  pv: "M 128 100 C 196 138, 250 162, 302 184",
  house: "M 378 196 C 444 196, 494 196, 548 196",
  batt: "M 340 234 C 340 276, 340 296, 340 312",
  grid: "M 304 210 C 242 246, 178 286, 130 306",
} as const;

const NODE_R = 38;

function Glyph({ kind }: { kind: NodeSpec["glyph"] }) {
  const stroke = {
    stroke: "currentColor",
    strokeWidth: 1.6,
    fill: "none",
    strokeLinecap: "round" as const,
  };
  switch (kind) {
    case "sun":
      return (
        <g {...stroke}>
          <circle cx="0" cy="0" r="7.5" />
          {Array.from({ length: 8 }, (_, i) => {
            const a = (i / 8) * Math.PI * 2;
            return (
              <line
                key={i}
                x1={Math.cos(a) * 11}
                y1={Math.sin(a) * 11}
                x2={Math.cos(a) * 15}
                y2={Math.sin(a) * 15}
              />
            );
          })}
        </g>
      );
    case "inverter":
      return (
        <g {...stroke}>
          <rect x="-11" y="-13" width="22" height="26" rx="3" />
          <path d="M -5 -5 L 1 -5 L -2 1 L 5 1 L -1 8" />
        </g>
      );
    case "house":
      return (
        <g {...stroke}>
          <path d="M -12 -1 L 0 -11 L 12 -1" />
          <path d="M -8.5 -1 L -8.5 11 L 8.5 11 L 8.5 -1" />
          <path d="M -2.5 11 L -2.5 3.5 L 2.5 3.5 L 2.5 11" />
        </g>
      );
    case "battery":
      return (
        <g {...stroke}>
          <rect x="-13" y="-7" width="23" height="14" rx="2.5" />
          <path d="M 12.5 -3 L 12.5 3" />
          <path d="M -8 0 L 5 0" />
        </g>
      );
    case "grid":
      return (
        <g {...stroke}>
          <path d="M -9 12 L -4 -11 L 4 -11 L 9 12" />
          <path d="M -6.5 2 L 6.5 2 M -7.8 -4.5 L 7.8 -4.5" />
          <path d="M -4 -11 L 4 2 M 4 -11 L -4 2" />
        </g>
      );
  }
}

interface FlowProps {
  path: string;
  id: string;
  /** null = unmeasurable, which draws an inert link rather than an idle one. */
  watts: number | null;
  color: string;
  reverse: boolean;
  maxWatts: number;
}

function Flow({ path, id, watts, color, reverse, maxWatts }: FlowProps) {
  const active = watts !== null && watts > 40;
  const intensity = watts === null ? 0 : Math.min(1, watts / Math.max(maxWatts, 1));
  const count = active ? Math.max(1, Math.min(7, Math.round(watts / 850))) : 0;
  const dur = 4.6 - intensity * 3.1;

  return (
    <g>
      {/*
        An idle link is drawn as a clean dashed path rather than a nearly
        invisible one. At 0.09 opacity it read as a rendering artifact — "the
        route exists, nothing is moving" is the honest statement, and it should
        look deliberate, not broken.
      */}
      <path
        id={id}
        d={path}
        fill="none"
        stroke={watts === null ? "var(--color-line)" : color}
        strokeWidth={active ? 1.2 + intensity * 1.6 : 1}
        strokeOpacity={active ? 0.26 + intensity * 0.2 : 0.3}
        strokeLinecap="round"
        strokeDasharray={active ? undefined : "2 6"}
      />
      {Array.from({ length: count }, (_, i) => (
        <circle key={i} r={2 + intensity * 1.5} fill={color}>
          <animateMotion
            dur={`${dur}s`}
            begin={`${(i * dur) / count}s`}
            repeatCount="indefinite"
            keyPoints={reverse ? "1;0" : "0;1"}
            keyTimes="0;1"
            calcMode="linear"
          >
            <mpath href={`#${id}`} />
          </animateMotion>
          <animate
            attributeName="opacity"
            values="0;1;1;0"
            keyTimes="0;0.12;0.88;1"
            dur={`${dur}s`}
            begin={`${(i * dur) / count}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </g>
  );
}

function fmtKw(watts: number | null): string {
  if (watts === null) return "—";
  const kw = Math.abs(watts) / 1000;
  return kw >= 10 ? kw.toFixed(1) : kw.toFixed(2);
}

interface EnergyFlowProps {
  snapshot: PowerSnapshot;
  /**
   * Hardware that is ABSENT is omitted entirely, which is different from
   * hardware that exists but cannot be measured. Drawing a battery node with a
   * dash on a system that has no battery invites the reader to wonder what
   * broke.
   */
  hasBattery?: boolean;
  hasGridMetering?: boolean;
  /**
   * Whether the sun is above the horizon right now. Zero production at 03:00 is
   * expected and at 13:00 is a fault; without this the diagram cannot tell the
   * reader which one they are looking at.
   */
  isDaylight?: boolean;
  sunrise?: string;
  /**
   * Latest CFE meter reading entered by hand. With no meter in the system it
   * is the only grid figure there is, so the grid node shows it — dated, so
   * it never passes for a live value.
   */
  lastReading?: { importRegister: number; exportRegister: number; takenOn: string } | null;
  /**
   * Average house load in watts, from the energy balance of the meter
   * readings. Shown on the house node when nothing measures it live, marked as
   * an estimate (dashed ring, "~").
   */
  estimatedLoadWatts?: number | null;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""}`;

export function EnergyFlow({
  snapshot,
  hasBattery = true,
  hasGridMetering = true,
  isDaylight,
  sunrise,
  lastReading = null,
  estimatedLoadWatts = null,
}: EnergyFlowProps) {
  const { pv, battery, soc } = snapshot;
  /**
   * With no meter, the readings' average load stands in for the house, and the
   * grid follows from it: grid = load - production (positive = importing).
   * Every value derived this way is marked "~" and drawn with a dashed ring.
   */
  const estimating =
    snapshot.load === null && snapshot.grid === null && !hasBattery && estimatedLoadWatts !== null;
  const load = estimating ? estimatedLoadWatts : snapshot.load;
  const grid = estimating && load !== null ? load - pv : snapshot.grid;
  const importing = (grid ?? 0) > 40;
  // The diagram scales down as a whole on a phone; enlarge the nodes to stay
  // legible, and drop the secondary captions that would then collide.
  const [measureRef, width] = useMeasuredWidth(680);
  const narrow = width < 520;
  const k = narrow ? 1.5 : 1;

  /**
   * With no battery, every watt produced goes to the house or the grid — that
   * much is certain. What is unknown without a meter is the SPLIT. So both links
   * animate (each at half intensity, since the split is unknown) and the
   * captions say so, rather than drawing a dead diagram while energy is moving.
   */
  const unsplit = !hasGridMetering && !hasBattery && grid === null && pv > 40;
  const maxWatts = Math.max(
    pv,
    load ?? 0,
    Math.abs(battery ?? 0),
    Math.abs(grid ?? 0),
    1000,
  );

  const values: Record<string, number | null> = {
    sun: pv,
    // At night the grid feeds the house through the same node, so it shows that flow.
    inv: importing && estimating ? load : pv,
    house: load,
    batt: battery === null ? null : Math.abs(battery),
    grid: grid === null ? null : Math.abs(grid),
  };

  const readingLines =
    !hasGridMetering && lastReading
      ? estimating
        ? [
            `lectura ${shortDate(lastReading.takenOn)}`,
            // Shorter on phones, where the node is scaled up and the text would
            // run past the card's edge.
            narrow
              ? `imp ${lastReading.importRegister} · exp ${lastReading.exportRegister}`
              : `imp. ${lastReading.importRegister} · exp. ${lastReading.exportRegister} kWh`,
          ]
        : [`imp. ${lastReading.importRegister} kWh`, `exp. ${lastReading.exportRegister} kWh`]
      : null;

  // The grid node sits low and carries up to three lines of text; on a phone
  // the node is scaled up too. The canvas grows to hold them inside the card.
  const gridTextLines = 1 + (readingLines?.length ?? 0);
  const height = Math.max(408, Math.ceil(318 + k * (NODE_R + 17 + gridTextLines * 14 + 6)));

  const captions: Record<string, string> = {
    sun:
      pv > 40
        ? "generando"
        : isDaylight === false
          ? sunrise
            ? `de noche · amanece ${sunrise}`
            : "de noche"
          : isDaylight === true
            ? "sol arriba, sin producción"
            : "sin producción",
    inv: estimating && importing ? "desde la red" : soc === null ? "MPPT activo" : `${soc.toFixed(0)}% batería`,
    house: estimating
      ? "promedio de tus lecturas"
      : load !== null
        ? "consumiendo"
        : unsplit ? "recibe una parte · sin medir" : "requiere medidor",
    batt:
      battery === null
        ? "sin batería"
        : battery < -40
          ? "cargando"
          : battery > 40
            ? "descargando"
            : "en reposo",
    grid: estimating && grid !== null
      ? grid < -40
        ? "exportando aprox."
        : grid > 40
          ? "importando aprox."
          : "sin flujo aprox."
      : !hasGridMetering && lastReading
      ? `última lectura · ${shortDate(lastReading.takenOn)}`
      : unsplit
      ? "recibe el excedente · sin medir"
      : !hasGridMetering
      ? "sin medidor · ver CFE"
      : grid === null
        ? "no medible"
        : grid < -40
          ? "exportando"
          : grid > 40
            ? "importando"
            : "sin flujo",
  };

  return (
    <svg ref={measureRef} viewBox={`0 0 680 ${height}`} className="w-full" overflow="visible" role="img">
      <title>Flujo de energía en tiempo real</title>
      <defs>
        <radialGradient id="haze" cx="50%" cy="50%">
          <stop offset="0%" stopColor="var(--color-solar)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--color-solar)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx="96" cy="74" r="96" fill="url(#haze)" />

      <Flow id="f-pv" path={LINKS.pv} watts={pv} color="var(--color-solar)" reverse={false} maxWatts={maxWatts} />
      <Flow
        id="f-house"
        path={LINKS.house}
        watts={load ?? (unsplit ? pv / 2 : null)}
        color={importing ? "var(--color-grid)" : "var(--color-solar-lift)"}
        reverse={false}
        maxWatts={maxWatts}
      />
      {hasBattery && (
        <Flow
          id="f-batt"
          path={LINKS.batt}
          watts={battery === null ? null : Math.abs(battery)}
          color="var(--color-batt)"
          reverse={(battery ?? 0) > 0}
          maxWatts={maxWatts}
        />
      )}
      <Flow
        id="f-grid"
        path={LINKS.grid}
        watts={grid === null ? (unsplit ? pv / 2 : null) : Math.abs(grid)}
        color={importing || !estimating ? "var(--color-grid)" : "var(--color-solar)"}
        reverse={(grid ?? 0) > 0}
        maxWatts={maxWatts}
      />

      {NODES.filter((node) => node.id !== "batt" || hasBattery).map((node) => {
        const watts = values[node.id] ?? null;
        const live = watts !== null && watts > 40;
        const unavailable = watts === null;
        const estimated =
          estimating && (node.id === "house" || node.id === "grid" || (node.id === "inv" && importing));
        // Inverter and house take the colour of the energy feeding the house.
        const color =
          grid !== null && (node.id === "inv" || node.id === "house")
            ? importing
              ? "var(--color-grid)"
              : "var(--color-solar)"
            : node.color;
        return (
          <g key={node.id} transform={`translate(${node.at.x} ${node.at.y}) scale(${k})`}>
            <circle r={NODE_R} fill="var(--color-void)" />
            <circle
              r={NODE_R}
              fill="var(--color-raised)"
              fillOpacity="0.85"
              stroke={live ? color : "var(--color-line)"}
              strokeWidth="1"
              strokeOpacity={live ? 0.55 : 0.5}
              strokeDasharray={unavailable || estimated ? "3 4" : undefined}
            />
            <g style={{ color: live ? color : "var(--color-ink-faint)" }}>
              <g transform="translate(0 -9)">
                <Glyph kind={node.glyph} />
              </g>
            </g>
            <text
              y="17"
              textAnchor="middle"
              className="tnum"
              fontSize="13"
              fontWeight="500"
              fill={live ? "var(--color-ink)" : "var(--color-ink-faint)"}
            >
              {estimated ? `~${fmtKw(watts)}` : fmtKw(watts)}
            </text>
            {!unavailable && (
              <text y="27" textAnchor="middle" fontSize="8" fill="var(--color-ink-faint)">
                kW
              </text>
            )}
            <text
              y={NODE_R + 17}
              textAnchor="middle"
              fontSize="12"
              fontWeight="500"
              fill="var(--color-ink-dim)"
            >
              {node.label}
            </text>
            {(!narrow || (node.id === "grid" && readingLines)) && (
              <text y={NODE_R + 31} textAnchor="middle" fontSize="11" fill="var(--color-ink-faint)">
                {captions[node.id]}
              </text>
            )}
            {node.id === "grid" &&
              readingLines?.map((line, i) => (
                <text key={line} y={NODE_R + 45 + i * 14} textAnchor="middle" className="tnum" fontSize="11"
                  fill="var(--color-grid)">
                  {line}
                </text>
              ))}
          </g>
        );
      })}
    </svg>
  );
}
