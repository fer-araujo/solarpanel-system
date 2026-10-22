import {
  assertScheduleWellFormed,
  type Tariff,
  type TariffVersion,
} from "../model/tariff";

/**
 * CFE tariff 1C — residential, localities averaging 30 °C in summer.
 *
 * The summer blocks are copied from the account's own bills, one dated version
 * per recibo, because CFE moves the prices every period: pricing the October
 * bill with June's prices missed it by hundreds of pesos. Each period is priced
 * with the version in force when it was cut; estimates of the future use the
 * latest.
 *
 * The non-summer blocks and the DAC price are still from public secondary
 * sources, which is why `provenance.verified` stays false until a bill from
 * outside the summer season confirms them.
 *
 * The DAC limit is the load-bearing number here and comes from CFE directly:
 * a trailing 12-month average above 850 kWh/month moves a 1C account to DAC.
 * https://www.cfe.gob.mx/hogar/infcliente/Documents/tarifaaltoconsumo.pdf
 */

/**
 * VERIFIED against the bill for 08 JUN 26 – 06 AGO 26: 2,188 kWh billed as
 * 300 + 300 + 300 + 1,288 at 1.010 / 1.171 / 1.505 / 4.016, energy subtotal
 * $6,278.41 before IVA. Widths are per BIMESTER.
 */
export const SUMMER_JUN_AGO_26: TariffVersion = {
  label: "1C verano",
  effectiveFrom: "2026-06-08",
  fixedCharge: 0,
  verified: true,
  source: "Recibo CFE, periodo 08 JUN 26 – 06 AGO 26",
  blocks: [
    { upToKwh: 300, pricePerKwh: 1.01, label: "básico" },
    { upToKwh: 600, pricePerKwh: 1.171, label: "intermedio 1" },
    { upToKwh: 900, pricePerKwh: 1.505, label: "intermedio 2" },
    { upToKwh: null, pricePerKwh: 4.016, label: "excedente" },
  ],
};

/**
 * VERIFIED against the bill for 06 AGO 26 – 07 OCT 26: 1,792 kWh billed as
 * 300 + 300 + 300 + 892 at 1.016 / 1.179 / 1.515 / 4.041, energy $4,717.57,
 * IVA $754.81, total $5,472.38.
 *
 * The excedente is the number that matters: solar removes kWh from the top of
 * the bill, so this is what every displaced kWh is worth while consumption
 * stays above 900 kWh per bimester.
 */
export const SUMMER_AGO_OCT_26: TariffVersion = {
  label: "1C verano",
  effectiveFrom: "2026-08-06",
  fixedCharge: 0,
  verified: true,
  source: "Recibo CFE, periodo 06 AGO 26 – 07 OCT 26",
  blocks: [
    { upToKwh: 300, pricePerKwh: 1.016, label: "básico" },
    { upToKwh: 600, pricePerKwh: 1.179, label: "intermedio 1" },
    { upToKwh: 900, pricePerKwh: 1.515, label: "intermedio 2" },
    { upToKwh: null, pricePerKwh: 4.041, label: "excedente" },
  ],
};

const SUMMER_VERSIONS = [SUMMER_JUN_AGO_26, SUMMER_AGO_OCT_26] as const;

export const CFE_1C: Tariff = {
  code: "1C",
  currency: "MXN",

  summer: SUMMER_VERSIONS[SUMMER_VERSIONS.length - 1] ?? SUMMER_AGO_OCT_26,
  summerVersions: SUMMER_VERSIONS,

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
      "Summer blocks from the account's recibos; non-summer blocks from secondary public sources; DAC limit from cfe.gob.mx tarifaaltoconsumo.pdf",
    note:
      "Summer blocks verified against real recibos. Non-summer blocks and the DAC price are still from secondary sources.",
    verified: false,
  },
};

for (const version of CFE_1C.summerVersions) assertScheduleWellFormed(version);
assertScheduleWellFormed(CFE_1C.nonSummer);
assertScheduleWellFormed(CFE_1C.dac);
