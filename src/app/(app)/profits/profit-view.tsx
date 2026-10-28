"use client"

import { useMemo } from "react"
import { Coins, FileSpreadsheet, Info, Receipt, TrendingDown, TrendingUp, Wallet } from "lucide-react"
import type { PriceChangeLine, ProfitByShop } from "@/app/actions/finance"
import { DataTable, type DataColumn } from "@/components/data-table"
import { PeriodPicker, type PickerRange } from "@/components/period-picker"
import { StatCard, StatGrid, TonePill, Toolbar } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { downloadWorkbook } from "@/lib/download-table"
import { watDayKey } from "@/lib/lagos-day"
import { cn, formatCurrency, formatDate } from "@/lib/utils"

/** One sold line still counted (what came back is left out), as the server works it out. */
export type ProfitLine = {
  id: string
  invoice: string
  shop: string
  date: string
  /** Name · storage · condition · colour. */
  item: string
  /** IMEI or serial of the phone, "" for an item without one. */
  unit: string
  quantity: number
  cost: number
  sell: number
  profit: number
  /** False when the line has no cost from the day it sold and today's cost is used. */
  costIsSnapshot: boolean
}

type PriceChange = Omit<PriceChangeLine, "date"> & { date: string }

type ItemRow = { key: string; item: string; quantity: number; lines: number; sales: number; cost: number; profit: number }

const margin = (profit: number, sales: number) => (sales > 0 ? `${((profit / sales) * 100).toFixed(1)}%` : "—")
const profitTone = (value: number) => (value < 0 ? "text-danger" : "text-success")

export function ProfitView({
  range,
  from,
  date,
  periodLabel,
  lines,
  byShop,
  expenses,
  invoices,
  invoiceTotal,
  tax,
  returnedValue,
  mismatched,
  priceChanges,
}: {
  range: PickerRange
  from: string
  date: string
  periodLabel: string
  lines: ProfitLine[]
  byShop: ProfitByShop[]
  expenses: number
  invoices: number
  /** The invoices as written: Total sales on Reports for the same period. */
  invoiceTotal: number
  tax: number
  /** What came back off these invoices for a refund or a credit note. */
  returnedValue: number
  /** Invoices whose lines do not add up to their total: the cause of any Other difference. */
  mismatched: Array<{ invoice: string; invoiceTotal: number; linesTotal: number }>
  priceChanges: PriceChange[]
}) {
  const totals = useMemo(() => {
    const sum = (pick: (row: ProfitLine) => number) => lines.reduce((total, row) => total + pick(row), 0)
    const noCost = lines.filter((row) => row.cost <= 0)
    const todayCost = lines.filter((row) => row.cost > 0 && !row.costIsSnapshot)
    const belowCost = lines.filter((row) => row.profit < 0)
    return {
      sales: sum((row) => row.sell),
      cost: sum((row) => row.cost),
      profit: sum((row) => row.profit),
      items: sum((row) => row.quantity),
      noCost: { count: noCost.length, value: noCost.reduce((total, row) => total + row.sell, 0) },
      todayCost: todayCost.length,
      belowCost: { count: belowCost.length, value: belowCost.reduce((total, row) => total - row.profit, 0) },
    }
  }, [lines])
  const left = totals.profit - expenses
  // Whatever the invoices' total and the lines counted here do not explain.
  // It should be 0; when it is not, it is shown rather than hidden.
  const unexplained = invoiceTotal - tax - returnedValue - totals.sales

  // The same item sold many times, read as one line: what sells, and what it leaves.
  const items = useMemo(() => {
    const map = new Map<string, ItemRow>()
    for (const row of lines) {
      const entry = map.get(row.item) ?? { key: row.item, item: row.item, quantity: 0, lines: 0, sales: 0, cost: 0, profit: 0 }
      entry.quantity += row.quantity
      entry.lines += 1
      entry.sales += row.sell
      entry.cost += row.cost
      entry.profit += row.profit
      map.set(row.item, entry)
    }
    return [...map.values()].sort((a, b) => b.profit - a.profit)
  }, [lines])

  function downloadAll() {
    const fileDay = range === "all" ? `all-time-${watDayKey()}` : from === date ? date : `${from}-to-${date}`
    void downloadWorkbook(
      [
        {
          name: "Summary",
          rows: [
            ["Profit", periodLabel],
            [],
            ["Invoices in the period (Total sales on Reports)", invoiceTotal],
            ["Less items that came back (refund or credit note)", -returnedValue],
            ...(tax > 0 ? [["Less tax on the invoices", -tax] as Array<string | number>] : []),
            ...(Math.abs(unexplained) >= 1 ? [["Other difference", -unexplained] as Array<string | number>] : []),
            ["Sales counted here", totals.sales],
            ["Less cost of the items sold", -totals.cost],
            ["Profit from our own stock", totals.profit],
            ["Less approved shop bills", -expenses],
            ["What is left", left],
            [],
            ["Items sold", totals.items],
            ["Invoices", invoices],
            ["Margin", margin(totals.profit, totals.sales)],
            ["Lines with no cost price (whole sale shows as profit)", totals.noCost.count],
            ["Lines sold below cost", totals.belowCost.count],
            ...(mismatched.length
              ? [[], ["Invoices whose lines do not add up to the total", "Lines (₦)", "Invoice total (₦)"], ...mismatched.map((row) => [row.invoice, row.linesTotal, row.invoiceTotal])]
              : []),
          ],
        },
        {
          name: "By shop",
          rows: [
            ["Shop", "Items sold", "Sales (₦)", "Cost (₦)", "Profit (₦)", "Margin", "Shop bills (₦)", "Left (₦)"],
            ...byShop.map((row) => [row.name, row.items, row.sales, row.cost, row.shopProfit, margin(row.shopProfit, row.sales), row.expenses, row.net]),
          ],
        },
        {
          name: "By item",
          rows: [
            ["Item", "Quantity sold", "Sales (₦)", "Cost (₦)", "Profit (₦)", "Margin"],
            ...items.map((row) => [row.item, row.quantity, row.sales, row.cost, row.profit, margin(row.profit, row.sales)]),
          ],
        },
        {
          name: "Every line",
          rows: [
            ["Invoice", "Shop", "Date", "Item", "IMEI / serial", "Quantity", "Cost (₦)", "Sold for (₦)", "Profit (₦)", "Cost used"],
            ...lines.map((row) => [
              row.invoice,
              row.shop,
              watDayKey(new Date(row.date)),
              row.item,
              row.unit,
              row.quantity,
              row.cost,
              row.sell,
              row.profit,
              row.cost <= 0 ? "No cost price recorded" : row.costIsSnapshot ? "Cost on the day it sold" : "Today's cost (older sale)",
            ]),
          ],
        },
        {
          name: "Price changes",
          rows: [
            ["Invoice", "Date", "Shop", "Sold by", "Customer", "Item", "Standard (₦)", "Charged (₦)", "Off (₦)", "Off %", "Cost (₦)", "Below cost", "Reason", "Approved by"],
            ...priceChanges.map((row) => [
              row.invoice,
              watDayKey(new Date(row.date)),
              row.shop,
              row.soldBy,
              row.customer,
              row.item,
              row.list,
              row.charged,
              row.off,
              row.offPercent,
              row.cost,
              row.belowCost ? "Yes" : "No",
              row.reason || row.orderDiscountReason,
              row.approvedBy,
            ]),
          ],
        },
      ],
      `profit-${fileDay}.xlsx`
    )
  }

  const lineColumns: DataColumn<ProfitLine>[] = [
    {
      id: "invoice",
      header: "Invoice",
      sortValue: (row) => row.date,
      cell: (row) => (
        <div>
          <p className="font-medium">{row.invoice}</p>
          <p className="text-xs text-muted-foreground">
            {row.shop} · {formatDate(row.date)}
          </p>
        </div>
      ),
    },
    {
      id: "item",
      header: "Phone / item",
      sortValue: (row) => row.item,
      cell: (row) => (
        <div>
          <p className="font-medium">{row.item}</p>
          {row.unit ? <p className="text-xs text-muted-foreground">{row.unit}</p> : null}
          {row.cost <= 0 ? <p className="text-xs font-medium text-warning">No cost price recorded</p> : null}
        </div>
      ),
    },
    { id: "qty", header: "Qty", align: "right", hideBelow: "lg", sortValue: (row) => row.quantity, cell: (row) => row.quantity },
    { id: "cost", header: "Cost price", align: "right", sortValue: (row) => row.cost, cell: (row) => <span className="tabular-nums">{formatCurrency(row.cost)}</span> },
    { id: "sell", header: "Sold for", align: "right", sortValue: (row) => row.sell, cell: (row) => <span className="tabular-nums">{formatCurrency(row.sell)}</span> },
    {
      id: "profit",
      header: "Profit",
      align: "right",
      sortValue: (row) => row.profit,
      cell: (row) => <span className={cn("font-semibold tabular-nums", profitTone(row.profit))}>{formatCurrency(row.profit)}</span>,
    },
  ]

  const itemColumns: DataColumn<ItemRow>[] = [
    { id: "item", header: "Item", sortValue: (row) => row.item, cell: (row) => <span className="font-medium">{row.item}</span> },
    { id: "qty", header: "Sold", align: "right", sortValue: (row) => row.quantity, cell: (row) => row.quantity },
    { id: "sales", header: "Sales", align: "right", sortValue: (row) => row.sales, cell: (row) => <span className="tabular-nums">{formatCurrency(row.sales)}</span> },
    { id: "cost", header: "Cost", align: "right", hideBelow: "lg", sortValue: (row) => row.cost, cell: (row) => <span className="tabular-nums">{formatCurrency(row.cost)}</span> },
    {
      id: "profit",
      header: "Profit",
      align: "right",
      sortValue: (row) => row.profit,
      cell: (row) => <span className={cn("font-semibold tabular-nums", profitTone(row.profit))}>{formatCurrency(row.profit)}</span>,
    },
    { id: "margin", header: "Margin", align: "right", hideBelow: "lg", sortValue: (row) => (row.sales > 0 ? row.profit / row.sales : 0), cell: (row) => margin(row.profit, row.sales) },
  ]

  const priceColumns: DataColumn<PriceChange>[] = [
    {
      id: "invoice",
      header: "Invoice",
      sortValue: (row) => row.date,
      cell: (row) => (
        <div>
          <p className="font-medium">{row.invoice}</p>
          <p className="text-xs text-muted-foreground">
            {row.shop} · {formatDate(row.date)} · {row.soldBy}
          </p>
        </div>
      ),
    },
    {
      id: "item",
      header: "Item",
      sortValue: (row) => row.item,
      cell: (row) => (
        <div>
          <p className="font-medium">{row.item}</p>
          <p className="text-xs text-muted-foreground">
            {row.customer}
            {row.reseller ? " · reseller" : ""}
          </p>
        </div>
      ),
    },
    { id: "list", header: "Standard", align: "right", hideBelow: "lg", sortValue: (row) => row.list, cell: (row) => <span className="tabular-nums text-muted-foreground">{formatCurrency(row.list)}</span> },
    { id: "charged", header: "Charged", align: "right", sortValue: (row) => row.charged, cell: (row) => <span className="tabular-nums">{formatCurrency(row.charged)}</span> },
    {
      id: "off",
      header: "Off",
      align: "right",
      sortValue: (row) => row.off,
      cell: (row) => (
        <span className="tabular-nums">
          {formatCurrency(row.off)}
          {row.offPercent > 0 ? <span className="block text-xs text-muted-foreground">{row.offPercent}%</span> : null}
        </span>
      ),
    },
    {
      id: "why",
      header: "Why",
      hideBelow: "lg",
      cell: (row) => (
        <div className="text-sm">
          {row.belowCost ? <p className="font-medium text-danger">Below cost {formatCurrency(row.cost)}</p> : null}
          <p className={row.reason || row.orderDiscountReason ? "" : "text-muted-foreground"}>{row.reason || row.orderDiscountReason || "No reason recorded"}</p>
          {row.approvedBy ? <p className="text-xs text-muted-foreground">Approved by {row.approvedBy}</p> : null}
        </div>
      ),
    },
  ]
  const givenAway = priceChanges.reduce((sum, row) => sum + row.off, 0)
  const lossMakers = priceChanges.filter((row) => row.belowCost).length

  return (
    <div className="space-y-5">
      <Toolbar className="justify-between">
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          <PeriodPicker range={range} from={from} date={date} allowAll />
          <span className="justify-self-start">
            <TonePill tone="neutral">{periodLabel.charAt(0).toUpperCase() + periodLabel.slice(1)}</TonePill>
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={downloadAll}>
          <FileSpreadsheet className="mr-1.5 h-4 w-4" aria-hidden /> Excel, everything
        </Button>
      </Toolbar>

      <StatGrid className="xl:grid-cols-5">
        <StatCard
          lead
          className="col-span-2 xl:col-span-1"
          label="Profit from our own stock"
          value={formatCurrency(totals.profit)}
          hint={`Margin ${margin(totals.profit, totals.sales)} on what we sold`}
          icon={totals.profit < 0 ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
        />
        <StatCard
          label="Sales counted"
          value={formatCurrency(totals.sales)}
          hint={`${totals.items} item${totals.items === 1 ? "" : "s"} on ${invoices} invoice${invoices === 1 ? "" : "s"}`}
          icon={<Receipt className="h-4 w-4" />}
          tone="primary"
        />
        <StatCard label="Cost of the items sold" value={formatCurrency(totals.cost)} hint="What those items cost us" icon={<Coins className="h-4 w-4" />} />
        <StatCard label="Approved shop bills" value={formatCurrency(expenses)} hint="Expenses dated in this period" icon={<Wallet className="h-4 w-4" />} tone={expenses > 0 ? "warning" : "neutral"} />
        <StatCard
          label="What is left"
          value={formatCurrency(left)}
          hint="Profit less shop bills"
          icon={<TrendingUp className="h-4 w-4" />}
          tone={left < 0 ? "danger" : "success"}
        />
      </StatGrid>

      {/* The client could not tell if the figure was complete or how it was
          reached. Every step from the invoices to What is left, in naira. */}
      <div className="surface-card p-4 sm:p-5">
        <h3 className="font-semibold">How this is worked out</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Every completed sale in the period for the shop in view. Pick the same period on Reports and the first line matches its Total sales.
        </p>
        <dl className="mt-3 divide-y divide-border/70 text-sm">
          <Step label={`Invoices in the period (${invoices})`} value={invoiceTotal} />
          <Step label="Less items that came back (refund or credit note), at what they sold for" value={-returnedValue} />
          {tax > 0 ? <Step label="Less tax on the invoices" value={-tax} /> : null}
          {Math.abs(unexplained) >= 1 ? <Step label="Other difference (invoices below)" value={-unexplained} /> : null}
          <Step label={`Sales counted here (${totals.items} item${totals.items === 1 ? "" : "s"})`} value={totals.sales} strong />
          <Step label="Less cost of the items sold" value={-totals.cost} />
          <Step label="Profit from our own stock" value={totals.profit} strong />
          <Step label="Less approved shop bills" value={-expenses} />
          <Step label="What is left" value={left} strong />
        </dl>
        <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
          <li className="flex gap-1.5">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Cost is the cost written on the sale the day it sold, so a later price change does not move old profit.
            {totals.todayCost > 0 ? ` ${totals.todayCost} older line${totals.todayCost === 1 ? " was" : "s were"} sold before that, and use today's cost.` : ""}
          </li>
          {mismatched.length > 0 ? (
            <li className="flex gap-1.5 font-medium text-warning">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {mismatched.length === 1 ? "This invoice's lines do not" : `These ${mismatched.length} invoices' lines do not`} add up to the invoice
                total, so Reports and this page differ by that much:{" "}
                {mismatched
                  .slice(0, 10)
                  .map((row) => `${row.invoice} (lines ${formatCurrency(row.linesTotal)}, invoice ${formatCurrency(row.invoiceTotal)})`)
                  .join("; ")}
                {mismatched.length > 10 ? `; and ${mismatched.length - 10} more in the Excel file` : ""}. Open the invoice to put it right.
              </span>
            </li>
          ) : null}
          {totals.noCost.count > 0 ? (
            <li className="flex gap-1.5 font-medium text-warning">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {totals.noCost.count} line{totals.noCost.count === 1 ? " has" : "s have"} no cost price, so {formatCurrency(totals.noCost.value)} of sales shows as profit in full. Put the cost on the item to correct it.
            </li>
          ) : null}
          {totals.belowCost.count > 0 ? (
            <li className="flex gap-1.5 font-medium text-danger">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {totals.belowCost.count} line{totals.belowCost.count === 1 ? " was" : "s were"} sold below cost, {formatCurrency(totals.belowCost.value)} lost on them. They are in the list, in red.
            </li>
          ) : null}
        </ul>
      </div>

      {byShop.length ? (
        <div className="surface-card overflow-hidden">
          <h3 className="border-b border-border px-5 py-4 font-semibold">Profit by shop</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-foreground/80">
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-5 py-3 font-semibold">Shop</th>
                  <th className="px-3 py-3 text-right font-semibold">Items</th>
                  <th className="px-3 py-3 text-right font-semibold">Sales</th>
                  <th className="px-3 py-3 text-right font-semibold">Cost</th>
                  <th className="px-3 py-3 text-right font-semibold">Profit</th>
                  <th className="px-3 py-3 text-right font-semibold">Shop bills</th>
                  <th className="px-5 py-3 text-right font-semibold">Left for this shop</th>
                </tr>
              </thead>
              <tbody>
                {byShop.map((row) => (
                  <tr key={row.name} className="border-b border-border/70">
                    <td className="px-5 py-3">{row.name}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{row.items}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(row.sales)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(row.cost)}</td>
                    <td className={cn("px-3 py-3 text-right tabular-nums", profitTone(row.shopProfit))}>
                      {formatCurrency(row.shopProfit)}
                      <span className="block text-xs text-muted-foreground">{margin(row.shopProfit, row.sales)}</span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(row.expenses)}</td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums">{formatCurrency(row.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <section className="space-y-2">
        <div>
          <h3 className="font-semibold">Profit by item</h3>
          <p className="text-sm text-muted-foreground">The same item sold many times, as one line. Best profit first.</p>
        </div>
        <DataTable
          rows={items}
          columns={itemColumns}
          rowKey={(row) => row.key}
          noun="items"
          filterKey={`${range}:${from}:${date}`}
          searchText={(row) => row.item}
          searchPlaceholder="Search an item"
          card={(row) => ({
            title: row.item,
            subtitle: `${row.quantity} sold · ${formatCurrency(row.sales)}`,
            value: <span className={profitTone(row.profit)}>{formatCurrency(row.profit)}</span>,
            valueHint: margin(row.profit, row.sales),
          })}
          footer={(rows) => (
            <FooterRow
              label={`Totals for ${rows.length} item${rows.length === 1 ? "" : "s"}`}
              cells={[
                { value: rows.reduce((sum, row) => sum + row.quantity, 0), plain: true },
                { value: rows.reduce((sum, row) => sum + row.sales, 0) },
                { value: rows.reduce((sum, row) => sum + row.cost, 0), hideBelow: "lg" },
                { value: rows.reduce((sum, row) => sum + row.profit, 0) },
                { value: null, hideBelow: "lg" },
              ]}
            />
          )}
          empty="Nothing was sold in this period."
        />
      </section>

      <section className="space-y-2">
        <div>
          <h3 className="font-semibold">Every sale from our own stock</h3>
          <p className="text-sm text-muted-foreground">
            All {lines.length} line{lines.length === 1 ? "" : "s"} behind the figures above, newest first. Search an invoice, an IMEI or an item.
          </p>
        </div>
        <DataTable
          rows={lines}
          columns={lineColumns}
          rowKey={(row) => row.id}
          noun="lines"
          filterKey={`${range}:${from}:${date}`}
          searchText={(row) => [row.invoice, row.shop, row.item, row.unit].join(" ")}
          searchPlaceholder="Search invoice, IMEI or item"
          card={(row) => ({
            title: row.item,
            subtitle: `${row.invoice} · ${row.shop} · ${formatDate(row.date)}`,
            value: <span className={profitTone(row.profit)}>{formatCurrency(row.profit)}</span>,
            valueHint: `Sold ${formatCurrency(row.sell)} · cost ${formatCurrency(row.cost)}`,
          })}
          footer={(rows) => (
            <FooterRow
              label={`Totals for ${rows.length} line${rows.length === 1 ? "" : "s"}`}
              span={2}
              cells={[
                { value: rows.reduce((sum, row) => sum + row.quantity, 0), plain: true, hideBelow: "lg" },
                { value: rows.reduce((sum, row) => sum + row.cost, 0) },
                { value: rows.reduce((sum, row) => sum + row.sell, 0) },
                { value: rows.reduce((sum, row) => sum + row.profit, 0) },
              ]}
            />
          )}
          empty="No sales from our own stock in this period."
        />
      </section>

      <section className="space-y-2">
        <div>
          <h3 className="font-semibold">Price changes</h3>
          <p className="text-sm text-muted-foreground">
            Every line in the period sold for less than the standard price. {formatCurrency(givenAway)} given away
            {lossMakers > 0 ? `, ${lossMakers} sold below cost` : ""}.
          </p>
        </div>
        <DataTable
          rows={priceChanges}
          columns={priceColumns}
          rowKey={(row) => row.id}
          noun="price changes"
          filterKey={`${range}:${from}:${date}`}
          searchText={(row) => [row.invoice, row.item, row.customer, row.soldBy, row.reason].join(" ")}
          searchPlaceholder="Search invoice, item, customer or seller"
          card={(row) => ({
            title: row.item,
            subtitle: `${row.invoice} · ${formatDate(row.date)} · ${row.soldBy}`,
            value: formatCurrency(row.charged),
            valueHint: `${formatCurrency(row.off)} off${row.belowCost ? " · below cost" : ""}`,
          })}
          empty="Nothing was sold below its standard price in this period."
        />
      </section>
    </div>
  )
}

function Step({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-2", strong && "font-semibold")}>
      <dt className={strong ? "" : "text-muted-foreground"}>{label}</dt>
      <dd className={cn("tabular-nums", value < 0 && !strong && "text-muted-foreground")}>
        {value < 0 ? `−${formatCurrency(Math.abs(value))}` : formatCurrency(value)}
      </dd>
    </div>
  )
}

function FooterRow({
  label,
  span = 1,
  cells,
}: {
  label: string
  /** How many leading columns the label covers. */
  span?: number
  cells: Array<{ value: number | null; plain?: boolean; hideBelow?: "lg" }>
}) {
  return (
    <tr>
      <td colSpan={span} className="text-sm">
        {label}
      </td>
      {cells.map((cell, index) => (
        <td key={index} className={cn("whitespace-nowrap text-right tabular-nums", cell.hideBelow === "lg" && "hidden lg:table-cell")}>
          {cell.value == null ? "" : cell.plain ? cell.value : formatCurrency(cell.value)}
        </td>
      ))}
    </tr>
  )
}
