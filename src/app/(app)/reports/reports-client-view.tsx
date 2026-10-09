"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Banknote, ChevronDown, ChevronRight, Lock, Package, PackagePlus, TrendingDown, TrendingUp } from "lucide-react"
import type { OpeningReport } from "@/app/actions/opening-stock"
import { formatCurrency, formatDate, money } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { ReportsStatement } from "@/components/reports-statement"
import { ReportsPdfButton } from "@/components/reports-pdf-button"
import { PrintButton } from "@/components/print-button"
import { ExportCsv } from "@/components/export-csv"
import { DrilldownModal } from "@/components/drilldown-modal"
import { TableDownload } from "@/components/table-download"
import {
  ShopTag,
  StatCard,
  StatGrid,
  TableEmpty,
  TableShell,
  TonePill,
  Toolbar,
} from "@/components/shared"
import { TablePager, usePagedRows } from "@/components/table-pager"
import type { ReportsPack } from "@/lib/reports-pack"
import { formatWatLong } from "@/lib/lagos-day"
import { groupOwedHouses, type OwedHouse } from "@/lib/purchase-money"
import { ShopSalesDetail, type ShopSaleLine } from "./shop-sales-detail"

type RawSale = {
  id: string
  invoiceNumber: string
  totalAmount: unknown
  paidAmount: unknown
  /** Refunds and credit notes finished against this invoice. */
  returned?: number
  saleDate: Date
  customer: { name: string } | null
  branch: { name: string; code: string }
}

type RawExpense = {
  id: string
  expenseNumber: string
  category: string
  amount: unknown
  description: string
  date: Date
  branch: { name: string; code: string }
}

type RawInventory = {
  id: string
  quantity: number
  product: { name: string; costPrice: unknown; sellingPrice: unknown }
  branch: { name: string; code: string }
}

type RawSwap = {
  id: string
  swapNumber: string
  /** COMPLETED counts in the totals; PENDING or APPROVED are listed as not finished. */
  status?: string
  tradeValue: unknown
  balanceAmount: unknown
  newProductPrice: unknown
  createdAt: Date
  customer: { name: string } | null
  newProduct: { name: string } | null
  branch: { name: string; code: string }
}

type RawReturn = {
  id: string
  returnNumber: string
  reason: string
  outcome: string
  faultClass: string
  status: string
  refundAmount: unknown
  createdAt: Date
  customer: { name: string } | null
  branch: { name: string; code: string }
  imei?: { imei1: string; product: { name: string } } | null
}

type BranchOption = { id: string; name: string; code: string }

type Drilldown =
  | "REVENUE"
  | "RECEIVED"
  | "EXPENSES"
  | "STOCK"
  | "OPENING"
  | "BOUGHT"
  | "DEBTORS"
  | "CREDITORS"
  | "SWAPS"
  | "RETURNS"

const DRILLDOWN_TITLE: Record<Drilldown, string> = {
  REVENUE: "Sales",
  RECEIVED: "Payments received",
  EXPENSES: "Shop expenses",
  STOCK: "Shop stock value",
  OPENING: "Opening stock value",
  BOUGHT: "Goods from supplier",
  DEBTORS: "Customers who still owe us",
  CREDITORS: "Still owed to suppliers",
  SWAPS: "Swap Deal records",
  RETURNS: "Returns",
}

const day = (value: Date | string) => new Date(value).toISOString().slice(0, 10)

/** Still owed on one invoice, after what returns already cleared on it. */
function saleStillOwed(sale: { totalAmount: unknown; paidAmount: unknown; returned?: number }) {
  return Math.max(0, money(sale.totalAmount) - money(sale.paidAmount) - (sale.returned ?? 0))
}

export function ReportsClientView({
  pack,
  sales,
  expenses,
  inventory,
  swaps = [],
  returns = [],
  shopLines = [],
  opening,
  branches,
  selectedBranchId,
  range = "month",
  date,
}: {
  pack: ReportsPack
  sales: RawSale[]
  expenses: RawExpense[]
  inventory: RawInventory[]
  swaps?: RawSwap[]
  returns?: RawReturn[]
  /** Every item sold in the period, for the list behind each line of Sales by shop. */
  shopLines?: ShopSaleLine[]
  opening: OpeningReport
  branches: BranchOption[]
  selectedBranchId?: string
  range?: "day" | "week" | "month"
  date: string
}) {
  const router = useRouter()
  const [drilldown, setDrilldown] = useState<Drilldown | null>(null)
  const [openHouse, setOpenHouse] = useState<string | null>(null)
  // A shop on Sales by shop, or "ALL" for its total line, opened to every sale behind it.
  const [openShop, setOpenShop] = useState<string | null>(null)
  const paidSales = sales.filter((sale) => money(sale.paidAmount) > 0)
  const supplierOwed = pack.creditors.reduce((sum, row) => sum + row.owed, 0)
  const supplierCredit = (pack.supplierCredits ?? []).reduce((sum, row) => sum + row.owed, 0)
  const owedHouses = useMemo(() => groupOwedHouses(pack.creditors), [pack.creditors])
  const creditHouses = useMemo(() => groupOwedHouses(pack.supplierCredits ?? []), [pack.supplierCredits])
  const scopeKey = `${selectedBranchId ?? "all"}:${range}:${date}`
  function reportsHref(next: { branchId?: string; range?: string; date?: string }) {
    const params = new URLSearchParams()
    const shop = next.branchId !== undefined ? next.branchId : selectedBranchId
    if (shop) params.set("branchId", shop)
    params.set("range", next.range ?? range)
    params.set("date", next.date ?? date)
    return `/reports?${params.toString()}`
  }
  const movement = (now: number, then: number) => {
    const change = now - then
    if (then === 0) return change === 0 ? "Same as last period" : "No last-period figure to compare"
    const percent = Math.round((change / then) * 100)
    if (change === 0) return "Same as last period"
    return `${change > 0 ? "Up" : "Down"} ${formatCurrency(Math.abs(change))} (${Math.abs(percent)} percent)`
  }
  // Cost is for the profit roles. Everyone else sees stock valued at sell price, and
  // their data arrives with every cost set to 0.
  const showCost = pack.stockBasis === "cost"
  const valueWord = showCost ? "Value at cost" : "Value at sell price"
  const openingValue = showCost
    ? opening.shops.reduce((sum, row) => sum + row.value, 0)
    : opening.lines.reduce((sum, line) => sum + line.openingQty * line.sellingPrice, 0)
  const boughtValue = opening.boughtSince.reduce((sum, row) => sum + row.total, 0)
  const stillOpen = opening.shops.filter((row) => row.status === "OPEN")
  const [moreOpen, setMoreOpen] = useState(false)
  // Things under More figures that want a look: unfinished swaps and returns,
  // opening stock still being counted.
  const moreAttention =
    (pack.waiting.swaps > 0 ? 1 : 0) + (pack.waiting.returns > 0 ? 1 : 0) + (stillOpen.length > 0 ? 1 : 0)
  const fileScope = `${pack.statementRef}`

  const byShopPager = usePagedRows(pack.byShop, scopeKey)
  const byShopTotal = useMemo(
    () =>
      pack.byShop.reduce(
        (sum, row) => ({
          tickets: sum.tickets + row.tickets,
          revenue: sum.revenue + row.revenue,
          cost: sum.cost + row.cost,
          collected: sum.collected + row.collected,
        }),
        { tickets: 0, revenue: 0, cost: 0, collected: 0 }
      ),
    [pack.byShop]
  )
  const debtorsPager = usePagedRows(pack.debtors, scopeKey)
  const creditorsPager = usePagedRows(owedHouses, scopeKey)
  const creditsPager = usePagedRows(creditHouses, `${scopeKey}-credits`)
  const lowStockPager = usePagedRows(pack.lowStock, scopeKey)
  const revenuePager = usePagedRows(sales, drilldown === "REVENUE" ? "REVENUE" : "idle")
  const receivedPager = usePagedRows(paidSales, drilldown === "RECEIVED" ? "RECEIVED" : "idle")
  const expensesPager = usePagedRows(expenses, drilldown === "EXPENSES" ? "EXPENSES" : "idle")
  const stockPager = usePagedRows(inventory, drilldown === "STOCK" ? "STOCK" : "idle")
  const openingPager = usePagedRows(opening.lines, drilldown === "OPENING" ? "OPENING" : "idle")
  const boughtPager = usePagedRows(opening.boughtSince, drilldown === "BOUGHT" ? "BOUGHT" : "idle")
  const debtorsDrillPager = usePagedRows(pack.debtors, drilldown === "DEBTORS" ? "DEBTORS" : "idle")
  const creditorsDrillPager = usePagedRows(owedHouses, drilldown === "CREDITORS" ? "CREDITORS" : "idle")
  const swapsPager = usePagedRows(swaps, drilldown === "SWAPS" ? "SWAPS" : "idle")
  const returnsPager = usePagedRows(returns, drilldown === "RETURNS" ? "RETURNS" : "idle")

  /*
    "As much as it is clickable, let it be downloadable also ... the details
    thereat should be downloadable or exportable to an Excel file." Each figure's
    rows, every one of them, not only the page on screen.
  */
  const drillRows: Record<Drilldown, () => Array<Array<string | number>>> = {
    REVENUE: () => [
      ["Invoice", "Customer", "Shop", "Date", "Invoice total", "Paid", "Still owed"],
      ...sales.map((sale) => [
        sale.invoiceNumber,
        sale.customer?.name ?? "Walk-in",
        sale.branch.code,
        day(sale.saleDate),
        money(sale.totalAmount),
        money(sale.paidAmount),
        saleStillOwed(sale),
      ]),
      [],
      ["Total", "", "", "", pack.totals.revenue],
    ],
    RECEIVED: () => [
      ["Invoice", "Customer", "Shop", "Date", "Amount received"],
      ...paidSales.map((sale) => [
        sale.invoiceNumber,
        sale.customer?.name ?? "Walk-in",
        sale.branch.code,
        day(sale.saleDate),
        money(sale.paidAmount),
      ]),
      [],
      ["Total", "", "", "", pack.totals.collected],
    ],
    EXPENSES: () => [
      ["Bill number", "Category", "What it was for", "Shop", "Date", "Amount"],
      ...expenses.map((expense) => [
        expense.expenseNumber,
        expense.category.replace(/_/g, " ").toLowerCase(),
        expense.description,
        expense.branch.code,
        day(expense.date),
        money(expense.amount),
      ]),
      [],
      ["Total", "", "", "", "", pack.totals.expenses],
    ],
    STOCK: () => [
      ["Item", "Shop", "Quantity", ...(showCost ? ["Cost price"] : []), "Selling price", valueWord],
      ...inventory.map((row) => [
        row.product.name,
        row.branch.code,
        row.quantity,
        ...(showCost ? [money(row.product.costPrice)] : []),
        money(row.product.sellingPrice),
        row.quantity * money(showCost ? row.product.costPrice : row.product.sellingPrice),
      ]),
      [],
      ["Total", "", "", ...(showCost ? [""] : []), "", pack.totals.stock],
    ],
    OPENING: () => [
      [
        "Shop",
        "Opening stock",
        "Item code",
        "Item",
        "Brand",
        "Category",
        "Tracking",
        "Quantity",
        ...(showCost ? ["Unit cost"] : []),
        "Lowest selling price",
        "Standard selling price",
        valueWord,
        "IMEIs / serials",
      ],
      ...opening.lines.map((line) => [
        line.shop,
        line.status === "CLOSED" ? "Closed" : "Open",
        line.sku,
        line.name,
        line.brand,
        line.category,
        line.tracking === "NONE" ? "Pieces" : line.tracking,
        line.openingQty,
        ...(showCost ? [line.costPrice] : []),
        line.minimumPrice,
        line.sellingPrice,
        line.openingQty * (showCost ? line.costPrice : line.sellingPrice),
        line.identities.join(", "),
      ]),
      [],
      ["Total", "", "", "", "", "", "", "", ...(showCost ? [""] : []), "", "", openingValue],
    ],
    BOUGHT: () => [
      ["Bill", "Supplier", "Shop", "Date", "Bill value", "Paid", "Still owed"],
      ...opening.boughtSince.map((bill) => [bill.invoiceNumber, bill.supplier, bill.shop, day(bill.date), bill.total, bill.paid, bill.owed]),
      [],
      ["Total", "", "", "", boughtValue],
    ],
    DEBTORS: () => [
      ["Customer", "Shop", "Amount Owed (NGN)"],
      ...pack.debtors.map((row) => [row.name, row.shop, row.amount]),
      [],
      ["Total still owed by customers", "", pack.totals.owing],
    ],
    CREDITORS: () => [
      ["Bill / Invoice", "Supplier", "Shop", "Amount Owed (NGN)"],
      ...pack.creditors.map((row) => [row.invoice, row.supplier, row.shop, row.owed]),
      [],
      ["Total still owed to suppliers", "", "", supplierOwed],
    ],
    SWAPS: () => [
      ["Swap Number", "Customer", "Shop", "Item Swapped For", "Swap Deal Value", "Balance Paid", "Date", "Status"],
      ...swaps.map((row) => [
        row.swapNumber,
        row.customer?.name ?? "Customer",
        row.branch.code,
        row.newProduct?.name ?? "Phone",
        money(row.tradeValue),
        money(row.balanceAmount),
        day(row.createdAt),
        row.status === "COMPLETED" ? "Finished" : "Not finished",
      ]),
      [],
      ["Total, finished swaps", "", "", "", pack.totals.swaps, pack.totals.swapBalance, "", ""],
    ],
    RETURNS: () => [
      ["Return Number", "Customer", "Shop", "Item / IMEI", "Reason", "Outcome", "Status", "Refund Amount", "Date"],
      ...returns.map((row) => [
        row.returnNumber,
        row.customer?.name ?? "Customer",
        row.branch.code,
        row.imei ? `${row.imei.product.name} (${row.imei.imei1})` : "Item",
        row.reason.replace(/_/g, " "),
        row.outcome.replace(/_/g, " "),
        row.status,
        money(row.refundAmount),
        day(row.createdAt),
      ]),
      [],
      ["Sales returns (refunds and credit notes finished in this period)", "", "", "", "", "", "", pack.totals.salesReturns, ""],
      ["Returns logged in this period", "", "", "", "", "", "", pack.totals.returns, ""],
    ],
  }

  return (
    <div className="space-y-5">
      <div className="reports-chrome space-y-5 print:hidden">
        {/*
          The client asked not to have every branch summed into one figure with no
          way back out: "there's a higher tendency we are using Paul to rob
          Barnabas". One shop at a time is a first-class choice here, and All is
          something you pick rather than something you are given.
        */}
        {/* On a phone the controls sit in a tight grid (shop across the top,
            period and date side by side) and the actions scroll in one row, so
            the headline figures are not pushed off the first screen. */}
        <Toolbar className="justify-between">
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
            <label className="col-span-2 flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
              <span className="eyebrow">Reporting on</span>
              <Select
                value={selectedBranchId ?? ""}
                onChange={(event) => {
                  router.push(reportsHref({ branchId: event.target.value }))
                }}
                className="h-9 w-full sm:w-56"
              >
                <option value="">All shops together</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name} ({branch.code})
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
              <span className="eyebrow">Period</span>
              <Select
                value={range}
                onChange={(event) => router.push(reportsHref({ range: event.target.value }))}
                className="h-9 w-full sm:w-40"
              >
                <option value="day">One day</option>
                <option value="week">Last 7 days</option>
                <option value="month">This month so far</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
              <span className="eyebrow">Ending on</span>
              <input
                type="date"
                value={date}
                onChange={(event) => router.push(reportsHref({ date: event.target.value }))}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm sm:w-auto"
              />
            </label>
            <span className="hidden sm:inline-flex">
              <TonePill tone={selectedBranchId ? "primary" : "neutral"}>{pack.scope}</TonePill>
            </span>
            <span className="col-span-2 justify-self-start">
              <TonePill tone="neutral">{pack.periodLabel}</TonePill>
            </span>
          </div>

          <div className="-mx-1 flex w-full items-center gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&>*]:shrink-0">
            <Button asChild variant="ghost" size="sm">
              <Link href="/audit/books">Check the books</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/finance">Money in &amp; out</Link>
            </Button>
            <ReportsPdfButton data={pack} />
            <PrintButton label="Print / Save PDF" />
            <ExportCsv
              filename={`${pack.statementRef}.csv`}
              label="Export sales CSV"
              rows={[
                ["Invoice", "Customer", "Shop", "Total", "Paid", "Still owed", "Date"],
                ...sales.map((sale) => [
                  sale.invoiceNumber,
                  sale.customer?.name ?? "Walk-in",
                  sale.branch.code,
                  String(money(sale.totalAmount)),
                  String(money(sale.paidAmount)),
                  String(saleStillOwed(sale)),
                  new Date(sale.saleDate).toISOString().slice(0, 10),
                ]),
              ]}
            />
          </div>
        </Toolbar>

        {/* One lead figure and the four that explain it. Everything else is one
            tap away under More figures, which says when something in it needs
            attention so nothing is hidden by the fold. */}
        <StatGrid className="xl:grid-cols-5">
          <StatCard
            lead
            className="col-span-2 xl:col-span-1"
            label="Total sales"
            value={formatCurrency(pack.totals.revenue)}
            hint={
              pack.totals.salesReturns > 0
                ? `${sales.length} sale${sales.length === 1 ? "" : "s"} · ${formatCurrency(pack.totals.revenue - pack.totals.salesReturns)} after returns`
                : `${sales.length} sale${sales.length === 1 ? "" : "s"}`
            }
            icon={<TrendingUp className="h-4 w-4" />}
            onClick={() => setDrilldown("REVENUE")}
          />
          <StatCard
            label="Total payments received"
            value={formatCurrency(pack.totals.collected)}
            hint={
              pack.receipts.debtsCollected > 0
                ? `${formatCurrency(pack.receipts.onPeriodSales)} on this period's sales + ${formatCurrency(pack.receipts.debtsCollected)} debts collected on earlier sales`
                : "Money that came in during this period"
            }
            icon={<Banknote className="h-4 w-4" />}
            tone="success"
            onClick={() => setDrilldown("RECEIVED")}
          />
          <StatCard
            label="Customers still owe, in total"
            value={formatCurrency(pack.totals.owing)}
            hint={`${pack.debtors.length} customer${pack.debtors.length === 1 ? "" : "s"} · everything owed today, whatever the period. ${formatCurrency(pack.waiting.periodDue)} of it is still unpaid on this period's sales.`}
            tone="warning"
            onClick={() => setDrilldown("DEBTORS")}
          />
          <StatCard
            label="Still owed to suppliers"
            value={formatCurrency(supplierOwed)}
            hint={`${owedHouses.length} house${owedHouses.length === 1 ? "" : "s"}`}
            onClick={() => setDrilldown("CREDITORS")}
          />
          <StatCard
            label={showCost ? "Stock at cost" : "Stock at sell price"}
            value={formatCurrency(pack.totals.stock)}
            hint={`${inventory.length} unit${inventory.length === 1 ? "" : "s"}`}
            icon={<Package className="h-4 w-4" />}
            onClick={() => setDrilldown("STOCK")}
          />
        </StatGrid>

        {/* The comparison reads after the headline figures, not before them. */}
        <div className="surface-card grid gap-3 p-4 md:grid-cols-3">
          <div>
            <p className="eyebrow">This period</p>
            <p className="mt-1 text-sm font-semibold">{pack.periodLabel}</p>
            <p className="mt-1 text-sm text-muted-foreground">Sales {formatCurrency(pack.totals.revenue)}</p>
          </div>
          <div>
            <p className="eyebrow">Compared with</p>
            <p className="mt-1 text-sm font-semibold">
              {pack.range === "day" ? formatWatLong(pack.compare.from) : `${formatWatLong(pack.compare.from)} to ${formatWatLong(pack.compare.to)}`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">Sales {formatCurrency(pack.compare.revenue)}</p>
          </div>
          <div>
            <p className="eyebrow">Movement</p>
            <p className="mt-1 text-sm font-semibold">{movement(pack.totals.revenue, pack.compare.revenue)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Payments received {movement(pack.totals.collected, pack.compare.collected)}. Expenses {movement(pack.totals.expenses, pack.compare.expenses)}.
            </p>
          </div>
        </div>

        <details className="group surface-card overflow-hidden" open={moreOpen} onToggle={(event) => setMoreOpen((event.target as HTMLDetailsElement).open)}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold transition-colors duration-press ease-standard hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
            <span>
              More figures
              <span className="ml-2 font-normal text-muted-foreground">expenses, opening stock, swaps, returns</span>
            </span>
            <span className="flex items-center gap-2">
              {moreAttention > 0 ? <TonePill tone="warning">{moreAttention} need{moreAttention === 1 ? "s" : ""} attention</TonePill> : null}
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-small ease-standard group-open:rotate-180" />
            </span>
          </summary>
          <div className="motion-rise border-t border-border p-3 sm:p-4">
            <StatGrid className="xl:grid-cols-3">
              <StatCard
                label="Approved expenses"
                value={formatCurrency(pack.totals.expenses)}
                hint={`${expenses.length} expense${expenses.length === 1 ? "" : "s"}`}
                icon={<TrendingDown className="h-4 w-4" />}
                tone="danger"
                onClick={() => setDrilldown("EXPENSES")}
              />
              <StatCard
                label={showCost ? "Opening stock" : "Opening stock at sell price"}
                value={formatCurrency(openingValue)}
                hint={
                  opening.shops.length === 0
                    ? "No shop has loaded opening stock yet"
                    : stillOpen.length
                      ? `Still being counted: ${stillOpen.map((row) => row.shop).join(", ")}. Not final yet.`
                      : `Closed for ${opening.shops.map((row) => row.shop).join(", ")}`
                }
                icon={<Lock className="h-4 w-4" />}
                tone={stillOpen.length ? "warning" : "success"}
                onClick={() => setDrilldown("OPENING")}
              />
              <StatCard
                label="Bought after opening"
                value={formatCurrency(boughtValue)}
                hint={`${opening.boughtSince.length} supplier bill${opening.boughtSince.length === 1 ? "" : "s"}`}
                icon={<PackagePlus className="h-4 w-4" />}
                onClick={() => setDrilldown("BOUGHT")}
              />
              <StatCard
                label="They owe us"
                value={formatCurrency(supplierCredit)}
                hint={supplierCredit > 0 ? "After send-backs" : undefined}
              />
              <StatCard
                label="Swap Deal value"
                value={formatCurrency(pack.totals.swaps)}
                hint={
                  pack.waiting.swaps > 0
                    ? `Trade-in value of swaps finished in this period (${formatCurrency(pack.totals.swapBalance)} paid on top). Plus ${pack.waiting.swaps} swap${pack.waiting.swaps === 1 ? "" : "s"} not finished yet, ${formatCurrency(pack.waiting.swapBalance)} balance not recorded. Finish them on Swap Deal.`
                    : `Trade-in value of swaps finished in this period · ${formatCurrency(pack.totals.swapBalance)} paid on top.`
                }
                tone={pack.waiting.swaps > 0 ? "warning" : undefined}
                onClick={() => setDrilldown("SWAPS")}
              />
              <StatCard
                label="Sales returns"
                value={formatCurrency(pack.totals.salesReturns)}
                hint={
                  pack.waiting.returns > 0
                    ? `Refunds and credit notes finished in this period. Plus ${formatCurrency(pack.waiting.returnValue)} on ${pack.waiting.returns} not finished yet. ${pack.totals.returns} logged in this period.`
                    : `Refunds and credit notes finished in this period · ${pack.totals.returns} logged`
                }
                tone={pack.waiting.returns > 0 ? "warning" : undefined}
                onClick={() => setDrilldown("RETURNS")}
              />
            </StatGrid>
          </div>
        </details>

        <div className="grid gap-4 xl:grid-cols-2">
          <TableShell
            caption={
              <>
                <div>
                  <h2 className="text-sm font-semibold tracking-tight">Sales by shop</h2>
                  <p className="text-xs text-muted-foreground">Tap a shop to see every sale behind its figures.</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {pack.byShop.length} branch location{pack.byShop.length === 1 ? "" : "s"}
                  </span>
                  <TableDownload
                    filename={`${fileScope}-branch-breakdown`}
                    rows={() => [
                      ["Branch", "Sales Volume", "Total Sales", ...(showCost ? ["Total Cost", "Gross Profit"] : []), "Payments Received"],
                      ...pack.byShop.map((row) => [
                        row.name,
                        row.tickets,
                        row.revenue,
                        ...(showCost ? [row.cost, row.revenue - row.cost] : []),
                        row.collected,
                      ]),
                      [],
                      [
                        "All shops",
                        byShopTotal.tickets,
                        byShopTotal.revenue,
                        ...(showCost ? [byShopTotal.cost, byShopTotal.revenue - byShopTotal.cost] : []),
                        byShopTotal.collected,
                      ],
                    ]}
                  />
                </div>
              </>
            }
            columns={[
              { label: "Branch" },
              { label: "Sales Volume", align: "right" },
              { label: "Total Sales", align: "right" },
              ...(showCost ? [{ label: "Total Cost", align: "right" as const }] : []),
              { label: "Payments Received", align: "right" },
            ]}
            footer={
              <TablePager
                page={byShopPager.page}
                pageCount={byShopPager.pageCount}
                pageSize={byShopPager.pageSize}
                total={byShopPager.total}
                start={byShopPager.start}
                end={byShopPager.end}
                onPageChange={byShopPager.setPage}
                onPageSizeChange={byShopPager.setPageSize}
                noun="shops"
              />
            }
          >
            {byShopPager.pageRows.map((row) => (
              <tr
                key={row.id}
                tabIndex={0}
                role="button"
                aria-label={`See every sale at ${row.name}`}
                onClick={() => setOpenShop(row.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    setOpenShop(row.id)
                  }
                }}
                className="group cursor-pointer transition-colors hover:bg-primary/5 focus-visible:bg-primary/5 focus-visible:outline-none"
              >
                <td>
                  <span className="inline-flex items-center gap-1 font-medium text-primary group-hover:underline">
                    {row.name}
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </td>
                <td className="text-right num">{row.tickets}</td>
                <td className="text-right num">{formatCurrency(row.revenue)}</td>
                {showCost ? <td className="text-right num">{formatCurrency(row.cost)}</td> : null}
                <td className="text-right num font-semibold text-success">{formatCurrency(row.collected)}</td>
              </tr>
            ))}
            {pack.byShop.length > 1 ? (
              <tr
                tabIndex={0}
                role="button"
                aria-label="See every sale at every shop"
                onClick={() => setOpenShop("ALL")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    setOpenShop("ALL")
                  }
                }}
                className="group cursor-pointer border-t-2 border-border bg-muted/40 font-semibold transition-colors hover:bg-primary/5 focus-visible:bg-primary/5 focus-visible:outline-none"
              >
                <td>
                  <span className="inline-flex items-center gap-1 text-primary group-hover:underline">
                    All shops
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </span>
                </td>
                <td className="text-right num">{byShopTotal.tickets}</td>
                <td className="text-right num">{formatCurrency(byShopTotal.revenue)}</td>
                {showCost ? <td className="text-right num">{formatCurrency(byShopTotal.cost)}</td> : null}
                <td className="text-right num text-success">{formatCurrency(byShopTotal.collected)}</td>
              </tr>
            ) : null}
            {pack.byShop.length === 0 ? (
              <TableEmpty colSpan={showCost ? 5 : 4}>This shop made no sale in this time.</TableEmpty>
            ) : null}
          </TableShell>

          <TableShell
            caption={
              <>
                <h2 className="text-sm font-semibold tracking-tight">Customers who still owe us</h2>
                <div className="flex items-center gap-2">
                  <TableDownload
                    filename={`${fileScope}-customers-still-owe`}
                    rows={() => [["Customer", "Shop", "Still owed"], ...pack.debtors.map((row) => [row.name, row.shop, row.amount])]}
                  />
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/customers">All customers</Link>
                  </Button>
                </div>
              </>
            }
            columns={[{ label: "Customer" }, { label: "Shop" }, { label: "Still owed", align: "right" }]}
            footer={
              <TablePager
                page={debtorsPager.page}
                pageCount={debtorsPager.pageCount}
                pageSize={debtorsPager.pageSize}
                total={debtorsPager.total}
                start={debtorsPager.start}
                end={debtorsPager.end}
                onPageChange={debtorsPager.setPage}
                onPageSizeChange={debtorsPager.setPageSize}
                noun="customers"
              />
            }
          >
            {debtorsPager.pageRows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/customers/${row.id}`} className="font-medium text-primary hover:underline">
                    {row.name}
                  </Link>
                </td>
                <td>
                  <ShopTag>{row.shop}</ShopTag>
                </td>
                <td className="text-right num font-semibold text-warning">{formatCurrency(row.amount)}</td>
              </tr>
            ))}
            {pack.debtors.length === 0 ? (
              <TableEmpty colSpan={3}>No customer owes anything right now.</TableEmpty>
            ) : null}
          </TableShell>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <TableShell
            caption={
              <>
                <h2 className="text-sm font-semibold tracking-tight">Still owed to suppliers</h2>
                <div className="flex items-center gap-2">
                  <TableDownload
                    filename={`${fileScope}-supplier-bills-unpaid`}
                    rows={() => [
                      ["Bill", "Supplier", "Shop", "Still owed"],
                      ...pack.creditors.map((row) => [row.invoice, row.supplier, row.shop, row.owed]),
                    ]}
                  />
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/suppliers">All suppliers</Link>
                  </Button>
                </div>
              </>
            }
            columns={[{ label: "Supplier" }, { label: "Still owed", align: "right" }]}
            footer={
              <TablePager
                page={creditorsPager.page}
                pageCount={creditorsPager.pageCount}
                pageSize={creditorsPager.pageSize}
                total={creditorsPager.total}
                start={creditorsPager.start}
                end={creditorsPager.end}
                onPageChange={creditorsPager.setPage}
                onPageSizeChange={creditorsPager.setPageSize}
                noun="houses"
              />
            }
          >
            {creditorsPager.pageRows.map((house) => {
              const expanded = openHouse === house.key
              return (
                <OwedHouseRows
                  key={house.key}
                  house={house}
                  expanded={expanded}
                  colSpan={2}
                  onToggle={() => setOpenHouse(expanded ? null : house.key)}
                />
              )
            })}
            {pack.creditors.length === 0 ? (
              <TableEmpty colSpan={2}>We have paid every supplier bill.</TableEmpty>
            ) : null}
          </TableShell>

          <TableShell
            caption={
              <>
                <h2 className="text-sm font-semibold tracking-tight">Suppliers who owe us</h2>
                <div className="flex items-center gap-2">
                  <TableDownload
                    filename={`${fileScope}-suppliers-who-owe-us`}
                    rows={() => [
                      ["Bill", "Supplier", "Shop", "They owe us"],
                      ...(pack.supplierCredits ?? []).map((row) => [row.invoice, row.supplier, row.shop, row.owed]),
                    ]}
                  />
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/suppliers">All suppliers</Link>
                  </Button>
                </div>
              </>
            }
            columns={[{ label: "Supplier" }, { label: "They owe us", align: "right" }]}
            footer={
              <TablePager
                page={creditsPager.page}
                pageCount={creditsPager.pageCount}
                pageSize={creditsPager.pageSize}
                total={creditsPager.total}
                start={creditsPager.start}
                end={creditsPager.end}
                onPageChange={creditsPager.setPage}
                onPageSizeChange={creditsPager.setPageSize}
                noun="houses"
              />
            }
          >
            {creditsPager.pageRows.map((house) => {
              const expanded = openHouse === `credit-${house.key}`
              return (
                <OwedHouseRows
                  key={house.key}
                  house={house}
                  expanded={expanded}
                  colSpan={2}
                  onToggle={() => setOpenHouse(expanded ? null : `credit-${house.key}`)}
                />
              )
            })}
            {(pack.supplierCredits ?? []).length === 0 ? (
              <TableEmpty colSpan={2}>No supplier owes us after send-backs.</TableEmpty>
            ) : null}
          </TableShell>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <TableShell
            caption={
              <>
                <h2 className="text-sm font-semibold tracking-tight">Running low</h2>
                <div className="flex items-center gap-2">
                  <TableDownload
                    filename={`${fileScope}-running-low`}
                    rows={() => [
                      ["Item", "Shop", "Left", "Minimum"],
                      ...pack.lowStock.map((row) => [row.product, row.shop, row.quantity, row.min]),
                    ]}
                  />
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/inventory">Shop stock</Link>
                  </Button>
                </div>
              </>
            }
            columns={[{ label: "Item" }, { label: "Shop" }, { label: "Left", align: "right" }]}
            footer={
              <TablePager
                page={lowStockPager.page}
                pageCount={lowStockPager.pageCount}
                pageSize={lowStockPager.pageSize}
                total={lowStockPager.total}
                start={lowStockPager.start}
                end={lowStockPager.end}
                onPageChange={lowStockPager.setPage}
                onPageSizeChange={lowStockPager.setPageSize}
                noun="stock lines"
              />
            }
          >
            {lowStockPager.pageRows.map((row) => (
              <tr key={row.id}>
                <td className="font-medium">{row.product}</td>
                <td>
                  <ShopTag>{row.shop}</ShopTag>
                </td>
                <td className="text-right">
                  <TonePill tone="danger">
                    {row.quantity} left · min {row.min}
                  </TonePill>
                </td>
              </tr>
            ))}
            {pack.lowStock.length === 0 ? (
              <TableEmpty colSpan={3}>No item is running low.</TableEmpty>
            ) : null}
          </TableShell>
        </div>
      </div>

      <ShopSalesDetail
        shopId={openShop}
        onClose={() => setOpenShop(null)}
        byShop={pack.byShop}
        lines={shopLines}
        showCost={showCost}
        scope={pack.scope}
        periodLabel={pack.periodLabel}
        fileScope={fileScope}
      />

      <DrilldownModal
        open={drilldown !== null}
        onClose={() => setDrilldown(null)}
        eyebrow={pack.scope}
        title={drilldown ? DRILLDOWN_TITLE[drilldown] : ""}
        download={
          drilldown
            ? { filename: `${fileScope}-${drilldown.toLowerCase()}`, rows: drillRows[drilldown] }
            : undefined
        }
        summary={
          drilldown === "REVENUE" ? (
            <>
              <span>{sales.length} invoices</span>
              <span className="font-semibold text-foreground">{formatCurrency(pack.totals.revenue)}</span>
            </>
          ) : drilldown === "RECEIVED" ? (
            <>
              <span>{paidSales.length} invoices with money against them</span>
              <span className="font-semibold text-foreground">{formatCurrency(pack.totals.collected)}</span>
            </>
          ) : drilldown === "EXPENSES" ? (
            <>
              <span>{expenses.length} shop bill{expenses.length === 1 ? "" : "s"}</span>
              <span className="font-semibold text-foreground">{formatCurrency(pack.totals.expenses)}</span>
            </>
          ) : drilldown === "OPENING" ? (
            <>
              <span>
                {opening.lines.length} item lines ·{" "}
                <Link href="/opening-stock" className="text-primary hover:underline">
                  Correct &amp; close opening stock
                </Link>
              </span>
              <span className="font-semibold text-foreground">{formatCurrency(openingValue)}</span>
            </>
          ) : drilldown === "BOUGHT" ? (
            <>
              <span>{opening.boughtSince.length} supplier bills</span>
              <span className="font-semibold text-foreground">{formatCurrency(boughtValue)}</span>
            </>
          ) : drilldown === "DEBTORS" ? (
            <>
              <span>
                {pack.debtors.length} customers with outstanding balances ·{" "}
                <Link href="/customers" className="text-primary hover:underline">
                  Customer accounts
                </Link>
              </span>
              <span className="font-semibold text-foreground">{formatCurrency(pack.totals.owing)}</span>
            </>
          ) : drilldown === "CREDITORS" ? (
            <>
              <span>
                {owedHouses.length} supplier house{owedHouses.length === 1 ? "" : "s"} still owed ·{" "}
                <Link href="/suppliers" className="text-primary hover:underline">
                  Supplier accounts
                </Link>
              </span>
              <span className="font-semibold text-foreground">{formatCurrency(supplierOwed)}</span>
            </>
          ) : drilldown === "SWAPS" ? (
            <>
              <span>
                {swaps.length} device swap transactions ·{" "}
                <Link href="/swaps" className="text-primary hover:underline">
                  Device swaps
                </Link>
              </span>
              <span className="font-semibold text-foreground">{formatCurrency(pack.totals.swaps)}</span>
            </>
          ) : drilldown === "RETURNS" ? (
            <>
              <span>
                {returns.length} customer returns ·{" "}
                <Link href="/returns" className="text-primary hover:underline">
                  Returns
                </Link>
              </span>
              <span className="font-semibold text-foreground">{returns.length} return records</span>
            </>
          ) : (
            <>
              <span>{inventory.length} stock lines</span>
              <span className="font-semibold text-foreground">{formatCurrency(pack.totals.stock)}</span>
            </>
          )
        }
      >
        {drilldown === "REVENUE" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Shop</th>
                  <th>Date</th>
                  <th className="text-right">Invoice total</th>
                  <th className="text-right">Paid</th>
                  <th className="text-right">Still owed</th>
                </tr>
              </thead>
              <tbody>
                {revenuePager.pageRows.map((sale) => (
                  <tr key={sale.id}>
                    <td>
                      <Link href={`/sales/${sale.id}`} className="font-medium text-primary hover:underline">
                        {sale.invoiceNumber}
                      </Link>
                    </td>
                    <td>{sale.customer?.name ?? "Walk-in"}</td>
                    <td>
                      <ShopTag>{sale.branch.code}</ShopTag>
                    </td>
                    <td className="text-muted-foreground">{formatDate(sale.saleDate)}</td>
                    <td className="text-right num font-semibold">{formatCurrency(money(sale.totalAmount))}</td>
                    <td className="text-right num text-success">{formatCurrency(money(sale.paidAmount))}</td>
                    <td className="text-right num text-warning">
                      {formatCurrency(saleStillOwed(sale))}
                    </td>
                  </tr>
                ))}
                {sales.length === 0 ? <TableEmpty colSpan={7}>No sale in this time.</TableEmpty> : null}
              </tbody>
            </table>
            <TablePager
              page={revenuePager.page}
              pageCount={revenuePager.pageCount}
              pageSize={revenuePager.pageSize}
              total={revenuePager.total}
              start={revenuePager.start}
              end={revenuePager.end}
              onPageChange={revenuePager.setPage}
              onPageSizeChange={revenuePager.setPageSize}
              noun="sales"
            />
          </div>
        ) : null}

        {drilldown === "RECEIVED" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Shop</th>
                  <th>Date</th>
                  <th className="text-right">Amount received</th>
                </tr>
              </thead>
              <tbody>
                {receivedPager.pageRows.map((sale) => (
                  <tr key={sale.id}>
                    <td>
                      <Link href={`/sales/${sale.id}`} className="font-medium text-primary hover:underline">
                        {sale.invoiceNumber}
                      </Link>
                    </td>
                    <td>{sale.customer?.name ?? "Walk-in"}</td>
                    <td>
                      <ShopTag>{sale.branch.code}</ShopTag>
                    </td>
                    <td className="text-muted-foreground">{formatDate(sale.saleDate)}</td>
                    <td className="text-right num font-semibold text-success">
                      {formatCurrency(money(sale.paidAmount))}
                    </td>
                  </tr>
                ))}
                {paidSales.length === 0 ? <TableEmpty colSpan={5}>No money was collected in this time.</TableEmpty> : null}
              </tbody>
            </table>
            <TablePager
              page={receivedPager.page}
              pageCount={receivedPager.pageCount}
              pageSize={receivedPager.pageSize}
              total={receivedPager.total}
              start={receivedPager.start}
              end={receivedPager.end}
              onPageChange={receivedPager.setPage}
              onPageSizeChange={receivedPager.setPageSize}
              noun="payments"
            />
          </div>
        ) : null}

        {drilldown === "EXPENSES" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Bill number</th>
                  <th>Category</th>
                  <th>What it was for</th>
                  <th>Shop</th>
                  <th>Date</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {expensesPager.pageRows.map((expense) => (
                  <tr key={expense.id}>
                    <td className="font-medium">{expense.expenseNumber}</td>
                    <td>{expense.category.replace(/_/g, " ").toLowerCase()}</td>
                    <td>{expense.description}</td>
                    <td>
                      <ShopTag>{expense.branch.code}</ShopTag>
                    </td>
                    <td className="text-muted-foreground">{formatDate(expense.date)}</td>
                    <td className="text-right num font-semibold text-danger">{formatCurrency(money(expense.amount))}</td>
                  </tr>
                ))}
                {expenses.length === 0 ? <TableEmpty colSpan={6}>No bill was recorded in this time.</TableEmpty> : null}
              </tbody>
            </table>
            <TablePager
              page={expensesPager.page}
              pageCount={expensesPager.pageCount}
              pageSize={expensesPager.pageSize}
              total={expensesPager.total}
              start={expensesPager.start}
              end={expensesPager.end}
              onPageChange={expensesPager.setPage}
              onPageSizeChange={expensesPager.setPageSize}
              noun="bills"
            />
          </div>
        ) : null}

        {drilldown === "STOCK" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Shop</th>
                  <th className="text-right">Quantity</th>
                  {showCost ? <th className="text-right">Cost price</th> : null}
                  <th className="text-right">Selling price</th>
                  <th className="text-right">{valueWord}</th>
                </tr>
              </thead>
              <tbody>
                {stockPager.pageRows.map((row) => (
                  <tr key={row.id}>
                    <td className="font-medium">{row.product.name}</td>
                    <td>
                      <ShopTag>{row.branch.code}</ShopTag>
                    </td>
                    <td className="text-right num">{row.quantity}</td>
                    {showCost ? <td className="text-right num">{formatCurrency(money(row.product.costPrice))}</td> : null}
                    <td className="text-right num">{formatCurrency(money(row.product.sellingPrice))}</td>
                    <td className="text-right num font-semibold">
                      {formatCurrency(row.quantity * money(showCost ? row.product.costPrice : row.product.sellingPrice))}
                    </td>
                  </tr>
                ))}
                {inventory.length === 0 ? <TableEmpty colSpan={showCost ? 6 : 5}>Nothing is on the shelf here.</TableEmpty> : null}
              </tbody>
            </table>
            <TablePager
              page={stockPager.page}
              pageCount={stockPager.pageCount}
              pageSize={stockPager.pageSize}
              total={stockPager.total}
              start={stockPager.start}
              end={stockPager.end}
              onPageChange={stockPager.setPage}
              onPageSizeChange={stockPager.setPageSize}
              noun="stock lines"
            />
          </div>
        ) : null}

        {drilldown === "OPENING" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Shop</th>
                  <th className="text-right">Quantity</th>
                  {showCost ? <th className="text-right">Unit cost</th> : null}
                  <th className="text-right">Lowest</th>
                  <th className="text-right">Standard</th>
                  <th className="text-right">{valueWord}</th>
                </tr>
              </thead>
              <tbody>
                {openingPager.pageRows.map((line) => (
                  <tr key={`${line.shop}-${line.sku}`}>
                    <td>
                      <p className="font-medium">{line.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{line.sku}</p>
                    </td>
                    <td>
                      <ShopTag>{line.shop}</ShopTag>{" "}
                      <TonePill tone={line.status === "CLOSED" ? "success" : "warning"}>
                        {line.status === "CLOSED" ? "Closed" : "Open"}
                      </TonePill>
                    </td>
                    <td className="text-right num">{line.openingQty}</td>
                    {showCost ? <td className="text-right num">{formatCurrency(line.costPrice)}</td> : null}
                    <td className="text-right num">{formatCurrency(line.minimumPrice)}</td>
                    <td className="text-right num">{formatCurrency(line.sellingPrice)}</td>
                    <td className="text-right num font-semibold">
                      {formatCurrency(line.openingQty * (showCost ? line.costPrice : line.sellingPrice))}
                    </td>
                  </tr>
                ))}
                {opening.lines.length === 0 ? <TableEmpty colSpan={showCost ? 7 : 6}>No opening stock here yet.</TableEmpty> : null}
              </tbody>
            </table>
            <TablePager
              page={openingPager.page}
              pageCount={openingPager.pageCount}
              pageSize={openingPager.pageSize}
              total={openingPager.total}
              start={openingPager.start}
              end={openingPager.end}
              onPageChange={openingPager.setPage}
              onPageSizeChange={openingPager.setPageSize}
              noun="item lines"
            />
          </div>
        ) : null}

        {drilldown === "BOUGHT" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Supplier</th>
                  <th>Shop</th>
                  <th>Date</th>
                  <th className="text-right">Bill value</th>
                  <th className="text-right">Still owed</th>
                </tr>
              </thead>
              <tbody>
                {boughtPager.pageRows.map((bill) => (
                  <tr key={bill.id}>
                    <td>
                      <Link href={`/purchases/${bill.id}`} className="font-medium text-primary hover:underline">
                        {bill.invoiceNumber}
                      </Link>
                    </td>
                    <td>{bill.supplier}</td>
                    <td>
                      <ShopTag>{bill.shop}</ShopTag>
                    </td>
                    <td className="text-muted-foreground">{formatDate(bill.date)}</td>
                    <td className="text-right num font-semibold">{formatCurrency(bill.total)}</td>
                    <td className="text-right num text-warning">{formatCurrency(bill.owed)}</td>
                  </tr>
                ))}
                {opening.boughtSince.length === 0 ? (
                  <TableEmpty colSpan={6}>No supplier bill other than opening stock.</TableEmpty>
                ) : null}
              </tbody>
            </table>
            <TablePager
              page={boughtPager.page}
              pageCount={boughtPager.pageCount}
              pageSize={boughtPager.pageSize}
              total={boughtPager.total}
              start={boughtPager.start}
              end={boughtPager.end}
              onPageChange={boughtPager.setPage}
              onPageSizeChange={boughtPager.setPageSize}
              noun="bills"
            />
          </div>
        ) : null}

        {drilldown === "DEBTORS" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Shop</th>
                  <th className="text-right">Amount Owed</th>
                </tr>
              </thead>
              <tbody>
                {debtorsDrillPager.pageRows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/customers/${row.id}`} className="font-medium text-primary hover:underline">
                        {row.name}
                      </Link>
                    </td>
                    <td>
                      <ShopTag>{row.shop}</ShopTag>
                    </td>
                    <td className="text-right num font-semibold text-warning">{formatCurrency(row.amount)}</td>
                  </tr>
                ))}
                {pack.debtors.length === 0 ? <TableEmpty colSpan={3}>No customer owes money.</TableEmpty> : null}
              </tbody>
            </table>
            <TablePager
              page={debtorsDrillPager.page}
              pageCount={debtorsDrillPager.pageCount}
              pageSize={debtorsDrillPager.pageSize}
              total={debtorsDrillPager.total}
              start={debtorsDrillPager.start}
              end={debtorsDrillPager.end}
              onPageChange={debtorsDrillPager.setPage}
              onPageSizeChange={debtorsDrillPager.setPageSize}
              noun="customers"
            />
          </div>
        ) : null}

        {drilldown === "CREDITORS" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th className="text-right">Still owed</th>
                </tr>
              </thead>
              <tbody>
                {creditorsDrillPager.pageRows.map((house) => {
                  const expanded = openHouse === house.key
                  return (
                    <OwedHouseRows
                      key={house.key}
                      house={house}
                      expanded={expanded}
                      colSpan={2}
                      onToggle={() => setOpenHouse(expanded ? null : house.key)}
                    />
                  )
                })}
                {pack.creditors.length === 0 ? <TableEmpty colSpan={2}>No unpaid supplier bills.</TableEmpty> : null}
              </tbody>
            </table>
            <TablePager
              page={creditorsDrillPager.page}
              pageCount={creditorsDrillPager.pageCount}
              pageSize={creditorsDrillPager.pageSize}
              total={creditorsDrillPager.total}
              start={creditorsDrillPager.start}
              end={creditorsDrillPager.end}
              onPageChange={creditorsDrillPager.setPage}
              onPageSizeChange={creditorsDrillPager.setPageSize}
              noun="houses"
            />
          </div>
        ) : null}

        {drilldown === "SWAPS" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Swap Number</th>
                  <th>Customer</th>
                  <th>Shop</th>
                  <th>New Item</th>
                  <th>Date</th>
                  <th className="text-right">Swap Deal Value</th>
                  <th className="text-right">Balance Paid</th>
                </tr>
              </thead>
              <tbody>
                {swapsPager.pageRows.map((swap) => (
                  <tr key={swap.id}>
                    <td>
                      <Link href="/swaps" className="font-medium text-primary hover:underline">
                        {swap.swapNumber}
                      </Link>
                    </td>
                    <td>{swap.customer?.name ?? "Walk-in"}</td>
                    <td>
                      <ShopTag>{swap.branch.code}</ShopTag>
                    </td>
                    <td>{swap.newProduct?.name ?? "Phone"}</td>
                    <td className="text-muted-foreground">{formatDate(swap.createdAt)}</td>
                    <td className="text-right num">
                      {formatCurrency(money(swap.tradeValue))}
                      {swap.status && swap.status !== "COMPLETED" ? (
                        <span className="ml-1.5 rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">Not finished</span>
                      ) : null}
                    </td>
                    <td className="text-right num font-semibold text-success">{formatCurrency(money(swap.balanceAmount))}</td>
                  </tr>
                ))}
                {swaps.length === 0 ? <TableEmpty colSpan={7}>No swap transactions completed.</TableEmpty> : null}
              </tbody>
            </table>
            <TablePager
              page={swapsPager.page}
              pageCount={swapsPager.pageCount}
              pageSize={swapsPager.pageSize}
              total={swapsPager.total}
              start={swapsPager.start}
              end={swapsPager.end}
              onPageChange={swapsPager.setPage}
              onPageSizeChange={swapsPager.setPageSize}
              noun="swaps"
            />
          </div>
        ) : null}

        {drilldown === "RETURNS" ? (
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Return Number</th>
                  <th>Customer</th>
                  <th>Shop</th>
                  <th>Item / IMEI</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th className="text-right">Refund Amount</th>
                </tr>
              </thead>
              <tbody>
                {returnsPager.pageRows.map((ret) => (
                  <tr key={ret.id}>
                    <td>
                      <Link href="/returns" className="font-medium text-primary hover:underline">
                        {ret.returnNumber}
                      </Link>
                    </td>
                    <td>{ret.customer?.name ?? "Customer"}</td>
                    <td>
                      <ShopTag>{ret.branch.code}</ShopTag>
                    </td>
                    <td>{ret.imei ? `${ret.imei.product.name} (${ret.imei.imei1})` : "Item"}</td>
                    <td>{ret.reason.replace(/_/g, " ")}</td>
                    <td>
                      <TonePill tone={ret.status === "RESOLVED" || ret.status === "COMPLETED" ? "success" : "warning"}>
                        {ret.status}
                      </TonePill>
                    </td>
                    <td className="text-muted-foreground">{formatDate(ret.createdAt)}</td>
                    <td className="text-right num font-semibold text-danger">
                      {money(ret.refundAmount) > 0 ? formatCurrency(money(ret.refundAmount)) : "—"}
                    </td>
                  </tr>
                ))}
                {returns.length === 0 ? <TableEmpty colSpan={8}>No customer return records.</TableEmpty> : null}
              </tbody>
            </table>
            <TablePager
              page={returnsPager.page}
              pageCount={returnsPager.pageCount}
              pageSize={returnsPager.pageSize}
              total={returnsPager.total}
              start={returnsPager.start}
              end={returnsPager.end}
              onPageChange={returnsPager.setPage}
              onPageSizeChange={returnsPager.setPageSize}
              noun="returns"
            />
          </div>
        ) : null}
      </DrilldownModal>

      <ReportsStatement data={pack} />
    </div>
  )
}

function OwedHouseRows({
  house,
  expanded,
  colSpan,
  onToggle,
}: {
  house: OwedHouse
  expanded: boolean
  colSpan: number
  onToggle: () => void
}) {
  return (
    <>
      <tr
        className="cursor-pointer"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            onToggle()
          }
        }}
        tabIndex={0}
        aria-expanded={expanded}
      >
        <td>
          <div className="flex items-start gap-2">
            <ChevronDown
              className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
              aria-hidden
            />
            <div>
              <p className="font-medium">{house.name}</p>
              <p className="text-xs text-muted-foreground">
                {house.bills.length} bill{house.bills.length === 1 ? "" : "s"}. Click to open.
              </p>
            </div>
          </div>
        </td>
        <td className="text-right num font-semibold text-danger">{formatCurrency(house.owed)}</td>
      </tr>
      {expanded ? (
        <tr className="hover:bg-transparent">
          <td colSpan={colSpan} className="bg-muted/30 p-4">
            <div className="overflow-x-auto rounded-lg border border-border bg-card" onClick={(event) => event.stopPropagation()}>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Bill</th>
                    <th className="px-3 py-2 font-medium">Shop</th>
                    <th className="px-3 py-2 text-right font-medium">Still owed</th>
                  </tr>
                </thead>
                <tbody>
                  {house.bills.map((bill) => (
                    <tr key={bill.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <Link href={`/purchases/${bill.id}`} className="font-medium text-primary hover:underline">
                          {bill.invoice}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <ShopTag>{bill.shop}</ShopTag>
                      </td>
                      <td className="px-3 py-2 text-right num font-semibold text-danger">{formatCurrency(bill.owed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}
