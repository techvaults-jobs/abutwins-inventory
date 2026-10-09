"use client"

import { useCallback, useState } from "react"

/**
 * A list's status filter, kept in the address bar as ?status=…
 *
 * The page reads the query on the server and passes it in as `initial`, so a
 * link such as Home's "Swap Deals approved but not finished" (to
 * /swaps?status=APPROVED) opens on exactly the rows it counted. Picking a
 * tile writes the choice back with history.replaceState (which the Next.js
 * router stays in step with), so a refresh, a shared link or Back to this
 * page shows the same list. An unknown value falls back to `fallback`.
 */
export function useUrlFilter(
  initial: string | undefined,
  allowed: readonly string[],
  { param = "status", fallback = "all" }: { param?: string; fallback?: string } = {}
) {
  const pick = (value: string | undefined) => (value && allowed.includes(value) ? value : fallback)
  const [value, setValue] = useState(() => pick(initial))
  const [seen, setSeen] = useState(initial)

  // A link to the same page with another ?status= arrives as a new `initial`.
  if (initial !== seen) {
    setSeen(initial)
    setValue(pick(initial))
  }

  const select = useCallback(
    (next: string) => {
      setValue(next)
      const url = new URL(window.location.href)
      if (next === fallback) url.searchParams.delete(param)
      else url.searchParams.set(param, next)
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
    },
    [param, fallback]
  )

  return [value, select] as const
}
