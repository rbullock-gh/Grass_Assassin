/**
 * Deadline windows, computed in the viewer's timezone rather than the server's.
 *
 * `tzOffsetMinutes` follows the JavaScript convention from
 * Date.prototype.getTimezoneOffset(): minutes to ADD to local time to reach
 * UTC, so it is positive west of UTC (New York in winter is 300).
 */

/** The instant at which "today" ends for someone at the given offset. */
export function endOfLocalDay(now: Date, tzOffsetMinutes = 0): Date {
  const offsetMs = tzOffsetMinutes * 60_000
  // Shift into the viewer's local frame, snap to the end of that day, shift back.
  const local = new Date(now.getTime() - offsetMs)
  const endOfLocal = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23, 59, 59, 999,
  )
  return new Date(endOfLocal + offsetMs)
}

/** The instant seven local days out, for the "this week" chip. */
export function endOfLocalWeek(now: Date, tzOffsetMinutes = 0): Date {
  const endOfToday = endOfLocalDay(now, tzOffsetMinutes)
  return new Date(endOfToday.getTime() + 6 * 86_400_000)
}
