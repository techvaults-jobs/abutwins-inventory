import Link from "next/link"
import {
  AlertTriangle,
  ArrowLeftRight,
  BadgeCheck,
  Banknote,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Gauge,
  GitBranch,
  PackageX,
  Receipt,
  ScrollText,
  Settings,
  Store,
  Tags,
  Truck,
  Undo2,
  Upload,
  UserRoundCog,
  UserX,
  Wallet,
  type LucideIcon,
} from "lucide-react"
import { getDashboardData } from "@/app/actions/dashboard"
import { DevicePie, SalesPurchaseChart } from "@/components/dashboard-charts"
import { KpiCard, Sparkline, StatCard, StatGrid } from "@/components/shared"
import { Badge } from "@/components/ui/badge"
import { formatShopWhen, formatWatLong, watDayKey } from "@/lib/lagos-day"
import { getAllowedKeys, hrefsForKeys } from "@/lib/permissions"
import { canSeeBusinessTotals } from "@/lib/roles"
import { getAppSettings, lowStockLimit } from "@/lib/settings"
import { InstallAppBanner } from "@/components/install-app"
import { UpdatedStamp } from "@/components/updated-stamp"
import { HomeShortcuts } from "./home-shortcuts"
import { formatCurrency, money } from "@/lib/utils"

/** The jobs people open the app to do, in the order a shop reaches for them. */
const QUICK_ACTIONS: Array<{ href: string; label: string; icon: LucideIcon; primary?: boolean }> = [
  { href: "/pos", label: "Sell now", icon: Store, primary: true },
  { href: "/returns", label: "Take a return", icon: Undo2 },
  { href: "/inventory", label: "Shop stock", icon: Boxes },
  { href: "/products", label: "Price list", icon: Tags },
  { href: "/uploads", label: "Upload stock", icon: Upload },
  { href: "/expenses", label: "Shop expense", icon: Receipt },
  { href: "/approvals", label: "Needs approval", icon: BadgeCheck },
  { href: "/owner", label: "Business today", icon: Gauge },
  // The main admin's jobs, for a Home that is about keeping the system running.
  { href: "/staff", label: "Staff", icon: UserRoundCog },
  { href: "/branches", label: "Shops", icon: GitBranch },
  { href: "/audit", label: "Who did what", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
]

const TASK_ICON: Record<string, LucideIcon> = {
  "/pos": Clock,
  "/audit?risk=HIGH": AlertTriangle,
  "/incoming": Truck,
  "/transfers": ArrowLeftRight,
  "/sales": UserX,
  "/inventory": PackageX,
  "/approvals": BadgeCheck,
}

/**
 * How urgent each "Needs you" line is. Stuck work (money or a phone in limbo,
 * someone waiting on a yes) comes first, then work waiting
 * on another person, then tidying. The dot carries the level, so the list
 * reads at a glance instead of every line wearing the same amber.
 */
const URGENCY: Record<string, { rank: number; dot: string; word: string }> = {
  "/swaps": { rank: 0, dot: "bg-danger", word: "Stuck" },
  "/audit?risk=HIGH": { rank: 0, dot: "bg-danger", word: "Stuck" },
  "/approvals": { rank: 0, dot: "bg-danger", word: "Waiting on you" },
  "/returns": { rank: 1, dot: "bg-warning", word: "Waiting" },
  "/pos": { rank: 1, dot: "bg-warning", word: "Waiting" },
  "/incoming": { rank: 1, dot: "bg-warning", word: "Waiting" },
  "/transfers": { rank: 1, dot: "bg-warning", word: "Waiting" },
  "/sales": { rank: 2, dot: "bg-info", word: "Tidy up" },
  "/inventory": { rank: 2, dot: "bg-info", word: "Tidy up" },
}
const TIDY = { rank: 2, dot: "bg-info", word: "Tidy up" }

/** Office jobs that watch the shops rather than sell in them. */
const OFFICE_ROLES = ["SUPER_ADMIN", "CEO", "ACCOUNTANT", "AUDITOR"]

/** Today against the same weekday last week, as a small chip. */
function WeekChip({ now, then, lead = false }: { now: number; then: number; lead?: boolean }) {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "long" }).format(new Date())
  if (then <= 0) {
    if (now <= 0) return null
    return <Chip lead={lead} up>New on a {weekday}</Chip>
  }
  const change = Math.round(((now - then) / then) * 100)
  if (change === 0) return <Chip lead={lead}>Same as last {weekday}</Chip>
  return (
    <Chip lead={lead} up={change > 0}>
      {change > 0 ? "↑" : "↓"} {Math.abs(change)}% on last {weekday}
    </Chip>
  )
}

function Chip({ children, up = false, lead = false }: { children: React.ReactNode; up?: boolean; lead?: boolean }) {
  const tone = lead
    ? "bg-[hsl(var(--lead-fg)/0.14)] text-[hsl(var(--lead-fg))]"
    : up
      ? "bg-success-soft text-success"
      : "bg-muted text-muted-foreground"
  return <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>{children}</span>
}

function greeting() {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Africa/Lagos" }).format(new Date())
  )
  if (hour < 12) return "Good morning"
  if (hour < 17) return "Good afternoon"
  return "Good evening"
}

export default async function DashboardPage() {
  const [data, settings] = await Promise.all([getDashboardData(), getAppSettings()])
  const allowed = new Set(hrefsForKeys(await getAllowedKeys(data.user.role)))
  const actions = QUICK_ACTIONS.filter((action) => allowed.has(action.href)).slice(0, 6)
  const firstName = (data.user.name ?? "").split(/\s+/)[0]
  const gaps = data.imeiCheck.filter((row) => row.delta !== 0)
  const sellsHere = allowed.has("/pos")
  // Sales, money and stock figures are for people who work the business. A
  // system-only main admin gets their jobs and what needs them, nothing more.
  const seesBusiness = ["/sales", "/finance", "/reports", "/owner", "/inventory", "/pos"].some((href) => allowed.has(href))
  // The business's totals (the shop's sales and takings today, what customers
  // and suppliers are owed, the month, stock value, the ranking) are for the
  // CEO, the Accountant and the main admin. The CEO found sales staff and
  // other staff reading them on Home. Everyone else sees their own sales.
  const seesTotals = seesBusiness && canSeeBusinessTotals(data.user.role)
  const tasks = data.tasks
    .filter((task) => allowed.has(task.href.split("?")[0]))
    .map((task) => ({ ...task, urgency: URGENCY[task.href] ?? TIDY }))
    .sort((a, b) => a.urgency.rank - b.urgency.rank || b.count - a.count)
  // "Your sales today" is for people who sell. The office sees it only on a
  // day they rang something up themselves.
  const showMine = sellsHere && (!OFFICE_ROLES.includes(data.user.role) || data.today.mine > 0)
  const showToday = seesTotals || showMine

  return (
    <div className="motion-stagger space-y-6">
      <HomeShortcuts canSell={sellsHere} />
      <InstallAppBanner />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{formatWatLong(watDayKey())}</p>
          <h2 className="text-2xl font-semibold tracking-tight">
            {greeting()}
            {firstName ? `, ${firstName}` : ""}
          </h2>
        </div>
        <UpdatedStamp at={new Date().toISOString()} />
      </div>

      {actions.length ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {actions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className={
                action.primary
                  ? "relative flex flex-col items-center justify-center gap-1.5 rounded-xl bg-primary px-2 py-3.5 text-center text-sm font-semibold text-primary-foreground shadow-sm transition-[transform,background-color] duration-press ease-standard hover:-translate-y-0.5 hover:bg-primary/90 active:scale-[0.97]"
                  : "surface-card-interactive flex flex-col items-center justify-center gap-1.5 px-2 py-3.5 text-center text-sm font-medium transition-transform duration-press ease-standard hover:-translate-y-0.5 active:scale-[0.97]"
              }
            >
              <action.icon className="h-5 w-5" />
              <span className="leading-tight">{action.label}</span>
              {action.href === "/pos" ? (
                <kbd className="absolute right-2 top-2 hidden rounded border border-current/30 px-1.5 font-mono text-[10px] font-medium opacity-70 lg:inline">
                  S
                </kbd>
              ) : null}
            </Link>
          ))}
        </div>
      ) : null}

      {seesBusiness && showToday ? (
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Today</h3>
        <StatGrid className={!seesTotals ? "xl:grid-cols-4" : showMine ? "xl:grid-cols-4" : "xl:grid-cols-3"}>
          {seesTotals ? (
          <>
          <StatCard
            lead
            label="Sales today"
            value={formatCurrency(data.today.sales)}
            chart={<Sparkline points={data.today.week} label="Sales each day for the last seven days" />}
            hint={`${data.today.count} sale${data.today.count === 1 ? "" : "s"} · the line is the last seven days`}
            note={<WeekChip lead now={data.today.sales} then={data.today.lastWeekSales} />}
            href="/sales"
            className="col-span-2 xl:col-span-1"
          />
          <StatCard
            label="Taken today"
            value={formatCurrency(data.today.paid)}
            hint={
              data.today.debtsCollected > 0
                ? `Includes ${formatCurrency(data.today.debtsCollected)} debts collected on earlier sales`
                : "Money that came in today"
            }
            note={<WeekChip now={data.today.paid} then={data.today.lastWeekTaken} />}
          />
          <StatCard
            label="Still owed to us"
            value={formatCurrency(data.today.owed)}
            tone={data.today.owed > 0 ? "warning" : "neutral"}
            hint={
              data.today.owedCustomers > 0
                ? `${data.today.owedCustomers} customer${data.today.owedCustomers === 1 ? "" : "s"} · everything owed today`
                : "Nobody owes us right now"
            }
            href="/customers"
          />
          </>
          ) : null}
          {showMine ? (
            <StatCard
              label="Your sales today"
              value={formatCurrency(data.today.mine)}
              hint={`${data.today.mineCount} sale${data.today.mineCount === 1 ? "" : "s"} by you`}
              className="col-span-2 xl:col-span-1"
            />
          ) : null}
        </StatGrid>
      </section>
      ) : null}

      <section>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Needs you</h3>
          {tasks.length ? <span className="text-xs text-muted-foreground">Most urgent first</span> : null}
        </div>
        {tasks.length ? (
          <ul className="surface-card divide-y divide-border overflow-hidden">
            {tasks.map((task) => {
              const Icon = TASK_ICON[task.href] ?? AlertTriangle
              return (
                <li key={task.href + task.label}>
                  <Link
                    href={task.href}
                    className="group flex items-center gap-3 px-4 py-3 transition-colors duration-press ease-standard hover:bg-muted/50"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${task.urgency.dot}`} title={task.urgency.word} aria-hidden />
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-medium">
                      {task.label}
                      <span className="sr-only"> ({task.urgency.word})</span>
                    </span>
                    <span className="rounded-full bg-muted px-2.5 py-0.5 text-sm font-semibold tabular-nums">{task.count}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-press ease-standard group-hover:translate-x-0.5" />
                  </Link>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="surface-card flex items-center gap-3 px-4 py-4 text-sm">
            <CheckCircle2 className="h-5 w-5 text-success" />
            <span>Nothing waiting. The shops you can see are clear for now.</span>
          </div>
        )}
      </section>

      {seesBusiness ? (
        <>
      {seesTotals ? (
        <>
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">This month</h3>
        <StatGrid>
          <KpiCard label="Sales" value={formatCurrency(data.kpis.totalSales)} trend={data.kpis.salesTrend} icon={<Receipt className="h-4 w-4" />} href="/sales" />
          <KpiCard label="Money collected" value={formatCurrency(data.kpis.paymentReceived)} trend={data.kpis.paymentReceivedTrend} icon={<Wallet className="h-4 w-4" />} />
          <KpiCard label="Shop expenses" value={formatCurrency(data.kpis.totalExpense)} trend={data.kpis.expenseTrend} icon={<CreditCard className="h-4 w-4" />} href="/expenses" />
          <KpiCard label="Paid to suppliers" value={formatCurrency(data.kpis.paymentSent)} trend={data.kpis.paymentSentTrend} icon={<Banknote className="h-4 w-4" />} />
        </StatGrid>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Money and stock</h3>
        <StatGrid className="xl:grid-cols-3">
          <StatCard
            label={data.kpis.stockAtCost ? "Stock at cost" : "Stock at sell price"}
            value={formatCurrency(data.kpis.stockValue)}
            href="/inventory"
          />
          <StatCard
            label="We owe suppliers"
            value={formatCurrency(data.exceptions.creditorOwed)}
            hint={data.exceptions.supplierCredit > 0 ? `They owe us ${formatCurrency(data.exceptions.supplierCredit)}` : undefined}
            href="/suppliers"
          />
          <StatCard
            label="IMEI vs shop count"
            value={gaps.length ? `${gaps.length} gap${gaps.length === 1 ? "" : "s"}` : "All match"}
            tone={gaps.length ? "danger" : "success"}
            href="#imei-check"
          />
        </StatGrid>
      </section>

      <div className="grid gap-4 xl:grid-cols-7">
        <div className="surface-card p-5 sm:p-6 xl:col-span-4">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold">Sales vs goods bought</h3>
              <p className="text-sm text-muted-foreground">Last six months</p>
            </div>
            <Badge variant="muted">6 months</Badge>
          </div>
          <SalesPurchaseChart data={data.chartSales} />
        </div>
        <div className="surface-card p-5 sm:p-6 xl:col-span-3">
          <h3 className="font-semibold">Phones by brand</h3>
          <p className="mb-4 text-sm text-muted-foreground">Phones and laptops in the shops</p>
          <DevicePie data={data.devices} />
        </div>
      </div>
        </>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-7">
        <div className="surface-card overflow-hidden xl:col-span-4">
          <div className="flex items-center justify-between px-5 py-4">
            <h3 className="font-semibold">Recent sales</h3>
            <Link href="/sales" className="text-sm font-medium text-primary hover:underline">
              See all
            </Link>
          </div>
          <ul className="divide-y divide-border border-t border-border">
            {data.recentSales.map((sale) => (
              <li key={sale.id}>
                <Link href={`/sales/${sale.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/50">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{sale.customer?.name ?? "Walk-in"}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {sale.invoiceNumber} · {sale.branch.name} · {formatShopWhen(sale.saleDate)}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCurrency(money(sale.totalAmount))}</span>
                </Link>
              </li>
            ))}
            {data.recentSales.length === 0 ? <li className="px-5 py-6 text-sm text-muted-foreground">No sales yet.</li> : null}
          </ul>
        </div>

        <div className="space-y-4 xl:col-span-3">
          <div className="surface-card p-5">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="font-semibold">Fewest left</h3>
              <Link href="/inventory" className="text-sm font-medium text-primary hover:underline">
                Shop stock
              </Link>
            </div>
            <div className="space-y-2.5">
              {data.stock.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{row.product.name}</p>
                    <p className="text-xs text-muted-foreground">{row.branch.code}</p>
                  </div>
                  <Badge variant={row.quantity <= lowStockLimit(row.minStock, settings.lowStockThreshold) ? "danger" : "success"}>
                    {row.quantity} left
                  </Badge>
                </div>
              ))}
            </div>
          </div>
          {seesTotals && data.ranking.length > 1 ? (
            <div className="surface-card p-5">
              <h3 className="mb-3 font-semibold">Shop sales ranking</h3>
              <div className="space-y-2.5">
                {data.ranking.map((row, index) => {
                  const top = data.ranking[0]?.revenue || 1
                  return (
                    <div key={row.name} className="text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate">
                          {index + 1}. {row.name}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums">{formatCurrency(row.revenue)}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(2, (row.revenue / top) * 100)}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div id="imei-check" className="surface-card scroll-mt-20 overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-5 py-4">
          <div>
            <h3 className="font-semibold">IMEI vs shop count</h3>
            <p className="text-sm text-muted-foreground">
              {gaps.length
                ? "Only the items where the shelf and the IMEI list disagree."
                : `All ${data.imeiCheck.length} phone and laptop lines match.`}
            </p>
          </div>
          <Badge variant={gaps.length ? "danger" : "success"}>{gaps.length ? `${gaps.length} gap${gaps.length === 1 ? "" : "s"}` : "Match"}</Badge>
        </div>
        {gaps.length ? (
          <ul className="divide-y divide-border border-t border-border">
            {gaps.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{row.product}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {row.shop} · shelf {row.shopQty} · IMEIs {row.imeis}
                  </p>
                </div>
                <Badge variant="danger">
                  {row.delta > 0 ? `${row.delta} extra IMEI${row.delta === 1 ? "" : "s"}` : `${Math.abs(row.delta)} missing`}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* ── CEO / owner panels ─────────────────────────────────────────── */}
      {data.salesByStaff.length > 0 ? (
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Who sold today</h3>
            <Link href="/sales" className="text-sm font-medium text-primary hover:underline">See all sales</Link>
          </div>
          <div className="surface-card overflow-hidden">
            <ul className="divide-y divide-border">
              {data.salesByStaff.map((row) => (
                <li key={row.userId} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {(row.name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.role.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}
                      {row.shop ? ` · ${row.shop}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold tabular-nums">{formatCurrency(row.salesValue)}</p>
                    <p className="text-xs text-muted-foreground">{row.salesCount} sale{row.salesCount === 1 ? "" : "s"}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
        </>
      ) : null}
    </div>
  )
}
