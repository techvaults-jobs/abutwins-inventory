"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowDown, ArrowUp, ChevronsUpDown, ChevronRight, Inbox, Search, SearchX, X } from "lucide-react"
import { TablePager, usePagedRows } from "@/components/table-pager"
import { cn } from "@/lib/utils"

/**
 * One list, the same everywhere: search, sortable columns, a card per row on a
 * phone, tick rows for bulk work, a totals footer and a pager.
 *
 * Screens used to hand-roll their own <table>, each with its own spacing and
 * none with search or sorting. A phone got a table wider than the screen. This
 * keeps what a screen owns (its columns, filters and actions) and handles the
 * rest once.
 */

export type DataColumn<T> = {
  id: string
  header: ReactNode
  cell: (row: T) => ReactNode
  align?: "left" | "right" | "center"
  /** Give a value to make the column sortable by clicking its header. */
  sortValue?: (row: T) => string | number
  className?: string
  /** Hide on narrower desktops so the important columns keep their room. */
  hideBelow?: "lg" | "xl" | "2xl"
}

export type DataCard = {
  title: ReactNode
  subtitle?: ReactNode
  value?: ReactNode
  valueHint?: ReactNode
  badge?: ReactNode
  meta?: ReactNode
}

type Sort = { id: string; dir: "asc" | "desc" } | null

const hideClass = { lg: "hidden lg:table-cell", xl: "hidden xl:table-cell", "2xl": "hidden 2xl:table-cell" } as const

/**
 * The desktop table, scrolling sideways when its columns do not fit. A wide
 * table used to end at the card's edge with nothing to say more columns were
 * there, so a status or a payment column went unseen. The edge now shades on
 * whichever side still has columns.
 */
function SidewaysScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ left: false, right: false })

  useEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => {
      const left = node.scrollLeft > 1
      const right = node.scrollLeft + node.clientWidth < node.scrollWidth - 1
      setMore((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
    }
    measure()
    node.addEventListener("scroll", measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (node.firstElementChild) observer.observe(node.firstElementChild)
    return () => {
      node.removeEventListener("scroll", measure)
      observer.disconnect()
    }
  }, [])

  return (
    <div className="relative hidden md:block">
      <div ref={ref} className="overflow-x-auto">
        {children}
      </div>
      {more.left ? <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-foreground/15 to-transparent" /> : null}
      {more.right ? (
        <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-start justify-end bg-gradient-to-l from-foreground/15 to-transparent pr-1 pt-2">
          <ChevronRight className="h-4 w-4 text-foreground/70" />
        </div>
      ) : null}
    </div>
  )
}

function isInteractive(target: EventTarget | null) {
  return Boolean((target as HTMLElement | null)?.closest("a, button, input, select, textarea, label"))
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  card,
  onRowClick,
  searchText,
  searchPlaceholder = "Search",
  query: controlledQuery,
  onQueryChange,
  filters,
  actions,
  filterKey = "",
  footer,
  empty,
  noun = "rows",
  bulkActions,
  initialSort = null,
  className,
}: {
  rows: T[]
  columns: DataColumn<T>[]
  rowKey: (row: T) => string
  /** How a row reads on a phone. */
  card: (row: T) => DataCard
  onRowClick?: (row: T) => void
  /** Text a row is searched by. Leave out to hide the search box. */
  searchText?: (row: T) => string
  searchPlaceholder?: string
  /** Pass both to own the search text, so figures outside the table can follow it. */
  query?: string
  onQueryChange?: (query: string) => void
  /** Chips or selects that narrow the list, shown under the search box. */
  filters?: ReactNode
  /** Export and similar buttons, shown beside the search box. */
  actions?: ReactNode
  /** Changes whenever the screen's own filters change, so the pager resets. */
  filterKey?: string
  /** A totals row for the desktop table, given the rows left after search. */
  footer?: (visible: T[]) => ReactNode
  empty?: ReactNode
  noun?: string
  /** With this, rows can be ticked; it renders the bar for the ticked rows. */
  bulkActions?: (selected: T[], clear: () => void) => ReactNode
  initialSort?: Sort
  className?: string
}) {
  const [ownQuery, setOwnQuery] = useState("")
  const query = controlledQuery ?? ownQuery
  const setQuery = onQueryChange ?? setOwnQuery
  const [sort, setSort] = useState<Sort>(initialSort)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())

  const searched = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle || !searchText) return rows
    const words = needle.split(/\s+/)
    return rows.filter((row) => {
      const hay = searchText(row).toLowerCase()
      return words.every((word) => hay.includes(word))
    })
  }, [rows, query, searchText])

  const sorted = useMemo(() => {
    if (!sort) return searched
    const column = columns.find((col) => col.id === sort.id)
    if (!column?.sortValue) return searched
    const value = column.sortValue
    const factor = sort.dir === "asc" ? 1 : -1
    return [...searched].sort((a, b) => {
      const x = value(a)
      const y = value(b)
      if (typeof x === "number" && typeof y === "number") return (x - y) * factor
      return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" }) * factor
    })
  }, [searched, sort, columns])

  const pager = usePagedRows(sorted, `${filterKey}|${query}|${sort?.id}|${sort?.dir}`)
  const selectable = Boolean(bulkActions)
  const selectedRows = useMemo(() => rows.filter((row) => picked.has(rowKey(row))), [rows, picked, rowKey])
  const pageKeys = pager.pageRows.map(rowKey)
  const allOnPage = pageKeys.length > 0 && pageKeys.every((key) => picked.has(key))

  function toggle(keys: string[], on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev)
      for (const key of keys) {
        if (on) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }

  function cycleSort(id: string) {
    setSort((current) => {
      if (!current || current.id !== id) return { id, dir: "desc" }
      if (current.dir === "desc") return { id, dir: "asc" }
      return null
    })
  }

  const clear = () => setPicked(new Set())
  const showToolbar = Boolean(searchText || filters || actions)

  return (
    <div className={cn("space-y-3", className)}>
      {showToolbar ? (
        <div className="surface-card space-y-3 p-3">
          {searchText || actions ? (
            <div className="flex items-center gap-2">
              {searchText ? (
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    className="h-10 w-full rounded-lg border border-input bg-card pl-9 pr-9 text-sm outline-none transition-shadow placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 [&::-webkit-search-cancel-button]:hidden"
                  />
                  {query ? (
                    <button
                      type="button"
                      onClick={() => setQuery("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label="Clear search"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              ) : null}
              {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
          ) : null}
          {filters ? <div className="space-y-3">{filters}</div> : null}
        </div>
      ) : null}

      <div className="surface-card overflow-hidden">
        {/* Desktop and tablet: a real table. */}
        <SidewaysScroll>
          <table className="data-table">
            <thead>
              <tr>
                {selectable ? (
                  <th className="w-10 !pr-0">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[hsl(var(--primary))]"
                      checked={allOnPage}
                      onChange={(event) => toggle(pageKeys, event.target.checked)}
                      aria-label="Tick every row on this page"
                    />
                  </th>
                ) : null}
                {columns.map((column) => {
                  const active = sort?.id === column.id
                  return (
                    <th
                      key={column.id}
                      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                      className={cn(
                        column.align === "right" && "text-right",
                        column.align === "center" && "text-center",
                        column.hideBelow && hideClass[column.hideBelow],
                        column.className
                      )}
                    >
                      {column.sortValue ? (
                        <button
                          type="button"
                          onClick={() => cycleSort(column.id)}
                          className={cn(
                            "inline-flex items-center gap-1 uppercase tracking-[0.06em] transition-colors hover:text-foreground",
                            active && "text-foreground",
                            column.align === "right" && "flex-row-reverse"
                          )}
                        >
                          {column.header}
                          {active ? (
                            sort!.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ChevronsUpDown className="h-3 w-3 opacity-40" />
                          )}
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((row) => {
                const key = rowKey(row)
                return (
                  <tr
                    key={key}
                    onClick={onRowClick ? (event) => !isInteractive(event.target) && onRowClick(row) : undefined}
                    className={cn(onRowClick && "cursor-pointer", picked.has(key) && "bg-primary-soft/60")}
                  >
                    {selectable ? (
                      <td className="w-10 !pr-0">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[hsl(var(--primary))]"
                          checked={picked.has(key)}
                          onChange={(event) => toggle([key], event.target.checked)}
                          aria-label="Tick this row"
                        />
                      </td>
                    ) : null}
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          column.align === "right" && "whitespace-nowrap text-right tabular-nums",
                          column.align === "center" && "text-center",
                          column.hideBelow && hideClass[column.hideBelow],
                          column.className
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
            {footer && sorted.length ? <tfoot className="border-t-2 border-border bg-muted/40 font-semibold">{footer(sorted)}</tfoot> : null}
          </table>
        </SidewaysScroll>

        {/* Phone: one card per row, no sideways scrolling. */}
        <ul className="divide-y divide-border md:hidden">
          {pager.pageRows.map((row) => {
            const key = rowKey(row)
            const view = card(row)
            return (
              <li
                key={key}
                onClick={onRowClick ? (event) => !isInteractive(event.target) && onRowClick(row) : undefined}
                className={cn(
                  "flex items-start gap-3 px-4 py-3",
                  onRowClick && "cursor-pointer active:bg-muted/60",
                  picked.has(key) && "bg-primary-soft/60"
                )}
              >
                {selectable ? (
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                    checked={picked.has(key)}
                    onChange={(event) => toggle([key], event.target.checked)}
                    aria-label="Tick this row"
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{view.title}</div>
                      {view.subtitle ? <div className="truncate text-xs text-muted-foreground">{view.subtitle}</div> : null}
                    </div>
                    {view.value !== undefined ? (
                      <div className="shrink-0 text-right">
                        <div className="font-semibold tabular-nums">{view.value}</div>
                        {view.valueHint ? <div className="text-xs tabular-nums">{view.valueHint}</div> : null}
                      </div>
                    ) : null}
                  </div>
                  {view.badge || view.meta ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {view.badge}
                      {view.meta}
                    </div>
                  ) : null}
                </div>
                {onRowClick ? <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground/60" /> : null}
              </li>
            )
          })}
        </ul>

        {sorted.length === 0 ? (
          <div className="motion-rise flex flex-col items-center px-6 py-10 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {query ? <SearchX className="h-5 w-5" /> : <Inbox className="h-5 w-5" />}
            </span>
            <p className="mt-3 text-sm font-medium">{query ? `Nothing matches “${query}”` : empty ?? `No ${noun} yet.`}</p>
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-3 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors duration-press ease-standard hover:bg-muted"
              >
                Clear the search
              </button>
            ) : null}
          </div>
        ) : null}

        <TablePager
          page={pager.page}
          pageCount={pager.pageCount}
          pageSize={pager.pageSize}
          total={pager.total}
          start={pager.start}
          end={pager.end}
          onPageChange={pager.setPage}
          onPageSizeChange={pager.setPageSize}
          noun={noun}
        />
      </div>

      {selectable && selectedRows.length ? (
        <div className="sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 mx-auto lg:bottom-4 flex w-fit max-w-full flex-wrap items-center gap-3 rounded-xl border border-border bg-foreground px-4 py-2.5 text-sm text-background shadow-2xl">
          <span className="font-medium tabular-nums">{selectedRows.length} ticked</span>
          <div className="flex flex-wrap items-center gap-2">{bulkActions!(selectedRows, clear)}</div>
          <button type="button" onClick={clear} className="rounded-md px-2 py-1 text-background/70 hover:text-background">
            Untick all
          </button>
        </div>
      ) : null}
    </div>
  )
}
