"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Clock, CornerDownLeft, FileText, Search, Zap } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { useUI } from "@/store/ui"
import { globalSearch } from "@/app/actions/search"
import { navDestinations } from "@/components/layout/nav"
import { pathIsAllowed } from "@/lib/access-path"
import { cn } from "@/lib/utils"

type Result = {
  kind: string
  id: string
  title: string
  href: string
  hint?: string
}

type Row = { key: string; title: string; hint?: string; href: string; group: string }

const RECENT_KEY = "abutwins.recent-pages"

/** The jobs people open search to start, shown before anything is typed. */
const QUICK_ACTIONS = [
  { title: "Sell now", href: "/pos" },
  { title: "Log a return", href: "/returns/new" },
  { title: "Ask for a shop bill", href: "/expenses/new" },
  { title: "Start a transfer", href: "/transfers/new" },
  { title: "Move cash to bank", href: "/finance/deposit" },
]

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function saveRecent(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // Private windows refuse storage; recent pages are only a convenience.
  }
}

/**
 * Ctrl K: jump to any page, or find an IMEI, invoice, supplier or customer.
 *
 * With nothing typed it offers the day's common jobs and the pages this person
 * opened last, so it is useful before a single key is pressed. Arrow keys move,
 * Enter opens.
 */
export function CommandPalette({ allowedHrefs = [] }: { allowedHrefs?: string[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const open = useUI((state) => state.commandOpen)
  const setOpen = useUI((state) => state.setCommandOpen)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Result[]>([])
  const [recent, setRecent] = useState<string[]>([])
  const [active, setActive] = useState(0)
  const [pending, start] = useTransition()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen(!open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, setOpen])

  // Remember the pages opened, newest first, for the empty search box.
  useEffect(() => {
    if (!pathname || !navDestinations.some((item) => item.href === pathname)) return
    const next = [pathname, ...readRecent().filter((href) => href !== pathname)].slice(0, 6)
    saveRecent(next)
  }, [pathname])

  useEffect(() => {
    if (open) {
      setRecent(readRecent())
      setActive(0)
    }
  }, [open])

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    const handle = setTimeout(() => {
      start(async () => {
        const found = await globalSearch(query)
        setResults(found)
      })
    }, 180)
    return () => clearTimeout(handle)
  }, [query])

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    const byHref = new Map(navDestinations.map((item) => [item.href, item]))
    if (!q) {
      const actions = QUICK_ACTIONS.filter((action) => pathIsAllowed(action.href, allowedHrefs)).map((action) => ({
        key: `do-${action.href}`,
        title: action.title,
        href: action.href,
        group: "Do something",
      }))
      const recentRows = recent
        .filter((href) => href !== pathname && pathIsAllowed(href, allowedHrefs) && byHref.has(href))
        .slice(0, 5)
        .map((href) => {
          const item = byHref.get(href)!
          return { key: `recent-${href}`, title: item.name, hint: item.parent ? `in ${item.parent}` : undefined, href, group: "Opened lately" }
        })
      return [...actions, ...recentRows]
    }
    // Sections count as destinations too, so typing "opening" finds the opening
    // stock sheet without knowing it lives under Upload stock.
    const pages = navDestinations
      .filter((item) => pathIsAllowed(item.href, allowedHrefs) && `${item.parent ?? ""} ${item.name}`.toLowerCase().includes(q))
      .map((item) => ({
        key: `page-${item.href}`,
        title: item.name,
        hint: item.parent ? `in ${item.parent}` : undefined,
        href: item.href,
        group: "Pages",
      }))
    const found = results.map((result) => ({
      key: `${result.kind}-${result.id}`,
      title: result.title,
      hint: `${result.kind}${result.hint ? ` · ${result.hint}` : ""}`,
      href: result.href,
      group: "Records",
    }))
    return [...pages, ...found]
  }, [query, results, recent, allowedHrefs, pathname])

  useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const go = (href: string) => {
    setOpen(false)
    setQuery("")
    router.push(href)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, rows.length - 1))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
    } else if (event.key === "Enter" && rows[active]) {
      event.preventDefault()
      go(rows[active].href)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
    >
      <DialogContent className="top-[12vh] translate-y-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-4 pr-12">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            className="h-12 w-full min-w-0 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
            placeholder="Jump to a page, or find an IMEI, invoice, supplier or customer"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            aria-label="Search"
          />
        </div>
        <div ref={listRef} className="max-h-[min(420px,60vh)] overflow-y-auto p-2" role="listbox" aria-label="Results">
          {rows.map((row, index) => {
            const heading = index === 0 || rows[index - 1].group !== row.group ? row.group : null
            const Icon = row.group === "Do something" ? Zap : row.group === "Opened lately" ? Clock : FileText
            return (
              <div key={row.key}>
                {heading ? (
                  <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{heading}</p>
                ) : null}
                <button
                  type="button"
                  data-row={index}
                  role="option"
                  aria-selected={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => go(row.href)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-press ease-standard",
                    index === active ? "bg-primary-soft text-primary" : "hover:bg-muted"
                  )}
                >
                  <Icon className={cn("h-4 w-4 shrink-0", index === active ? "text-primary" : "text-muted-foreground")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{row.title}</span>
                    {row.hint ? <span className="block truncate text-xs text-muted-foreground">{row.hint}</span> : null}
                  </span>
                  {index === active ? <CornerDownLeft className="h-3.5 w-3.5 shrink-0 opacity-70" /> : null}
                </button>
              </div>
            )
          })}
          {pending && query ? <p className="px-3 py-3 text-sm text-muted-foreground">Looking…</p> : null}
          {!pending && query && rows.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Nothing matches “{query}”. Try an IMEI, an invoice number, or a page name like “stock”.
            </p>
          ) : null}
        </div>
        <div className="hidden items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground sm:flex">
          <span><kbd className="font-mono">↑ ↓</kbd> move</span>
          <span><kbd className="font-mono">Enter</kbd> open</span>
          <span><kbd className="font-mono">Esc</kbd> close</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
