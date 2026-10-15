/** BigInt (cột tiền) → number cho JSON. Tiền VND ≤ MAX_MONEY nên an toàn với number. */
export const num = (v: bigint | number | null | undefined): number => (v == null ? 0 : Number(v));
export const numOrNull = (v: bigint | number | null | undefined): number | null =>
  v == null ? null : Number(v);

/** Mốc 00:00 giờ VN (UTC+7) của ngày YYYY-MM-DD, và ngày kế tiếp. */
export function vnDayRange(date: string): { from: Date; to: Date } {
  const from = new Date(`${date}T00:00:00+07:00`);
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

export function todayVn(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}
