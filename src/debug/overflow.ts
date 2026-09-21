/**
 * On-device overflow finder, loaded only with `?debug=overflow`.
 *
 * Some phones overflow where desktop emulation does not (system font scaling,
 * browser zoom, real viewport quirks). This outlines every element that pokes
 * past the viewport and lists the worst offenders in a fixed panel, so a single
 * screenshot from the device says what to fix.
 */

function describe(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const className =
    typeof (element as HTMLElement).className === "string"
      ? (element as HTMLElement).className.split(/\s+/).slice(0, 4).join(".")
      : (element.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
  const text = (element.textContent ?? "").trim().slice(0, 24);
  return `${tag}${className ? `.${className}` : ""}${text ? ` "${text}"` : ""}`;
}

function scan(panel: HTMLElement): void {
  const width = document.documentElement.clientWidth;
  const offenders: { element: Element; right: number; left: number }[] = [];

  for (const element of document.body.querySelectorAll("*")) {
    if (panel.contains(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.right > width + 1 || rect.left < -1) {
      offenders.push({ element, right: Math.round(rect.right), left: Math.round(rect.left) });
    }
  }

  // Outermost offenders first: a child of an overflowing element is noise.
  const roots = offenders.filter(
    (candidate) => !offenders.some((other) => other !== candidate && other.element.contains(candidate.element)),
  );
  for (const { element } of offenders) (element as HTMLElement).style.outline = "1px solid red";

  const rootFont = getComputedStyle(document.documentElement).fontSize;
  const lines = [
    `viewport ${width}px · scrollWidth ${document.documentElement.scrollWidth}px`,
    `body scrollWidth ${document.body.scrollWidth}px · dpr ${window.devicePixelRatio}`,
    `zoom ${window.visualViewport?.scale.toFixed(2) ?? "?"} · root font ${rootFont}`,
    `${offenders.length} overflowing, ${roots.length} outermost:`,
    ...roots.slice(0, 8).map(({ element, left, right }) => `${left}→${right} ${describe(element)}`),
  ];
  panel.textContent = lines.join("\n");
}

export function startOverflowDebug(): void {
  const panel = document.createElement("pre");
  Object.assign(panel.style, {
    position: "fixed",
    left: "4px",
    right: "4px",
    bottom: "4px",
    zIndex: "9999",
    margin: "0",
    padding: "8px",
    maxHeight: "45vh",
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    font: "11px/1.35 monospace",
    color: "#fff",
    background: "rgba(120, 0, 0, 0.92)",
    borderRadius: "6px",
  });
  document.body.appendChild(panel);
  const run = () => scan(panel);
  setInterval(run, 2000);
  run();
}
