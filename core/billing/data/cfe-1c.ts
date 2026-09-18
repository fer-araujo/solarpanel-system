import { assertScheduleWellFormed, type Tariff } from "../model/tariff";

/**
 * CFE tariff 1C — residential, localities averaging 30 °C in summer.
 *
 * IMPORTANT: these block widths and prices are a starting point gathered from
 * public secondary sources, NOT from a bill. They move every period and vary by
 * region, which is why `provenance.verified` is false. Replace them with the
 * blocks printed on an actual recibo before trusting any peso figure; the
 * structure is what the code depends on, the numbers are data.
 *
 * The DAC limit is the load-bearing number here and comes from CFE directly:
 * a trailing 12-month average above 850 kWh/month moves a 1C account to DAC.
 * https://www.cfe.gob.mx/hogar/infcliente/Documents/tarifaaltoconsumo.pdf
 */
export const CFE_1C: Tariff = {
  code: "1C",
  currency: "MXN",

  /**
   * VERIFIED against the account's own bill, period 08 JUN 26 – 06 AGO 26:
   * 2,188 kWh billed as 300 + 300 + 300 + 1,288 at 1.010 / 1.171 / 1.505 /
   * 4.016, energy subtotal $6,278.41 before IVA. Widths are per BIMESTER.
   *
   * The excedente at 4.016 MXN/kWh is the number that matters: solar removes
   * kWh from the top of the bill, so this is the price every displaced kWh is
   * worth while consumption stays above 900 kWh per bimester.
   */
  summer: {
    label: "1C verano",
    fixedCharge: 0,
    verified: true,
    source: "Recibo CFE, periodo 08 JUN 26 – 06 AGO 26",
    blocks: [
      { upToKwh: 300, pricePerKwh: 1.01, label: "básico" },
      { upToKwh: 600, pricePerKwh: 1.171, label: "intermedio 1" },
      { upToKwh: 900, pricePerKwh: 1.505, label: "intermedio 2" },
      { upToKwh: null, pricePerKwh: 4.016, label: "excedente" },
    ],
  },

  /** NOT yet verified: needs a bill from outside the summer season. */
  nonSummer: {
    label: "1C fuera de verano",
    fixedCharge: 0,
    verified: false,
    blocks: [
      { upToKwh: 75, pricePerKwh: 0.956, label: "básico" },
      { upToKwh: 200, pricePerKwh: 1.154, label: "intermedio" },
      { upToKwh: null, pricePerKwh: 2.802, label: "excedente" },
    ],
  },

  dacLimitKwhPerMonth: 850,

  dac: {
    label: "DAC",
    fixedCharge: 142.41,
    blocks: [{ upToKwh: null, pricePerKwh: 6.5, label: "DAC sin subsidio" }],
  },

  provenance: {
    source:
      "Secondary public sources for block prices; DAC limit from cfe.gob.mx tarifaaltoconsumo.pdf",
    note:
      "Summer blocks verified against a real recibo. Non-summer blocks and the DAC price are still from secondary sources.",
    verified: false,
  },
};

assertScheduleWellFormed(CFE_1C.summer);
assertScheduleWellFormed(CFE_1C.nonSummer);
assertScheduleWellFormed(CFE_1C.dac);
