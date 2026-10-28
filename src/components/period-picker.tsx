"use client"

import { usePathname, useRouter } from "next/navigation"
import { Select } from "@/components/ui/select"

export type PickerRange = "all" | "day" | "week" | "month" | "custom"

/**
 * The period of a screen, kept in its link (range, from, date) so a refresh
 * or a shared link shows the same figures. The same choices as Reports, and
 * "Pick dates" for any first and last day, across months. Other settings in
 * the link are handed in by the page (`keep`), so they survive a change.
 */
export function PeriodPicker({
  range,
  from,
  date,
  allowAll = false,
  keep = {},
}: {
  range: PickerRange
  /** First day of the period on screen. */
  from: string
  /** Last day of the period on screen. */
  date: string
  /** Offer "All time" (every sale ever). */
  allowAll?: boolean
  /** The page's other link settings, kept as they are. */
  keep?: Record<string, string>
}) {
  const router = useRouter()
  const pathname = usePathname()

  function go(next: { range?: PickerRange; from?: string; date?: string }) {
    const params = new URLSearchParams(keep)
    const nextRange = next.range ?? range
    params.set("range", nextRange)
    if (nextRange === "custom") params.set("from", next.from ?? from)
    if (nextRange !== "all") params.set("date", next.date ?? date)
    router.push(`${pathname}?${params.toString()}`)
  }

  // A first day after the last day (or the reverse) moves the other with it.
  function pickStretch(next: { from?: string; to?: string }) {
    let first = next.from ?? from
    let last = next.to ?? date
    if (!first || !last) return
    if (first > last) {
      if (next.from) last = first
      else first = last
    }
    go({ range: "custom", from: first, date: last })
  }

  const dateClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto"

  return (
    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
      <label className="col-span-2 flex flex-col gap-1 text-sm sm:col-span-1 sm:flex-row sm:items-center sm:gap-2">
        <span className="eyebrow">Period</span>
        <Select value={range} onChange={(event) => go({ range: event.target.value as PickerRange })} className="h-9 w-full sm:w-48">
          {allowAll ? <option value="all">All time</option> : null}
          <option value="day">One day</option>
          <option value="week">Last 7 days</option>
          <option value="month">This month so far</option>
          {/* Opens on the period already on screen, so nothing jumps. */}
          <option value="custom">Pick dates (from – to)</option>
        </Select>
      </label>
      {range === "custom" ? (
        <>
          <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
            <span className="eyebrow">From</span>
            <input type="date" value={from} max={date} onChange={(event) => pickStretch({ from: event.target.value })} className={dateClass} />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
            <span className="eyebrow">To</span>
            <input type="date" value={date} min={from} onChange={(event) => pickStretch({ to: event.target.value })} className={dateClass} />
          </label>
        </>
      ) : range !== "all" ? (
        <label className="col-span-2 flex flex-col gap-1 text-sm sm:col-span-1 sm:flex-row sm:items-center sm:gap-2">
          <span className="eyebrow">Ending on</span>
          <input type="date" value={date} onChange={(event) => go({ date: event.target.value })} className={dateClass} />
        </label>
      ) : null}
    </div>
  )
}
