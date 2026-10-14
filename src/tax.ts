export type AccountType = "regular" | "IKE" | "IKZE" | "OKI";

export const BELKA_RATE = 0.19;

/**
 * Belka tax (podatek od zysków kapitałowych) on a gain, rounded to whole złoty as
 * brokers and banks withhold it. IKE, IKZE and OKI holdings are not subject to Belka
 * (IKZE is taxed 10% on withdrawal instead, which is out of scope here).
 */
export function belkaTax(gain: number, account: AccountType): number {
  if (account !== "regular" || gain <= 0) return 0;
  return Math.round(gain * BELKA_RATE);
}
