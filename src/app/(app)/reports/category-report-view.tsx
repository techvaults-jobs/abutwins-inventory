"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { ChevronRight } from "lucide-react"
import { DrilldownModal } from "@/components/drilldown-modal"
import { ShopTag, TableEmpty, TableShell } from "@/components/shared"
import { TableDownload } from "@/components/table-download"
import { TablePager, usePagedRows } from "@/components/table-pager"
import { Input } from "@/components/ui/input"
import type { CategoryReport, CategoryBuyRow, CategorySalesRow } from "@/lib/category-report"
import { formatCurrency, formatDate } from "@/lib/utils"
import { Figure, type ShopSaleLine } from "./shop-sales-detail"

/** One click-through: a category's sales, or what was bought for it. "ALL" is the total line. */
type Open = { kind: "sales" | "buys"; id: string } | null

function totalOf<T extends object>(rows: T[], keys: Array<keyof T>) {
  const out = {} as Record<keyof T, number>
  for (const key of keys) out[key] = rows.reduce<number>((sum, row) => sum + Number(row[key] ?? 0), 0)
  return out
}

function NameCell({ name }: { name: string }) {
  return (
    <td>
      <span className="inline-flex items-center gap-1 font-medium text-primary group-hover:underline">
        {name}
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </span>
    </td>
  )
}

const SALES_KEYS: Array<keyof CategorySalesRow> = ["qty", "totalSales", "returns", "actualSales", "actualCost", "profit", "received"]
const BUY_KEYS: Array<keyof CategoryBuyRow> = ["qtyBought", "bought", "qtySentBack", "sentBack", "netBought", "qtySold"]

function matches(words: string[], parts: string[]) {
  if (!words.length) return true
  const hay = parts.join(" ").toLowerCase()
  return words.every((word) => hay.includes(word))
}

/**
 * Sales by category and Bought by category, for the period on screen. The
 * auditor asked to see each sales department's total sales, returns, actual
 * sales, cost, profit and payment received, and every purchase by its
 * category, "at a glance or at a click" instead of going through invoices.
 */
export function CategoryReportView({
  report,
  shopLines,
  showCost,
  scope,
  periodLabel,
  fileScope,
  scopeKey,
}: {
  report: CategoryReport
  shopLines: ShopSaleLine[]
  showCost: boolean
  scope: string
  periodLabel: string
  fileScope: string
  scopeKey: string
}) {
  const [open, setOpen] = useState<Open>(null)
  const salesTotal = useMemo(() => totalOf(report.sales, SALES_KEYS), [report.sales])
  const buysTotal = useMemo(() => totalOf(report.buys, BUY_KEYS), [report.buys])
  const salesPager = usePagedRows(report.sales, `${scopeKey}-cat-sales`)
  const buysPager = usePagedRows(report.buys, `${scopeKey}-cat-buys`)

  const salesHeader = [
    "Category",
    "Items sold",
    "Total sales",
    "Total return value",
    "Actual sales",
    ...(showCost ? ["Actual cost on sales", "Profit"] : []),
    "Payment received",
  ]
  const salesCells = (row: Omit<CategorySalesRow, "id" | "name">) => [
    row.qty,
    row.totalSales,
    row.returns,
    row.actualSales,
    ...(showCost ? [row.actualCost, row.profit] : []),
    row.received,
  ]
  const buysHeader = [
    "Category",
    "Qty bought",
    ...(showCost ? ["Bought (cost)"] : []),
    "Qty sent back",
    ...(showCost ? ["Sent back (cost)", "Net bought"] : []),
    "Qty sold in the period",
  ]
  const buysCells = (row: Omit<CategoryBuyRow, "id" | "name">) => [
    row.qtyBought,
    ...(showCost ? [row.bought] : []),
    row.qtySentBack,
    ...(showCost ? [row.sentBack, row.netBought] : []),
    row.qtySold,
  ]

  const rowProps = (kind: "sales" | "buys", id: string, label: string) => ({
    tabIndex: 0,
    role: "button" as const,
    "aria-label": label,
    onClick: () => setOpen({ kind, id }),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        setOpen({ kind, id })
      }
    },
  })
  const rowClass = "group cursor-pointer transition-colors hover:bg-primary/5 focus-visible:bg-primary/5 focus-visible:outline-none"
  const totalClass = `${rowClass} border-t-2 border-border bg-muted/40 font-semibold`

  return (
    <div className="space-y-4">
      <TableShell
        caption={
          <>
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Sales by category</h2>
              <p className="text-xs text-muted-foreground">
                Each sales department in this period. Tap a category to see every item sold and returned.
              </p>
            </div>
            <TableDownload
              filename={`${fileScope}-sales-by-category`}
              rows={() => [
                ["Sales by category", scope, periodLabel],
                [],
                salesHeader,
                ...report.sales.map((row) => [row.name, ...salesCells(row)]),
                [],
                ["All categories", ...salesCells(salesTotal)],
              ]}
            />
          </>
        }
        columns={[
          { label: "Category" },
          { label: "Items sold", align: "right" },
          { label: "Total sales", align: "right" },
          { label: "Total return value", align: "right" },
          { label: "Actual sales", align: "right" },
          ...(showCost
            ? [
                { label: "Actual cost on sales", align: "right" as const },
                { label: "Profit", align: "right" as const },
              ]
            : []),
          { label: "Payment received", align: "right" },
        ]}
        footer={
          <TablePager
            page={salesPager.page}
            pageCount={salesPager.pageCount}
            pageSize={salesPager.pageSize}
            total={salesPager.total}
            start={salesPager.start}
            end={salesPager.end}
            onPageChange={salesPager.setPage}
            onPageSizeChange={salesPager.setPageSize}
            noun="categories"
          />
        }
      >
        {salesPager.pageRows.map((row) => (
          <tr key={row.id} {...rowProps("sales", row.id, `See every sale in ${row.name}`)} className={rowClass}>
            <NameCell name={row.name} />
            <td className="text-right num">{row.qty}</td>
            <td className="text-right num">{formatCurrency(row.totalSales)}</td>
            <td className="text-right num text-warning">{row.returns ? formatCurrency(row.returns) : "—"}</td>
            <td className="text-right num font-semibold">{formatCurrency(row.actualSales)}</td>
            {showCost ? (
              <>
                <td className="text-right num">{formatCurrency(row.actualCost)}</td>
                <td className={`text-right num font-semibold ${row.profit < 0 ? "text-danger" : "text-success"}`}>
                  {formatCurrency(row.profit)}
                </td>
              </>
            ) : null}
            <td className="text-right num font-semibold text-success">{formatCurrency(row.received)}</td>
          </tr>
        ))}
        {report.sales.length > 1 ? (
          <tr {...rowProps("sales", "ALL", "See every sale in every category")} className={totalClass}>
            <NameCell name="All categories" />
            <td className="text-right num">{salesTotal.qty}</td>
            <td className="text-right num">{formatCurrency(salesTotal.totalSales)}</td>
            <td className="text-right num text-warning">{formatCurrency(salesTotal.returns)}</td>
            <td className="text-right num">{formatCurrency(salesTotal.actualSales)}</td>
            {showCost ? (
              <>
                <td className="text-right num">{formatCurrency(salesTotal.actualCost)}</td>
                <td className={`text-right num ${salesTotal.profit < 0 ? "text-danger" : "text-success"}`}>
                  {formatCurrency(salesTotal.profit)}
                </td>
              </>
            ) : null}
            <td className="text-right num text-success">{formatCurrency(salesTotal.received)}</td>
          </tr>
        ) : null}
        {report.sales.length === 0 ? (
          <TableEmpty colSpan={showCost ? 8 : 6}>Nothing sold, returned or paid in this time.</TableEmpty>
        ) : null}
      </TableShell>

      <TableShell
        caption={
          <>
            <div>
              <h2 className="text-sm font-semibold tracking-tight">Bought by category</h2>
              <p className="text-xs text-muted-foreground">
                Supplier bills in this period (opening stock left out), set against what sold. Tap a category to see every bill
                line.
              </p>
            </div>
            <TableDownload
              filename={`${fileScope}-bought-by-category`}
              rows={() => [
                ["Bought by category", scope, periodLabel],
                [],
                buysHeader,
                ...report.buys.map((row) => [row.name, ...buysCells(row)]),
                [],
                ["All categories", ...buysCells(buysTotal)],
              ]}
            />
          </>
        }
        columns={[
          { label: "Category" },
          { label: "Qty bought", align: "right" },
          ...(showCost ? [{ label: "Bought (cost)", align: "right" as const }] : []),
          { label: "Qty sent back", align: "right" },
          ...(showCost
            ? [
                { label: "Sent back (cost)", align: "right" as const },
                { label: "Net bought", align: "right" as const },
              ]
            : []),
          { label: "Qty sold", align: "right" },
        ]}
        footer={
          <TablePager
            page={buysPager.page}
            pageCount={buysPager.pageCount}
            pageSize={buysPager.pageSize}
            total={buysPager.total}
            start={buysPager.start}
            end={buysPager.end}
            onPageChange={buysPager.setPage}
            onPageSizeChange={buysPager.setPageSize}
            noun="categories"
          />
        }
      >
        {buysPager.pageRows.map((row) => (
          <tr key={row.id} {...rowProps("buys", row.id, `See every bill line in ${row.name}`)} className={rowClass}>
            <NameCell name={row.name} />
            <td className="text-right num">{row.qtyBought}</td>
            {showCost ? <td className="text-right num">{formatCurrency(row.bought)}</td> : null}
            <td className="text-right num">{row.qtySentBack || "—"}</td>
            {showCost ? (
              <>
                <td className="text-right num text-warning">{row.sentBack ? formatCurrency(row.sentBack) : "—"}</td>
                <td className="text-right num font-semibold">{formatCurrency(row.netBought)}</td>
              </>
            ) : null}
            <td className="text-right num">{row.qtySold}</td>
          </tr>
        ))}
        {report.buys.length > 1 ? (
          <tr {...rowProps("buys", "ALL", "See every bill line in every category")} className={totalClass}>
            <NameCell name="All categories" />
            <td className="text-right num">{buysTotal.qtyBought}</td>
            {showCost ? <td className="text-right num">{formatCurrency(buysTotal.bought)}</td> : null}
            <td className="text-right num">{buysTotal.qtySentBack}</td>
            {showCost ? (
              <>
                <td className="text-right num text-warning">{formatCurrency(buysTotal.sentBack)}</td>
                <td className="text-right num">{formatCurrency(buysTotal.netBought)}</td>
              </>
            ) : null}
            <td className="text-right num">{buysTotal.qtySold}</td>
          </tr>
        ) : null}
        {report.buys.length === 0 ? (
          <TableEmpty colSpan={showCost ? 7 : 4}>No supplier bill in this time.</TableEmpty>
        ) : null}
      </TableShell>

      <CategorySalesDetail
        open={open?.kind === "sales" ? open.id : null}
        onClose={() => setOpen(null)}
        report={report}
        total={salesTotal}
        shopLines={shopLines}
        showCost={showCost}
        scope={scope}
        periodLabel={periodLabel}
        fileScope={fileScope}
      />
      <CategoryBuysDetail
        open={open?.kind === "buys" ? open.id : null}
        onClose={() => setOpen(null)}
        report={report}
        total={buysTotal}
        showCost={showCost}
        scope={scope}
        periodLabel={periodLabel}
        fileScope={fileScope}
      />
    </div>
  )
}

function CategorySalesDetail({
  open,
  onClose,
  report,
  total,
  shopLines,
  showCost,
  scope,
  periodLabel,
  fileScope,
}: {
  open: string | null
  onClose: () => void
  report: CategoryReport
  total: Record<keyof CategorySalesRow, number>
  shopLines: ShopSaleLine[]
  showCost: boolean
  scope: string
  periodLabel: string
  fileScope: string
}) {
  const [query, setQuery] = useState("")
  const all = open === "ALL"
  const row = all ? null : report.sales.find((entry) => entry.id === open) ?? null
  const figures = all ? total : row
  const name = all ? "Every category" : row?.name ?? ""
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)

  const sold = useMemo(
    () => (open === null ? [] : all ? shopLines : shopLines.filter((line) => line.categoryId === open)),
    [shopLines, open, all]
  )
  const back = useMemo(
    () => (open === null ? [] : all ? report.returnLines : report.returnLines.filter((line) => line.categoryId === open)),
    [report.returnLines, open, all]
  )
  const visibleSold = sold.filter((line) => matches(words, [line.invoice, line.customer, line.item, line.unit, line.shop]))
  const visibleBack = back.filter((line) => matches(words, [line.returnNumber, line.customer, line.item, line.unit, line.shop]))
  const pager = usePagedRows(visibleSold, `${open}|${query}`)

  function rows(): Array<Array<string | number>> {
    return [
      [`Sales by category: ${name}`],
      [scope, periodLabel],
      [],
      ["Items sold", figures?.qty ?? 0],
      ["Total sales", figures?.totalSales ?? 0],
      ["Total return value", figures?.returns ?? 0],
      ["Actual sales", figures?.actualSales ?? 0],
      ...(showCost
        ? [
            ["Actual cost on sales", figures?.actualCost ?? 0],
            ["Profit", figures?.profit ?? 0],
          ]
        : []),
      ["Payment received", figures?.received ?? 0],
      [],
      ["Sold"],
      ["Date", "Invoice", "Customer", "Shop", "Category", "Item", "IMEI / serial", "Qty", "Sold for", ...(showCost ? ["Cost"] : [])],
      ...sold.map((line) => [
        formatDate(line.date),
        line.invoice,
        line.customer,
        line.shop,
        line.category ?? "",
        line.item,
        line.unit,
        line.quantity,
        line.sold,
        ...(showCost ? [line.cost] : []),
      ]),
      [],
      ["Returned for a refund or credit note"],
      ["Date", "Return", "Customer", "Shop", "Item", "IMEI", "Qty", "Value", ...(showCost ? ["Cost"] : [])],
      ...back.map((line) => [
        formatDate(line.date),
        line.returnNumber,
        line.customer,
        line.shop,
        line.item,
        line.unit,
        line.qty,
        line.value,
        ...(showCost ? [line.cost] : []),
      ]),
    ]
  }

  return (
    <DrilldownModal
      open={open !== null}
      onClose={() => {
        setQuery("")
        onClose()
      }}
      eyebrow={`${scope} · ${periodLabel}`}
      title={`Sales by category: ${name}`}
      download={{ filename: `${fileScope}-sales-category-${all ? "all" : name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, rows }}
      summary={
        <>
          <span>{figures?.qty ?? 0} items sold</span>
          <span className="font-semibold text-foreground">{formatCurrency(figures?.actualSales ?? 0)}</span>
        </>
      }
    >
      <div className="space-y-4 p-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Figure label="Total sales" value={formatCurrency(figures?.totalSales ?? 0)} hint={`${figures?.qty ?? 0} items sold`} />
          <Figure label="Total return value" value={formatCurrency(figures?.returns ?? 0)} hint={`${back.length} return${back.length === 1 ? "" : "s"} finished`} />
          <Figure label="Actual sales" value={formatCurrency(figures?.actualSales ?? 0)} hint="Sales less returns" />
          <Figure label="Payment received" value={formatCurrency(figures?.received ?? 0)} hint="Money in this period, shared by item value" />
          {showCost ? (
            <>
              <Figure label="Actual cost on sales" value={formatCurrency(figures?.actualCost ?? 0)} hint="Cost sold less cost returned" />
              <Figure
                label="Profit"
                value={formatCurrency(figures?.profit ?? 0)}
                hint="Actual sales less actual cost"
                tone={(figures?.profit ?? 0) < 0 ? "danger" : "success"}
              />
            </>
          ) : null}
        </dl>

        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find an invoice, customer, item or IMEI"
          aria-label="Find an invoice, customer, item or IMEI"
          className="sm:max-w-md"
        />

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Shop</th>
                <th>Item</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Sold for</th>
                {showCost ? <th className="text-right">Cost</th> : null}
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((line) => (
                <tr key={line.id}>
                  <td className="whitespace-nowrap text-muted-foreground">{formatDate(line.date)}</td>
                  <td>
                    <Link href={`/sales/${line.saleId}`} className="font-medium text-primary hover:underline">
                      {line.invoice}
                    </Link>
                  </td>
                  <td>{line.customer}</td>
                  <td>
                    <ShopTag>{line.shop}</ShopTag>
                  </td>
                  <td>
                    <p className="font-medium">{line.item}</p>
                    {all && line.category ? <p className="text-xs text-muted-foreground">{line.category}</p> : null}
                    {line.unit ? <p className="font-mono text-xs text-muted-foreground">{line.unit}</p> : null}
                    {line.returned ? <p className="text-[11px] font-medium text-warning">Returned later for a refund or credit</p> : null}
                  </td>
                  <td className="text-right num">{line.quantity}</td>
                  <td className="text-right num font-semibold">{formatCurrency(line.sold)}</td>
                  {showCost ? <td className="text-right num">{formatCurrency(line.cost)}</td> : null}
                </tr>
              ))}
              {visibleSold.length === 0 ? (
                <TableEmpty colSpan={showCost ? 8 : 7}>
                  {sold.length === 0 ? "Nothing sold in this category in this time." : "Nothing matches that search."}
                </TableEmpty>
              ) : null}
            </tbody>
          </table>
        </div>
        <TablePager
          page={pager.page}
          pageCount={pager.pageCount}
          pageSize={pager.pageSize}
          total={pager.total}
          start={pager.start}
          end={pager.end}
          onPageChange={pager.setPage}
          onPageSizeChange={pager.setPageSize}
          noun="items"
        />

        {back.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Returned for a refund or credit note</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Return</th>
                    <th>Customer</th>
                    <th>Shop</th>
                    <th>Item</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Value</th>
                    {showCost ? <th className="text-right">Cost</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleBack.map((line) => (
                    <tr key={line.id}>
                      <td className="whitespace-nowrap text-muted-foreground">{formatDate(line.date)}</td>
                      <td className="font-medium">{line.returnNumber}</td>
                      <td>{line.customer}</td>
                      <td>
                        <ShopTag>{line.shop}</ShopTag>
                      </td>
                      <td>
                        <p className="font-medium">{line.item}</p>
                        {line.unit ? <p className="font-mono text-xs text-muted-foreground">{line.unit}</p> : null}
                      </td>
                      <td className="text-right num">{line.qty}</td>
                      <td className="text-right num font-semibold text-warning">{formatCurrency(line.value)}</td>
                      {showCost ? <td className="text-right num">{formatCurrency(line.cost)}</td> : null}
                    </tr>
                  ))}
                  {visibleBack.length === 0 ? <TableEmpty colSpan={showCost ? 8 : 7}>Nothing matches that search.</TableEmpty> : null}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </DrilldownModal>
  )
}

function CategoryBuysDetail({
  open,
  onClose,
  report,
  total,
  showCost,
  scope,
  periodLabel,
  fileScope,
}: {
  open: string | null
  onClose: () => void
  report: CategoryReport
  total: Record<keyof CategoryBuyRow, number>
  showCost: boolean
  scope: string
  periodLabel: string
  fileScope: string
}) {
  const [query, setQuery] = useState("")
  const all = open === "ALL"
  const row = all ? null : report.buys.find((entry) => entry.id === open) ?? null
  const figures = all ? total : row
  const name = all ? "Every category" : row?.name ?? ""
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const categoryName = (id: string) => report.buys.find((entry) => entry.id === id)?.name ?? ""

  const bought = useMemo(
    () => (open === null ? [] : all ? report.buyLines : report.buyLines.filter((line) => line.categoryId === open)),
    [report.buyLines, open, all]
  )
  const sentBack = useMemo(
    () => (open === null ? [] : all ? report.sendBackLines : report.sendBackLines.filter((line) => line.categoryId === open)),
    [report.sendBackLines, open, all]
  )
  const visibleBought = bought.filter((line) => matches(words, [line.invoice, line.supplier, line.item, line.shop]))
  const visibleBack = sentBack.filter((line) => matches(words, [line.reference, line.supplier, line.item, line.unit, line.shop]))
  const pager = usePagedRows(visibleBought, `${open}|${query}`)

  function rows(): Array<Array<string | number>> {
    return [
      [`Bought by category: ${name}`],
      [scope, periodLabel],
      [],
      ["Qty bought", figures?.qtyBought ?? 0],
      ...(showCost ? [["Bought (cost)", figures?.bought ?? 0]] : []),
      ["Qty sent back", figures?.qtySentBack ?? 0],
      ...(showCost
        ? [
            ["Sent back (cost)", figures?.sentBack ?? 0],
            ["Net bought", figures?.netBought ?? 0],
          ]
        : []),
      ["Qty sold in the period", figures?.qtySold ?? 0],
      [],
      ["Bill lines"],
      ["Date", "Bill", "Supplier", "Shop", "Category", "Item", "Qty", ...(showCost ? ["Unit cost", "Line total"] : [])],
      ...bought.map((line) => [
        formatDate(line.date),
        line.invoice,
        line.supplier,
        line.shop,
        categoryName(line.categoryId),
        line.item,
        line.qty,
        ...(showCost ? [line.unitCost, line.total] : []),
      ]),
      [],
      ["Sent back to the supplier"],
      ["Date", "Reference", "Supplier", "Shop", "Item", "IMEI", ...(showCost ? ["Cost"] : [])],
      ...sentBack.map((line) => [
        formatDate(line.date),
        line.reference,
        line.supplier,
        line.shop,
        line.item,
        line.unit,
        ...(showCost ? [line.cost] : []),
      ]),
    ]
  }

  return (
    <DrilldownModal
      open={open !== null}
      onClose={() => {
        setQuery("")
        onClose()
      }}
      eyebrow={`${scope} · ${periodLabel}`}
      title={`Bought by category: ${name}`}
      download={{ filename: `${fileScope}-bought-category-${all ? "all" : name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, rows }}
      summary={
        <>
          <span>
            {figures?.qtyBought ?? 0} bought · {figures?.qtySold ?? 0} sold
          </span>
          {showCost ? <span className="font-semibold text-foreground">{formatCurrency(figures?.netBought ?? 0)}</span> : null}
        </>
      }
    >
      <div className="space-y-4 p-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Figure
            label="Bought"
            value={showCost ? formatCurrency(figures?.bought ?? 0) : String(figures?.qtyBought ?? 0)}
            hint={`${figures?.qtyBought ?? 0} on supplier bills`}
          />
          <Figure
            label="Sent back"
            value={showCost ? formatCurrency(figures?.sentBack ?? 0) : String(figures?.qtySentBack ?? 0)}
            hint={`${figures?.qtySentBack ?? 0} returned to suppliers`}
          />
          {showCost ? <Figure label="Net bought" value={formatCurrency(figures?.netBought ?? 0)} hint="Bought less sent back" /> : null}
          <Figure label="Sold in the period" value={String(figures?.qtySold ?? 0)} hint="Pieces on this period's invoices" />
        </dl>

        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a bill, supplier, item or IMEI"
          aria-label="Find a bill, supplier, item or IMEI"
          className="sm:max-w-md"
        />

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Bill</th>
                <th>Supplier</th>
                <th>Shop</th>
                <th>Item</th>
                <th className="text-right">Qty</th>
                {showCost ? (
                  <>
                    <th className="text-right">Unit cost</th>
                    <th className="text-right">Line total</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((line) => (
                <tr key={line.id}>
                  <td className="whitespace-nowrap text-muted-foreground">{formatDate(line.date)}</td>
                  <td>
                    <Link href={`/purchases/${line.purchaseId}`} className="font-medium text-primary hover:underline">
                      {line.invoice}
                    </Link>
                  </td>
                  <td>{line.supplier}</td>
                  <td>
                    <ShopTag>{line.shop}</ShopTag>
                  </td>
                  <td>
                    <p className="font-medium">{line.item}</p>
                    {all ? <p className="text-xs text-muted-foreground">{categoryName(line.categoryId)}</p> : null}
                  </td>
                  <td className="text-right num">{line.qty}</td>
                  {showCost ? (
                    <>
                      <td className="text-right num">{formatCurrency(line.unitCost)}</td>
                      <td className="text-right num font-semibold">{formatCurrency(line.total)}</td>
                    </>
                  ) : null}
                </tr>
              ))}
              {visibleBought.length === 0 ? (
                <TableEmpty colSpan={showCost ? 8 : 6}>
                  {bought.length === 0 ? "Nothing bought in this category in this time." : "Nothing matches that search."}
                </TableEmpty>
              ) : null}
            </tbody>
          </table>
        </div>
        <TablePager
          page={pager.page}
          pageCount={pager.pageCount}
          pageSize={pager.pageSize}
          total={pager.total}
          start={pager.start}
          end={pager.end}
          onPageChange={pager.setPage}
          onPageSizeChange={pager.setPageSize}
          noun="bill lines"
        />

        {sentBack.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Sent back to the supplier</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reference</th>
                    <th>Supplier</th>
                    <th>Shop</th>
                    <th>Item</th>
                    {showCost ? <th className="text-right">Cost</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {visibleBack.map((line) => (
                    <tr key={line.id}>
                      <td className="whitespace-nowrap text-muted-foreground">{formatDate(line.date)}</td>
                      <td className="font-medium">{line.reference}</td>
                      <td>{line.supplier}</td>
                      <td>
                        <ShopTag>{line.shop}</ShopTag>
                      </td>
                      <td>
                        <p className="font-medium">{line.item}</p>
                        <p className="font-mono text-xs text-muted-foreground">{line.unit}</p>
                      </td>
                      {showCost ? <td className="text-right num text-warning">{formatCurrency(line.cost)}</td> : null}
                    </tr>
                  ))}
                  {visibleBack.length === 0 ? <TableEmpty colSpan={showCost ? 6 : 5}>Nothing matches that search.</TableEmpty> : null}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </DrilldownModal>
  )
}
