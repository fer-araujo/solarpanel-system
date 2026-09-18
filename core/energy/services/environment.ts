/**
 * Environmental equivalents of solar production.
 *
 * Conversion factors, stated so they can be audited:
 * - CO2: 0.423 kg per grid kWh, the Mexican grid emission factor.
 * - Coal: 0.4 kg of standard coal per kWh, the same convention SolaX uses.
 * - Trees: 21.8 kg of CO2 absorbed per mature tree per year.
 */
export const CO2_KG_PER_KWH = 0.423;
export const COAL_KG_PER_KWH = 0.4;
export const CO2_KG_PER_TREE_YEAR = 21.8;

export interface EnvironmentalBenefits {
  co2Kg: number;
  coalKg: number;
  /** Trees needed for a year to absorb the same CO2. */
  treeYears: number;
}

export function environmentalBenefits(kwh: number): EnvironmentalBenefits {
  const co2Kg = kwh * CO2_KG_PER_KWH;
  return {
    co2Kg,
    coalKg: kwh * COAL_KG_PER_KWH,
    treeYears: co2Kg / CO2_KG_PER_TREE_YEAR,
  };
}
