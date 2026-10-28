/** Business days for the Ibadan shops. West Africa Time is UTC+1 with no DST. */

export function watDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

export function shiftWatDay(dayKey: string, days: number) {
  const [year, month, day] = dayKey.split("-").map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + days))
  return next.toISOString().slice(0, 10)
}

export function watBounds(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number)
  return {
    start: new Date(Date.UTC(year, month - 1, day, -1, 0, 0, 0)),
    end: new Date(Date.UTC(year, month - 1, day + 1, -1, 0, 0, 0)),
  }
}

export function recentWatDays(count: number, from = watDayKey()) {
  return Array.from({ length: count }, (_, index) => shiftWatDay(from, -index))
}

export function formatWatLong(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number)
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

export function formatLagosStamp(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

/**
 * Shop-facing date and time in Lagos.
 *
 * Staff need to know *when* something happened, not only that it happened.
 * Today and yesterday are said plainly; older days keep the full stamp.
 */
export function formatShopWhen(date: Date | string | null | undefined) {
  if (!date) return "—"
  const value = new Date(date)
  if (Number.isNaN(value.getTime())) return "—"

  const today = watDayKey()
  const day = watDayKey(value)
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value)

  if (day === today) return `Today, ${clock}`
  if (day === shiftWatDay(today, -1)) return `Yesterday, ${clock}`

  return formatLagosStamp(value)
}

/** Short date only (no clock), still Lagos. */
export function formatShopDay(date: Date | string | null | undefined) {
  if (!date) return "—"
  const value = new Date(date)
  if (Number.isNaN(value.getTime())) return "—"
  const today = watDayKey()
  const day = watDayKey(value)
  if (day === today) return "Today"
  if (day === shiftWatDay(today, -1)) return "Yesterday"
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(value)
}

/** Client list chips: Any day / Today / Last 7 days / Last 30 days, plus a chosen stretch. */
export type WhenFilter = "all" | "today" | "week" | "month" | "custom"
export type ShopRange = "day" | "week" | "month"

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

export function isWatDayKey(value: string) {
  return DAY_KEY.test(value)
}

/** Inclusive Lagos days. Empty first or last day means open on that side. Swaps if first is after last. */
export function orderedDayRange(from: string, to: string) {
  const start = isWatDayKey(from) ? from : ""
  const end = isWatDayKey(to) ? to : ""
  if (start && end && start > end) return { from: end, to: start }
  return { from: start, to: end }
}

export function whenFilterRange(when: Exclude<WhenFilter, "custom">, today = watDayKey()) {
  if (when === "today") return { from: today, to: today }
  if (when === "week") return { from: shiftWatDay(today, -6), to: today }
  if (when === "month") return { from: shiftWatDay(today, -29), to: today }
  return { from: "", to: "" }
}

export function whenChipFromRange(from: string, to: string, today = watDayKey()): WhenFilter {
  const range = orderedDayRange(from, to)
  if (!range.from && !range.to) return "all"
  const todayRange = whenFilterRange("today", today)
  const weekRange = whenFilterRange("week", today)
  const monthRange = whenFilterRange("month", today)
  if (range.from === todayRange.from && range.to === todayRange.to) return "today"
  if (range.from === weekRange.from && range.to === weekRange.to) return "week"
  if (range.from === monthRange.from && range.to === monthRange.to) return "month"
  return "custom"
}

export function matchesDayRange(date: Date | string | null | undefined, from: string, to: string) {
  const range = orderedDayRange(from, to)
  if (!range.from && !range.to) return true
  if (!date) return false
  const value = new Date(date)
  if (Number.isNaN(value.getTime())) return false
  const day = watDayKey(value)
  if (range.from && day < range.from) return false
  if (range.to && day > range.to) return false
  return true
}

/** One Lagos day, the last 7 days ending on `day`, or this month up to `day`. */
export function shopPeriodWindow(day: string, range: ShopRange) {
  if (range === "week") {
    const from = shiftWatDay(day, -6)
    return { from, to: day, start: watBounds(from).start, end: watBounds(day).end }
  }
  if (range === "month") {
    const from = `${day.slice(0, 8)}01`
    return { from, to: day, start: watBounds(from).start, end: watBounds(day).end }
  }
  const bounds = watBounds(day)
  return { from: day, to: day, start: bounds.start, end: bounds.end }
}

export function shopPreviousWindow(from: string, range: ShopRange) {
  if (range === "day") return shopPeriodWindow(shiftWatDay(from, -1), "day")
  if (range === "week") return shopPeriodWindow(shiftWatDay(from, -1), "week")
  const [year, month] = from.split("-").map(Number)
  const last = new Date(Date.UTC(year, month - 1, 0))
  return shopPeriodWindow(last.toISOString().slice(0, 10), "month")
}

/** The Reports period: one of the shop ranges, or any first day to any last day. */
export type ReportRange = ShopRange | "custom"

export function asReportRange(value?: string): ReportRange {
  return value === "day" || value === "week" || value === "custom" ? value : "month"
}

/** `day` is the last day. A chosen stretch starts on `from` (swapped if after `day`). */
export function reportPeriodWindow(day: string, range: ReportRange, from?: string) {
  if (range !== "custom") return shopPeriodWindow(day, range)
  const ordered = orderedDayRange(from && isWatDayKey(from) ? from : day, day)
  return { from: ordered.from, to: ordered.to, start: watBounds(ordered.from).start, end: watBounds(ordered.to).end }
}

/** The period before: a chosen stretch is compared with the same number of days just before it. */
export function reportPreviousWindow(period: { from: string; to: string }, range: ReportRange) {
  if (range !== "custom") return shopPreviousWindow(period.from, range)
  const [fy, fm, fd] = period.from.split("-").map(Number)
  const [ty, tm, td] = period.to.split("-").map(Number)
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1
  const to = shiftWatDay(period.from, -1)
  return reportPeriodWindow(to, "custom", shiftWatDay(to, -(days - 1)))
}

export function matchesWhenFilter(date: Date | string | null | undefined, when: WhenFilter) {
  if (when === "all") return true
  if (!date) return false
  const value = new Date(date)
  if (Number.isNaN(value.getTime())) return false
  const day = watDayKey(value)
  if (when === "today") return day === watDayKey()
  if (when === "week") return recentWatDays(7).includes(day)
  if (when === "month") return recentWatDays(30).includes(day)
  return true
}
