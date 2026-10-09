"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ExternalLink, FileSpreadsheet } from "lucide-react"
import { DataTable, type DataColumn } from "@/components/data-table"
import { DayRangeFilter } from "@/components/day-range-filter"
import { FilterChips } from "@/components/filter-chips"
import { StatusBadge } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { downloadTable } from "@/lib/download-table"
import { formatShopWhen, matchesDayRange } from "@/lib/lagos-day"
import { statusLabel } from "@/lib/status"
import { cn, formatCurrency, formatCurrencyShort } from "@/lib/utils"
import { PaymentTrail } from "@/components/payment-trail"
import { trailText, type PaymentStep } from "@/lib/payment-trail"

export type SaleRow = {
  id: string
  invoiceNumber: string
  saleDate: string
  totalAmount: number
  paidAmount: number
  discount: number
  paymentMethod: string
  status: string
  isWholesale: boolean
  customer: { name: string; phone: string | null } | null
  branch: { code: string; name: string }
  soldBy: string | null
  /** What finished refunds and credit notes took off this sale. */
  returned: number
  /** Every payment reference on the sale (transfer description, POS code), latest first. */
  paymentRefs: string[]
  /** Each time money was taken on the sale, in order: at the till, then each part payment. */
  payments: PaymentStep[]
  /** Bank name and account number that received a non-cash payment. */
  paymentBank: string | null
  items: Array<{ id: string; name: string; specs: string; imei: string | null; quantity: number; unitPrice: number; totalPrice: number }>
}

type PayFilter = "all" | "paid" | "part" | "unpaid"

/** Still due on a sale after what came back: the same rule as Customers and Reports. */
function saleDue(sale: SaleRow) {
  return Math.max(0, sale.totalAmount - sale.paidAmount - sale.returned)
}

function payKey(sale: SaleRow): Exclude<PayFilter, "all"> {
  if (saleDue(sale) <= 0.001) return "paid"
  if (sale.paidAmount <= 0) return "unpaid"
  return "part"
}

/** Paid minus sales. Zero when settled. Negative when the buyer still owes. */
function saleBalance(sale: SaleRow) {
  // A return clears what was owed first, so a returned sale is settled, not
  // overpaid. Only money paid beyond the invoice itself shows as "over".
  const due = saleDue(sale)
  if (due > 0.005) return -due
  return Math.max(0, sale.paidAmount - sale.totalAmount)
}

/**
 * A sale's balance is negative while the buyer still owes. That money is owed
 * to us, not lost, so it shows as the amount still owed, in amber, never as a
 * red minus figure that reads like a loss.
 */
function balanceTone(balance: number) {
  return balance < -0.005 ? "text-warning" : balance > 0.005 ? "text-success" : "text-muted-foreground"
}

function balanceWords(balance: number) {
  if (balance < -0.005) return formatCurrency(-balance)
  if (balance > 0.005) return `${formatCurrency(balance)} over`
  return "—"
}

function searchText(sale: SaleRow) {
  return [
    sale.invoiceNumber,
    sale.customer?.name,
    sale.customer?.phone,
    sale.branch.name,
    sale.branch.code,
    sale.soldBy,
    sale.paymentBank,
    ...sale.paymentRefs,
    ...sale.payments.map((step) => step.by),
    ...sale.items.flatMap((item) => [item.name, item.specs, item.imei]),
  ]
    .filter(Boolean)
    .join(" ")
}

function exportRows(rows: SaleRow[]) {
  return [
    [
      "Invoice",
      "Date",
      "Shop",
      "Buyer",
      "Sold by",
      "Items",
      "Sales",
      "Paid",
      "Returned",
      "Still owed",
      "Payment",
      "Bank",
      "Refs",
      "Payments made",
      "Payments step by step",
      "Status",
    ],
    ...rows.map((sale) => [
      sale.invoiceNumber,
      formatShopWhen(sale.saleDate),
      sale.branch.name,
      sale.customer?.name ?? "Walk-in",
      sale.soldBy ?? "",
      sale.items.map((item) => `${item.quantity} × ${item.name}${item.specs ? ` [${item.specs}]` : ""}${item.imei ? ` (${item.imei})` : ""}`).join("; "),
      sale.totalAmount,
      sale.paidAmount,
      sale.returned,
      Math.max(0, -saleBalance(sale)),
      statusLabel(sale.paymentMethod),
      sale.paymentBank ?? "",
      sale.paymentRefs.join("; "),
      sale.payments.length,
      trailText(sale.payments, formatShopWhen, formatCurrency),
      statusLabel(sale.status),
    ]),
  ]
}

export function SalesList({ sales }: { sales: SaleRow[] }) {
  const router = useRouter()
  const [pay, setPay] = useState<PayFilter>("all")
  const [range, setRange] = useState({ from: "", to: "" })
  const [open, setOpen] = useState<SaleRow | null>(null)
  const [query, setQuery] = useState("")

  const inRange = useMemo(
    () => sales.filter((sale) => matchesDayRange(sale.saleDate, range.from, range.to)),
    [sales, range]
  )
  const filtered = useMemo(
    () => (pay === "all" ? inRange : inRange.filter((sale) => payKey(sale) === pay)),
    [inRange, pay]
  )
  // The figures and the totals row follow the search box too, not only the chips.
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return filtered
    return filtered.filter((sale) => {
      const hay = searchText(sale).toLowerCase()
      return words.every((word) => hay.includes(word))
    })
  }, [filtered, query])
  const counts = useMemo(
    () => ({
      all: inRange.length,
      paid: inRange.filter((sale) => payKey(sale) === "paid").length,
      part: inRange.filter((sale) => payKey(sale) === "part").length,
      unpaid: inRange.filter((sale) => payKey(sale) === "unpaid").length,
    }),
    [inRange]
  )
  const totals = useMemo(
    () =>
      visible.reduce(
        (acc, sale) => {
          acc.sales += sale.totalAmount
          acc.paid += sale.paidAmount
          acc.returned += sale.returned
          acc.balance += saleBalance(sale)
          return acc
        },
        { sales: 0, paid: 0, returned: 0, balance: 0 }
      ),
    [visible]
  )

  const columns: DataColumn<SaleRow>[] = [
    {
      id: "invoice",
      header: "Invoice",
      sortValue: (sale) => sale.invoiceNumber,
      cell: (sale) => (
        <div className="flex items-center gap-2">
          <Link href={`/sales/${sale.id}`} className="whitespace-nowrap font-medium text-primary hover:underline">
            {sale.invoiceNumber}
          </Link>
          {sale.status !== "COMPLETED" ? <StatusBadge value={sale.status} /> : null}
        </div>
      ),
    },
    {
      id: "when",
      header: "When",
      sortValue: (sale) => sale.saleDate,
      cell: (sale) => <span className="whitespace-nowrap tabular-nums">{formatShopWhen(sale.saleDate)}</span>,
    },
    {
      id: "buyer",
      header: "Buyer",
      sortValue: (sale) => sale.customer?.name ?? "",
      cell: (sale) =>
        sale.customer ? (
          <span className="whitespace-nowrap font-medium">{sale.customer.name}</span>
        ) : (
          <span className="whitespace-nowrap text-muted-foreground">
            Walk-in <span className="ml-1 rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">no name</span>
          </span>
        ),
    },
    {
      id: "shop",
      header: "Shop",
      hideBelow: "lg",
      sortValue: (sale) => sale.branch.name,
      cell: (sale) => (
        <span className="whitespace-nowrap" title={sale.branch.name}>
          {sale.branch.name}
        </span>
      ),
    },
    {
      id: "sales",
      header: "Sales",
      align: "right",
      sortValue: (sale) => sale.totalAmount,
      cell: (sale) => <span className="font-medium">{formatCurrency(sale.totalAmount)}</span>,
    },
    {
      id: "paid",
      header: "Paid",
      align: "right",
      hideBelow: "xl",
      sortValue: (sale) => sale.paidAmount,
      cell: (sale) => formatCurrency(sale.paidAmount),
    },
    {
      id: "returned",
      header: "Returned",
      align: "right",
      hideBelow: "lg",
      sortValue: (sale) => sale.returned,
      cell: (sale) =>
        sale.returned > 0 ? (
          <span className="font-medium text-warning">−{formatCurrency(sale.returned)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "balance",
      header: "Still owed",
      align: "right",
      sortValue: (sale) => saleBalance(sale),
      cell: (sale) => {
        const balance = saleBalance(sale)
        return <span className={cn("font-semibold", balanceTone(balance))}>{balanceWords(balance)}</span>
      },
    },
    {
      id: "method",
      header: "Payment",
      hideBelow: "lg",
      sortValue: (sale) => statusLabel(sale.paymentMethod),
      cell: (sale) => (
        <div className="min-w-0">
          <p className="whitespace-nowrap">{statusLabel(sale.paymentMethod)}</p>
          {sale.paymentBank ? <p className="text-xs text-muted-foreground">{sale.paymentBank}</p> : null}
          {sale.payments.length > 1 ? (
            <p className="whitespace-nowrap text-[11px] font-medium text-primary">{sale.payments.length} payments</p>
          ) : null}
        </div>
      ),
    },
    {
      id: "ref",
      header: "Ref",
      hideBelow: "lg",
      sortValue: (sale) => sale.paymentRefs[0] ?? "",
      cell: (sale) =>
        sale.paymentRefs.length ? (
          <div className="min-w-0" title={sale.paymentRefs.join("\n")}>
            <p className="font-mono text-xs text-foreground">{sale.paymentRefs[0]}</p>
            {sale.paymentRefs.length > 1 ? (
              <p className="text-[11px] text-muted-foreground">+{sale.paymentRefs.length - 1} earlier</p>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ]

  return (
    <div className="space-y-4">
      {/* The real sales value: what was sold less what came back for a refund
          or a credit note. The return log keeps the detail; this keeps the
          headline honest at a glance. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        <Figure
          lead
          label="Sales after returns"
          value={totals.sales - totals.returned}
          hint={
            totals.returned > 0
              ? `${formatCurrency(totals.sales)} sold, ${formatCurrency(totals.returned)} returned`
              : `${visible.length} sale${visible.length === 1 ? "" : "s"}`
          }
          active={pay === "all"}
          onClick={() => setPay("all")}
        />
        <Figure
          label="Received"
          value={totals.paid}
          hint={`${counts.paid} paid up · tap to see`}
          active={pay === "paid"}
          onClick={() => setPay("paid")}
        />
        <Figure
          label="Returned"
          value={totals.returned}
          hint={totals.returned > 0 ? "Refunds and credit notes on these sales" : "Nothing returned"}
          tone={totals.returned > 0 ? "text-warning" : undefined}
        />
        <Figure
          label="Still owed to us"
          value={Math.max(0, -totals.balance)}
          hint={`${counts.part + counts.unpaid} bill${counts.part + counts.unpaid === 1 ? "" : "s"} · tap to see`}
          tone={balanceTone(totals.balance)}
          active={pay === "unpaid" || pay === "part"}
          onClick={() => setPay(pay === "unpaid" ? "part" : "unpaid")}
        />
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(sale) => sale.id}
        noun="sales"
        filterKey={`${pay}|${range.from}|${range.to}`}
        initialSort={{ id: "when", dir: "desc" }}
        onRowClick={setOpen}
        searchText={searchText}
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder="Search invoice, buyer, phone, IMEI or item"
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10"
            onClick={() => downloadTable(exportRows(visible), "sales.xlsx", "xlsx")}
            aria-label="Download these sales as Excel"
          >
            <FileSpreadsheet className="h-4 w-4 sm:mr-1.5" />
            <span className="hidden sm:inline">Excel</span>
          </Button>
        }
        filters={
          <div className="grid gap-3 lg:grid-cols-2">
            <FilterChips
              label="Money on the bill"
              activeKey={pay}
              onSelect={(key) => setPay(key as PayFilter)}
              chips={[
                { key: "all", label: "All", count: counts.all },
                { key: "paid", label: "Paid up", count: counts.paid, tone: "success" },
                { key: "part", label: "Part paid", count: counts.part, tone: "warning" },
                { key: "unpaid", label: "Unpaid", count: counts.unpaid, tone: "danger" },
              ]}
            />
            <DayRangeFilter label="When it was sold" from={range.from} to={range.to} onChange={setRange} />
          </div>
        }
        card={(sale) => {
          const balance = saleBalance(sale)
          return {
            title: sale.customer?.name ?? "Walk-in",
            subtitle: `${sale.invoiceNumber} · ${formatShopWhen(sale.saleDate)}`,
            value: formatCurrency(sale.totalAmount),
            valueHint:
              balance < -0.005 ? <span className="text-warning">Owes {formatCurrency(-balance)}</span> : <span className="text-success">Paid</span>,
            meta: (
              <>
                <span>{sale.branch.name}</span>
                <span>· {statusLabel(sale.paymentMethod)}</span>
                {sale.paymentBank ? <span className="text-muted-foreground">· {sale.paymentBank}</span> : null}
                <span>· {sale.items.length} item{sale.items.length === 1 ? "" : "s"}</span>
              </>
            ),
          }
        }}
        bulkActions={(picked) => (
          <button
            type="button"
            className="rounded-md bg-background/15 px-2.5 py-1 font-medium hover:bg-background/25"
            onClick={() => downloadTable(exportRows(picked), "sales-ticked.xlsx", "xlsx")}
          >
            Excel of ticked
          </button>
        )}
        footer={(rows) => (
          <tr>
            <td />
            <td colSpan={3} className="text-sm">Totals for {rows.length} sale{rows.length === 1 ? "" : "s"}</td>
            <td className="hidden lg:table-cell" />
            <td className="whitespace-nowrap text-right tabular-nums">{formatCurrency(totals.sales)}</td>
            <td className="hidden whitespace-nowrap text-right tabular-nums xl:table-cell">{formatCurrency(totals.paid)}</td>
            <td className="hidden whitespace-nowrap text-right tabular-nums text-warning lg:table-cell">
              {totals.returned > 0 ? `−${formatCurrency(totals.returned)}` : "—"}
            </td>
            <td className={cn("whitespace-nowrap text-right tabular-nums", balanceTone(totals.balance))}>{balanceWords(totals.balance)}</td>
            <td className="hidden lg:table-cell" />
            <td className="hidden xl:table-cell" />
          </tr>
        )}
        empty={sales.length === 0 ? "No sales on the books yet." : "No sale matches these filters."}
      />

      <Sheet open={Boolean(open)} onOpenChange={(value) => !value && setOpen(null)}>
        {open ? (
          <SheetContent
            title={open.invoiceNumber}
            description={`${formatShopWhen(open.saleDate)} · ${open.branch.name}${open.soldBy ? ` · sold by ${open.soldBy}` : ""}`}
            footer={
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => router.push(`/sales/${open.id}`)}>
                  <ExternalLink className="mr-1.5 h-4 w-4" /> Open invoice
                </Button>
                <Button variant="outline" onClick={() => router.push(`/sales/${open.id}?receipt=1`)}>
                  Print receipt
                </Button>
              </div>
            }
          >
            <SaleQuickLook sale={open} />
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  )
}

function Figure({
  label, value, hint, tone, lead = false, active, onClick,
}: {
  label: string
  value: number
  hint: string
  tone?: string
  lead?: boolean
  active?: boolean
  onClick?: () => void
}) {
  const isClickable = Boolean(onClick)
  return (
    <div
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={isClickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.() } } : undefined}
      title={isClickable ? `${formatCurrency(value)} — tap to filter the list` : formatCurrency(value)}
      className={cn(
        "surface-card min-w-0 p-3 sm:p-4 transition-all",
        lead && "border-[hsl(var(--lead-bg))] bg-[hsl(var(--lead-bg))] text-[hsl(var(--lead-fg))]",
        isClickable && "cursor-pointer select-none",
        isClickable && active && "ring-2 ring-primary ring-offset-1",
        isClickable && !active && "hover:border-primary/40 hover:shadow-sm"
      )}
    >
      <p className={cn("truncate text-[10px] font-semibold uppercase tracking-wider sm:text-xs", lead ? "text-[hsl(var(--lead-fg)/0.7)]" : "text-muted-foreground")}>
        {label}
        {isClickable && !active && (
          <span className="ml-1 hidden font-normal normal-case tracking-normal text-muted-foreground/60 sm:inline">tap to filter</span>
        )}
        {isClickable && active && (
          <span className="ml-1 hidden font-normal normal-case tracking-normal text-primary sm:inline">filtered</span>
        )}
      </p>
      <p className={cn("mt-1 truncate text-base font-semibold tabular-nums sm:text-2xl", value === 0 ? "" : tone)}>
        {value >= 1_000_000 ? formatCurrencyShort(value) : formatCurrency(value)}
      </p>
      <p className={cn("mt-0.5 hidden truncate text-xs sm:block", lead ? "text-[hsl(var(--lead-fg)/0.7)]" : "text-muted-foreground")}>{hint}</p>
    </div>
  )
}

function SaleQuickLook({ sale }: { sale: SaleRow }) {
  const balance = saleBalance(sale)
  return (
    <div className="space-y-5">
      <div className={cn("grid gap-2 rounded-xl bg-muted/60 p-3 text-center", sale.returned > 0 ? "grid-cols-4" : "grid-cols-3")}>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Sales</p>
          <p className="font-semibold tabular-nums">{formatCurrency(sale.totalAmount)}</p>
        </div>
        {sale.returned > 0 ? (
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Returned</p>
            <p className="font-semibold tabular-nums text-warning">−{formatCurrency(sale.returned)}</p>
          </div>
        ) : null}
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Paid</p>
          <p className="font-semibold tabular-nums">{formatCurrency(sale.paidAmount)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Still owed</p>
          <p className={cn("font-semibold tabular-nums", balanceTone(balance))}>{balanceWords(balance)}</p>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Buyer</dt>
        <dd className="font-medium">
          {sale.customer ? `${sale.customer.name}${sale.customer.phone ? ` · ${sale.customer.phone}` : ""}` : "Walk-in"}
        </dd>
        <dt className="text-muted-foreground">Payment</dt>
        <dd className="space-y-0.5">
          <span>{statusLabel(sale.paymentMethod)}{sale.isWholesale ? " · reseller" : ""}</span>
          {sale.paymentBank ? (
            <p className="text-xs text-muted-foreground">{sale.paymentBank}</p>
          ) : null}
          {sale.payments.length > 1 ? (
            <p className="text-xs text-muted-foreground">Paid in {sale.payments.length} steps. See How it was paid below.</p>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd><StatusBadge value={sale.status} /></dd>
        {sale.discount > 0 ? (
          <>
            <dt className="text-muted-foreground">Discount</dt>
            <dd className="tabular-nums">{formatCurrency(sale.discount)}</dd>
          </>
        ) : null}
      </dl>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">How it was paid</p>
        <PaymentTrail steps={sale.payments} total={sale.totalAmount} returned={sale.returned} />
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {sale.items.length} item{sale.items.length === 1 ? "" : "s"}
        </p>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {sale.items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{item.name}</p>
                {item.specs ? <p className="text-xs text-muted-foreground">{item.specs}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {item.imei ? <span className="font-mono">{item.imei}</span> : `${item.quantity} × ${formatCurrency(item.unitPrice)}`}
                </p>
              </div>
              <span className="shrink-0 font-semibold tabular-nums">{formatCurrency(item.totalPrice)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
