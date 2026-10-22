/** The largest correction the HTTP `Date` header may apply to the local clock (spec section 7). */
export const MAX_CLOCK_CORRECTION_SECONDS = 120;

/**
 * The server's clock minus the local one, in whole seconds, from an HTTP `Date` header. A missing
 * or unreadable header gives 0. Not clamped here: {@link correctedNow} clamps.
 */
export function dateHeaderOffset(dateHeader: string | null | undefined, localNowSeconds: number): number {
  if (!dateHeader) return 0;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs) || !Number.isFinite(localNowSeconds)) return 0;
  return Math.floor(serverMs / 1000) - Math.floor(localNowSeconds);
}

/**
 * The local time corrected by a `Date` offset clamped to +-120 s, so a server (or anyone on the
 * path) can move the client's clock by at most 120 s either way.
 */
export function correctedNow(localNowSeconds: number, offsetSeconds: number): number {
  if (!Number.isFinite(localNowSeconds) || localNowSeconds < 0) throw new Error("the local clock is not a usable time");
  const offset = Number.isFinite(offsetSeconds) ? offsetSeconds : 0;
  const clamped = Math.max(-MAX_CLOCK_CORRECTION_SECONDS, Math.min(MAX_CLOCK_CORRECTION_SECONDS, offset));
  return Math.floor(localNowSeconds) + Math.trunc(clamped);
}
