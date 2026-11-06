"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { pageTitles } from "@/components/layout/titles"
import { ArrowLeft, Inbox, type LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { statusLabel, statusTone } from "@/lib/status"
import { cn, formatCurrency, formatCurrencyShort } from "@/lib/utils"
import { AnimatedNumber } from "@/components/animated-number"

/**
 * The screen vocabulary.
 *
 * Every page is built from these few pieces so that a heading, a figure, a
 * table and a filter bar look identical wherever they appear. Before this, each
 * screen invented its own card padding, its own uppercase label size and its own
 * green, which is what made the app read as busy. Reach for a primitive here
 * before writing new markup.
 */

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "info"

const toneText: Record<Tone, string> = {
  neutral: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
}

const toneIcon: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary-soft text-primary",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
}

/** Title, one line of plain-language explanation, and the page's own actions. */
export function PageHeader({
  title,
  description,
  actions,
  backHref,
}: {
  title: string
  description?: string
  actions?: ReactNode
  backHref?: string
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {/* Up to the list this page belongs to. The top bar's Back goes to the
            previous screen; this goes to the parent list, so it is a small
            link naming where it leads rather than a second Back button. */}
        {backHref ? (
          <Link
            href={backHref}
            className="mb-1 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {pageTitles[backHref] ?? "Back to the list"}
          </Link>
        ) : null}
        <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] md:text-2xl">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-snug text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/**
 * A screen that is one form: the heading, a link back up to its list, and the
 * form in a card at a width a person can read and fill. Forms used to sit in
 * a narrow column beside their list, which squeezed both.
 */
export function FormScreen({
  title,
  description,
  backHref,
  children,
  aside,
  wide = false,
}: {
  title: string
  description?: string
  backHref: string
  children: ReactNode
  /** Short help or a list of what is waiting, shown beside the form on wide screens. */
  aside?: ReactNode
  wide?: boolean
}) {
  return (
    <div className={cn("mx-auto w-full space-y-5", aside ? "max-w-6xl" : wide ? "max-w-5xl" : "max-w-3xl")}>
      <PageHeader title={title} description={description} backHref={backHref} />
      <div className={cn("grid items-start gap-5", aside && "lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]")}>
        <div className="surface-card min-w-0 p-4 sm:p-6">{children}</div>
        {aside ? <div className="min-w-0 space-y-4">{aside}</div> : null}
      </div>
    </div>
  )
}

/** A titled panel. Use instead of a bare `surface-card` whenever it has a heading. */
export function SectionCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  flush = false,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  /** Drop body padding, for a panel whose body is a full-bleed table. */
  flush?: boolean
}) {
  return (
    <section className={cn("surface-card overflow-hidden", className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold tracking-tight">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn(flush ? "" : "p-5", bodyClassName)}>{children}</div>
    </section>
  )
}

/** A naira figure as the screens print it ("₦30,396,500", "-₦16,441,500"), as a number. */
function readNaira(value: ReactNode): number | null {
  if (typeof value !== "string") return null
  const match = value.trim().match(/^(-)?₦([\d,]+(?:\.\d+)?)$/)
  if (!match) return null
  const amount = Number(match[2].replace(/,/g, ""))
  return Number.isFinite(amount) ? (match[1] ? -amount : amount) : null
}

/**
 * A small trend line under a figure: a soft area, the line, and a dot on the
 * latest point. It takes the colour of the text around it, so it works on the
 * lead tile and on a plain one. The line stretches to the tile; the dot is
 * drawn separately so it stays round.
 */
export function Sparkline({ points, label, className }: { points: number[]; label: string; className?: string }) {
  if (points.length < 2) return null
  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min || 1
  const y = (value: number) => (max === min ? 22 : 24 - ((value - min) / span) * 20)
  const x = (index: number) => (index / (points.length - 1)) * 100
  const line = points.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)} ${y(value).toFixed(2)}`).join(" ")
  const lastY = y(points[points.length - 1])
  return (
    <div className={cn("relative mt-2 h-7 w-full", className)} role="img" aria-label={label}>
      <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-hidden>
        <path d={`${line} L100 28 L0 28 Z`} fill="currentColor" opacity={0.14} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <span
        className="absolute h-2 w-2 rounded-full bg-current ring-2 ring-current/25"
        style={{ left: "calc(100% - 4px)", top: `calc(${(lastY / 28) * 100}% - 4px)` }}
        aria-hidden
      />
    </div>
  )
}

/** Only these tones colour a figure: something owed, short or wrong. */
const STATE_TONES: Tone[] = ["warning", "danger"]

/**
 * One figure with its label. The only way a number should be put on a screen.
 *
 * Give it `href` or `onClick` and the whole card becomes the target, which is how
 * every headline figure drills through to the rows behind it.
 *
 * Colour means state. Figures print in ink; only a warning or danger tone
 * colours one, and never a zero (a red ₦0 is not news). Naira in the millions
 * shows short (₦30.4m) with the exact figure on hover; tables and downloads
 * keep every naira. `lead` marks the one figure a screen answers first.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
  icon,
  href,
  onClick,
  className,
  lead = false,
  exact = false,
  chart,
  note,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
  icon?: ReactNode
  href?: string
  onClick?: () => void
  className?: string
  /** The screen's headline figure: drawn larger, in ink. One per screen. */
  lead?: boolean
  /** Keep every naira on the tile instead of the short form. */
  exact?: boolean
  /** A small trend under the figure, e.g. a Sparkline. */
  chart?: ReactNode
  /** A chip under the hint, e.g. the change on last week. Never clipped. */
  note?: ReactNode
}) {
  const interactive = Boolean(href || onClick)
  const amount = readNaira(value)
  const isZero = amount === 0 || (typeof value === "string" && !/[1-9]/.test(value))
  const stateTone = STATE_TONES.includes(tone) && !isZero ? tone : "neutral"
  const shortened = amount !== null && !exact && Math.abs(amount) >= 1_000_000
  // Whole counts such as "2,290" count up too.
  const count = typeof value === "string" && /^\d{1,3}(,\d{3})*$|^\d+$/.test(value.trim()) ? Number(value.replace(/,/g, "")) : null
  const shown =
    amount !== null ? (
      <AnimatedNumber
        countUp
        value={amount}
        format={shortened ? (n) => formatCurrencyShort(n) : (n) => formatCurrency(n)}
      />
    ) : count !== null ? (
      <AnimatedNumber countUp value={count} format={(n) => Math.round(n).toLocaleString("en-NG")} />
    ) : (
      value
    )

  const body = (
    <>
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        <p className="eyebrow min-w-0 leading-snug">{label}</p>
        {icon ? (
          <span
            className={cn(
              "hidden h-7 w-7 shrink-0 items-center justify-center rounded-md sm:inline-flex",
              lead ? "bg-[hsl(var(--lead-fg)/0.12)] text-[hsl(var(--lead-fg)/0.85)]" : toneIcon[stateTone]
            )}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <p
        className={cn(
          "stat-value mt-1.5 whitespace-nowrap font-semibold leading-tight tracking-tight num sm:mt-2",
          lead ? "text-[hsl(var(--lead-fg))]" : toneText[stateTone]
        )}
        title={shortened ? String(value) : undefined}
      >
        {shown}
      </p>
      {chart ? <div className={lead ? "text-[hsl(var(--lead-fg)/0.85)]" : "text-primary"}>{chart}</div> : null}
      {hint ? (
        <p className={cn("mt-1 line-clamp-2 text-xs leading-snug", lead ? "text-[hsl(var(--lead-fg)/0.7)]" : "text-muted-foreground")}>
          {hint}
        </p>
      ) : null}
      {note ? <div className="mt-1.5">{note}</div> : null}
    </>
  )

  const classes = cn(
    interactive ? "surface-card-interactive group" : "surface-card",
    "stat-card block min-w-0 p-3 text-left sm:p-4",
    lead &&
      "stat-card-lead border-[hsl(var(--lead-bg))] bg-[hsl(var(--lead-bg))] text-[hsl(var(--lead-fg))] hover:border-[hsl(var(--lead-bg))] hover:bg-[hsl(var(--lead-bg)/0.92)]",
    className
  )

  if (href) {
    return (
      <Link href={href} className={classes}>
        {body}
      </Link>
    )
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(classes, "w-full")}>
        {body}
      </button>
    )
  }
  return <div className={classes}>{body}</div>
}

/** Responsive row of StatCards. Keeps every page's figure row on the same grid. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  // Two to a row even on a phone, so the figures do not fill the first screen.
  return <div className={cn("grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4", className)}>{children}</div>
}

/** The filter / search / export strip that sits above a table. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("surface-card flex flex-wrap items-center gap-2 p-3", className)}>{children}</div>
  )
}

export type Column = {
  label: ReactNode
  align?: "left" | "right" | "center"
  className?: string
}

/** A table in its panel: one header band, one row rhythm, one scroll container. */
export function TableShell({
  columns,
  children,
  caption,
  footer,
  className,
}: {
  columns: Column[]
  children: ReactNode
  caption?: ReactNode
  /** Pager or summary strip under the rows. */
  footer?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("surface-card overflow-hidden", className)}>
      {caption ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
          {caption}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  key={index}
                  className={cn(
                    column.align === "right" && "text-right",
                    column.align === "center" && "text-center",
                    column.className
                  )}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {footer ?? null}
    </div>
  )
}

/**
 * The one "nothing here" picture: a soft circle with an icon, the message, and
 * an optional hint and action. Every empty list, table and panel uses it, so
 * an empty screen reads as calm and finished rather than broken.
 */
export function EmptyNote({
  title,
  hint,
  action,
  icon: Icon = Inbox,
  className,
}: {
  title: ReactNode
  hint?: ReactNode
  action?: ReactNode
  icon?: LucideIcon
  className?: string
}) {
  return (
    <div className={cn("motion-rise flex flex-col items-center px-6 py-10 text-center", className)}>
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" />
      </span>
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}

/** The "nothing here" row inside a TableShell. */
export function TableEmpty({
  colSpan,
  children,
  icon,
}: {
  colSpan: number
  children: ReactNode
  icon?: LucideIcon
}) {
  return (
    <tr className="hover:bg-transparent">
      <td colSpan={colSpan} className="p-0">
        <EmptyNote title={children} icon={icon} className="py-8" />
      </td>
    </tr>
  )
}

export function StatusBadge({ value, label }: { value: string; label?: string }) {
  return <Badge variant={statusTone(value)}>{label ?? statusLabel(value)}</Badge>
}

export function EmptyState({
  title,
  hint,
  action,
  icon,
}: {
  title: string
  hint?: string
  action?: ReactNode
  icon?: LucideIcon
}) {
  return (
    <div className="rounded-xl border border-dashed border-border">
      <EmptyNote title={title} hint={hint} action={action} icon={icon} className="py-12" />
    </div>
  )
}

/**
 * A pill saying what state something is in, in the one shape used everywhere.
 * Prefer this over hand-written coloured spans.
 */
export function TonePill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  const tones: Record<Tone, string> = {
    neutral: "bg-muted text-muted-foreground",
    primary: "bg-primary-soft text-primary",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
    info: "bg-info-soft text-info",
  }
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold", tones[tone])}>
      {children}
    </span>
  )
}

/** The small grey code tag used for a shop, e.g. `IWO`. */
export function ShopTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
      {children}
    </span>
  )
}

/** Kept for the home screen. Same box as StatCard, with its month-on-month line. */
export function KpiCard({
  label,
  value,
  trend,
  icon,
  href,
}: {
  label: string
  value: string
  trend?: { value: string; up?: boolean }
  icon: ReactNode
  href?: string
}) {
  return (
    <StatCard
      label={label}
      value={value}
      icon={icon}
      href={href}
      hint={
        trend ? (
          <span className={trend.up === false ? "font-medium text-danger" : "font-medium text-success"}>
            {trend.value} from last month
          </span>
        ) : undefined
      }
    />
  )
}
