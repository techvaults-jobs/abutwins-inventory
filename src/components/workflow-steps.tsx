"use client"

import { useRef } from "react"
import Link from "next/link"
import { Check, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

export type WorkflowStep = {
  label: string
  /** When set, the step is a filter/link, not just a picture. */
  href?: string
  /** Client-filter key when using `onSelect` instead of URLs. */
  key?: string
  count?: number
  /** Optional plain hint under the label. */
  hint?: string
}

/**
 * Status tiles over a list, or the life of a job as numbered chips.
 *
 * With `activeHref` or `onSelect`, each step is a tile that filters the list
 * below: steps with `href` link (URL filters), steps with `key` call
 * `onSelect` (pair it with useUrlFilter so the pick lives in the URL). The
 * tile matching `activeHref` or `activeKey` reads "Showing". Without either,
 * the steps are a picture of progress, `current` being the step reached.
 */
export function WorkflowSteps({
  steps,
  current = 0,
  activeHref,
  activeKey,
  onSelect,
  className,
}: {
  steps: Array<string | WorkflowStep>
  current?: number
  activeHref?: string
  activeKey?: string
  onSelect?: (key: string) => void
  className?: string
}) {
  const normalized = steps.map((step) => (typeof step === "string" ? { label: step } : step))
  const clickable = Boolean(activeHref || onSelect)
  const listRef = useRef<HTMLOListElement>(null)

  if (clickable) {
    return (
      <nav aria-label="Show the list by status">
        <ol ref={listRef} className={cn("grid gap-2", tileColumns(normalized.length), className)}>
          {normalized.map((step, index) => {
            const isActive = activeHref
              ? Boolean(step.href && urlsMatch(activeHref, step.href))
              : step.key === activeKey
            const body = <FilterTileBody step={step} active={isActive} />
            const classes = cn(
              "group flex h-full w-full flex-col rounded-xl border px-3 py-3 text-left transition-all",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
              isActive
                ? "border-primary bg-primary/10 text-primary shadow-sm ring-1 ring-primary/30"
                : "cursor-pointer border-border bg-card text-foreground hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md active:translate-y-0"
            )
            return (
              <li key={`${index}-${step.key ?? step.label}`}>
                {step.href ? (
                  <Link
                    href={step.href}
                    scroll={false}
                    className={classes}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => revealResults(listRef.current)}
                  >
                    {body}
                  </Link>
                ) : onSelect && step.key !== undefined ? (
                  <button
                    type="button"
                    className={classes}
                    aria-pressed={isActive}
                    onClick={() => {
                      onSelect(step.key!)
                      revealResults(listRef.current)
                    }}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={classes}>{body}</div>
                )}
              </li>
            )
          })}
        </ol>
      </nav>
    )
  }

  return (
    <ol className={cn("grid gap-2 sm:grid-cols-2 lg:grid-cols-4", className)}>
      {normalized.map((step, index) => {
        const state = index === current ? "active" : index < current ? "done" : "todo"
        return (
          <li
            key={`${index}-${step.label}`}
            className={cn(
              "rounded-xl border px-3 py-2.5 text-left text-xs",
              state === "done" && "border-success/30 bg-success-soft text-success",
              state === "active" && "border-primary/40 bg-primary/10 text-primary shadow-sm ring-1 ring-primary/20",
              state === "todo" && "border-border bg-card text-muted-foreground"
            )}
          >
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                  state === "done" && "bg-success/20 text-success",
                  state === "active" && "bg-primary/20 text-primary",
                  state === "todo" && "bg-muted text-muted-foreground"
                )}
              >
                {index + 1}
              </span>
              <span className="font-semibold leading-tight">{step.label}</span>
              {typeof step.count === "number" ? (
                <span className="ml-auto rounded-full bg-background/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
                  {step.count}
                </span>
              ) : null}
            </span>
            {step.hint ? <span className="mt-1 block text-[11px] font-normal opacity-80">{step.hint}</span> : null}
          </li>
        )
      })}
    </ol>
  )
}

/** One status tile: the count big enough to read across the counter, then what it is. */
function FilterTileBody({ step, active }: { step: WorkflowStep; active: boolean }) {
  const empty = step.count === 0
  return (
    <>
      <span className="flex items-start justify-between gap-2">
        <span className="text-sm font-semibold leading-tight">{step.label}</span>
        {active ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-foreground">
            <Check className="h-3 w-3" aria-hidden /> Showing
          </span>
        ) : (
          <ChevronRight
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
            aria-hidden
          />
        )}
      </span>
      {typeof step.count === "number" ? (
        <span
          className={cn(
            "mt-1 text-2xl font-bold leading-none tabular-nums",
            !active && empty && "text-muted-foreground/60"
          )}
        >
          {step.count}
        </span>
      ) : null}
      <span className={cn("mt-1.5 text-[11px] leading-snug", active ? "text-primary/80" : "text-muted-foreground")}>
        {step.hint ? step.hint : null}
        {step.hint ? " · " : null}
        <span className={cn("font-medium", active ? "" : "text-primary")}>{active ? "In the list below" : "View list"}</span>
      </span>
    </>
  )
}

/** Two tiles a row on a phone, then every tile on one row where it fits. */
function tileColumns(count: number) {
  if (count <= 2) return "grid-cols-2"
  if (count === 3) return "grid-cols-2 sm:grid-cols-3"
  if (count === 4) return "grid-cols-2 lg:grid-cols-4"
  if (count === 5) return "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
  return "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6"
}

/**
 * After a tile is picked, bring the list under it into view when the tiles
 * fill the screen (a phone), so the change is seen, not just made.
 */
function revealResults(list: HTMLOListElement | null) {
  const results = list?.closest("nav")?.nextElementSibling
  if (!results) return
  const top = results.getBoundingClientRect().top
  if (top > window.innerHeight * 0.6) {
    requestAnimationFrame(() => results.scrollIntoView({ behavior: "smooth", block: "start" }))
  }
}

function urlsMatch(current: string, href: string) {
  try {
    const a = new URL(current, "http://local")
    const b = new URL(href, "http://local")
    if (a.pathname !== b.pathname) return false
    // Active when every query on the chip is present on the current URL.
    for (const [key, value] of b.searchParams.entries()) {
      if (a.searchParams.get(key) !== value) return false
    }
    // And the chip is not "all" while the page has a tighter filter of the same key.
    if ([...b.searchParams.keys()].length === 0) {
      return [...a.searchParams.keys()].length === 0 || !a.searchParams.get("status")
    }
    return true
  } catch {
    return current === href
  }
}
