"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { DrilldownModal } from "@/components/drilldown-modal"
import { ShopTag, TableEmpty } from "@/components/shared"
import { TablePager, usePagedRows } from "@/components/table-pager"
import { Input } from "@/components/ui/input"
import type { ReportsPack } from "@/lib/reports-pack"
import { formatCurrency, formatDate } from "@/lib/utils"

/** One item sold, on an invoice in the report's period. */
export type ShopSaleLine = {
  id: string
  saleId: string
  invoice: string
  /** ISO time of the sale. */
  date: string
  customer: string
  shopId: string
  /** Shop code. */
  shop: string
  item: string
  /** IMEI or serial, when the item has one. */
  unit: string
  quantity: number
  unitPrice: number
  /** What the line fetched after the order discount is shared out. */
  sold: number
  /** What it cost us; 0 for anyone who may not see cost. */
  cost: number
  /** Came back later for a refund or credit note. */
  returned: boolean
}

type ShopRow = ReportsPack["byShop"][number]

/**
 * Everything behind one line of Sales by shop (or the total line): the
 * figures, then every item sold, for Excel or CSV. Cost and profit only when
 * `showCost`; the server already sends 0 to anyone else.
 */
export function ShopSalesDetail({
  shopId,
  onClose,
  byShop,
  lines,
  showCost,
  scope,
  periodLabel,
  fileScope,
}: {
  /** A shop's id, "ALL" for every shop on the table, or null when closed. */
  shopId: string | null
  onClose: () => void
  byShop: ShopRow[]
  lines: ShopSaleLine[]
  showCost: boolean
  scope: string
  periodLabel: string
  fileScope: string
}) {
  const [query, setQuery] = useState("")
  const all = shopId === "ALL"
  const shop = all ? null : byShop.find((row) => row.id === shopId) ?? null

  const summary = useMemo(() => {
    const rows = all ? byShop : shop ? [shop] : []
    const revenue = rows.reduce((sum, row) => sum + row.revenue, 0)
    const cost = rows.reduce((sum, row) => sum + row.cost, 0)
    return {
      invoices: rows.reduce((sum, row) => sum + row.tickets, 0),
      revenue,
      cost,
      profit: revenue - cost,
      collected: rows.reduce((sum, row) => sum + row.collected, 0),
    }
  }, [all, byShop, shop])

  const shopLines = useMemo(
    () => (shopId === null ? [] : all ? lines : lines.filter((line) => line.shopId === shopId)),
    [lines, shopId, all]
  )
  const itemsSold = shopLines.reduce((sum, line) => sum + line.quantity, 0)
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return shopLines
    return shopLines.filter((line) => {
      const hay = [line.invoice, line.customer, line.item, line.unit, line.shop].join(" ").toLowerCase()
      return words.every((word) => hay.includes(word))
    })
  }, [shopLines, query])
  const pager = usePagedRows(visible, `${shopId}|${query}`)

  const title = all ? "Sales by shop: every shop" : `Sales by shop: ${shop?.name ?? ""}`
  const margin = summary.revenue > 0 ? (summary.profit / summary.revenue) * 100 : null

  function rows(): Array<Array<string | number>> {
    const header = [
      "Date",
      "Invoice",
      "Customer",
      "Shop",
      "Item",
      "IMEI / serial",
      "Qty",
      "Unit price",
      "Sold for",
      ...(showCost ? ["Cost", "Profit"] : []),
      "Returned later",
    ]
    return [
      [title],
      [scope, periodLabel],
      [],
      ["Sales volume (invoices)", summary.invoices],
      ["Items sold", itemsSold],
      ["Total sales", summary.revenue],
      ...(showCost
        ? [
            ["Total cost", summary.cost],
            ["Gross profit", summary.profit],
          ]
        : []),
      ["Payments received", summary.collected],
      [],
      header,
      ...shopLines.map((line) => [
        formatDate(line.date),
        line.invoice,
        line.customer,
        line.shop,
        line.item,
        line.unit,
        line.quantity,
        line.unitPrice,
        line.sold,
        ...(showCost ? [line.cost, line.sold - line.cost] : []),
        line.returned ? "Yes" : "",
      ]),
      [],
      [
        "Total",
        "",
        "",
        "",
        "",
        "",
        itemsSold,
        "",
        shopLines.reduce((sum, line) => sum + line.sold, 0),
        ...(showCost
          ? [
              shopLines.reduce((sum, line) => sum + line.cost, 0),
              shopLines.reduce((sum, line) => sum + line.sold - line.cost, 0),
            ]
          : []),
      ],
    ]
  }

  const fileName = `${fileScope}-sales-by-shop-${all ? "all" : (shop?.code ?? "shop").toLowerCase()}`

  return (
    <DrilldownModal
      open={shopId !== null}
      onClose={() => {
        setQuery("")
        onClose()
      }}
      eyebrow={`${scope} · ${periodLabel}`}
      title={title}
      download={{ filename: fileName, rows }}
      summary={
        <>
          <span>
            {summary.invoices} invoice{summary.invoices === 1 ? "" : "s"} · {itemsSold} item{itemsSold === 1 ? "" : "s"} sold
          </span>
          <span className="font-semibold text-foreground">{formatCurrency(summary.revenue)}</span>
        </>
      }
    >
      <div className="space-y-4 p-4">
        <dl className={`grid gap-2 ${showCost ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2 sm:grid-cols-3"}`}>
          <Figure label="Sales volume" value={String(summary.invoices)} hint="Invoices" />
          <Figure label="Total sales" value={formatCurrency(summary.revenue)} hint={`${itemsSold} item${itemsSold === 1 ? "" : "s"} sold`} />
          {showCost ? (
            <>
              <Figure label="Total cost" value={formatCurrency(summary.cost)} hint="What the items cost us" />
              <Figure
                label="Gross profit"
                value={formatCurrency(summary.profit)}
                hint={margin === null ? "Sales less cost" : `${margin.toFixed(1)}% of sales`}
                tone={summary.profit < 0 ? "danger" : "success"}
              />
            </>
          ) : null}
          <Figure
            label="Payments received"
            value={formatCurrency(summary.collected)}
            hint="Money in this period, older debts paid included"
            className={showCost ? "col-span-2 sm:col-span-4" : undefined}
          />
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
                {all ? <th>Shop</th> : null}
                <th>Item</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Sold for</th>
                {showCost ? (
                  <>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Profit</th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((line) => {
                const profit = line.sold - line.cost
                return (
                  <tr key={line.id}>
                    <td className="whitespace-nowrap text-muted-foreground">{formatDate(line.date)}</td>
                    <td>
                      <Link href={`/sales/${line.saleId}`} className="font-medium text-primary hover:underline">
                        {line.invoice}
                      </Link>
                    </td>
                    <td>{line.customer}</td>
                    {all ? (
                      <td>
                        <ShopTag>{line.shop}</ShopTag>
                      </td>
                    ) : null}
                    <td>
                      <p className="font-medium">{line.item}</p>
                      {line.unit ? <p className="font-mono text-xs text-muted-foreground">{line.unit}</p> : null}
                      {line.returned ? (
                        <p className="text-[11px] font-medium text-warning">Returned later for a refund or credit</p>
                      ) : null}
                    </td>
                    <td className="text-right num">{line.quantity}</td>
                    <td className="text-right num font-semibold">{formatCurrency(line.sold)}</td>
                    {showCost ? (
                      <>
                        <td className="text-right num">{formatCurrency(line.cost)}</td>
                        <td className={`text-right num font-semibold ${profit < 0 ? "text-danger" : "text-success"}`}>
                          {formatCurrency(profit)}
                        </td>
                      </>
                    ) : null}
                  </tr>
                )
              })}
              {visible.length === 0 ? (
                <TableEmpty colSpan={6 + (all ? 1 : 0) + (showCost ? 2 : 0)}>
                  {shopLines.length === 0 ? "No item sold in this time." : "Nothing matches that search."}
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
      </div>
    </DrilldownModal>
  )
}

function Figure({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string
  value: string
  hint: string
  tone?: "success" | "danger"
  className?: string
}) {
  return (
    <div className={`rounded-lg border border-border bg-muted/30 px-3 py-2.5 ${className ?? ""}`}>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 text-lg font-bold tabular-nums ${tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : ""}`}
      >
        {value}
      </dd>
      <dd className="text-[11px] text-muted-foreground">{hint}</dd>
    </div>
  )
}
