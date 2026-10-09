"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Download, FileSpreadsheet } from "lucide-react"
import { StatusBadge } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { downloadTable } from "@/lib/download-table"
import { formatShopWhen, watDayKey } from "@/lib/lagos-day"
import { moveWords } from "@/lib/stock-moves"
import { formatCurrency } from "@/lib/utils"
import { cn } from "@/lib/utils"

type Move = { id: string; kind: string; quantity: number; reference: string | null; when: Date; shop: string; by: string }
type Bill = { id: string; purchaseId: string; invoice: string; opening: boolean; supplier: string; shop: string; quantity: number; cost: number | null; when: Date }
type Sale = {
  id: string
  saleId: string
  invoice: string
  when: Date
  shop: string
  customer: string
  seller: string
  quantity: number
  unitPrice: number
  total: number
  imei: { id: string; imei1: string } | null
}
type Price = { id: string; type: string; from: number; to: number; reason: string | null; by: string; when: Date }
type ReturnRow = {
  id: string
  number: string
  when: Date
  status: string
  reason: string
  outcome: string
  backOnShelf: boolean
  faultClass: string
  value: number
  shop: string
  customer: string
  imei: { id: string; imei1: string } | null
}
const SHELF_WORDS: Record<string, string> = {
  GOOD_STOCK: "Back on the shelf",
  FAULTY_STOCK: "Damaged list",
  REPAIR_STOCK: "Needs repair",
  SCRAP_STOCK: "Written off",
}
type Unit = { id: string; imei1: string; serial: string | null; status: string; shop: string; booked: Date; changed: Date }

const PRICE_WORDS: Record<string, string> = {
  COST_PRICE: "Cost",
  SELLING_PRICE: "Selling price",
  MINIMUM_PRICE: "Lowest allowed price",
}

type Tab = "moves" | "bills" | "sales" | "returns" | "units" | "prices"

/** Where a paper reference leads, when it is one the app can open. */
function referenceHref(reference: string | null) {
  if (!reference) return null
  if (reference.startsWith("INV-")) return `/sales?q=${encodeURIComponent(reference)}`
  if (reference.startsWith("TRF-")) return "/transfers"
  if (reference.startsWith("RTN-")) return "/returns"
  if (reference.startsWith("PO-") || reference.startsWith("OPEN-")) return "/purchases"
  if (reference.startsWith("SWP-")) return "/swaps"
  return null
}

export function ItemActivityView({
  itemName,
  sku,
  showCost,
  moves,
  bills,
  sales,
  prices,
  units,
  returns,
}: {
  itemName: string
  sku: string
  showCost: boolean
  moves: Move[]
  bills: Bill[]
  sales: Sale[]
  prices: Price[]
  units: Unit[]
  returns: ReturnRow[]
}) {
  const [tab, setTab] = useState<Tab>("moves")
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()

  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: "moves", label: "Every stock movement", count: moves.length },
    { key: "bills", label: "Booked in", count: bills.length },
    { key: "sales", label: "Sales", count: sales.length },
    { key: "returns", label: "Returns", count: returns.length },
    ...(units.length ? [{ key: "units" as Tab, label: "Phones", count: units.length }] : []),
    { key: "prices", label: "Price changes", count: prices.length },
  ]

  const shown = useMemo(() => {
    const has = (...parts: Array<string | number | null | undefined>) =>
      !needle || parts.some((part) => String(part ?? "").toLowerCase().includes(needle))
    return {
      moves: moves.filter((row) => has(moveWords(row.kind), row.reference, row.shop, row.by)),
      bills: bills.filter((row) => has(row.invoice, row.supplier, row.shop)),
      sales: sales.filter((row) => has(row.invoice, row.customer, row.shop, row.seller, row.imei?.imei1)),
      units: units.filter((row) => has(row.imei1, row.serial, row.status, row.shop)),
      returns: returns.filter((row) => has(row.number, row.customer, row.shop, row.reason, row.outcome, row.imei?.imei1)),
      prices: prices.filter((row) => has(PRICE_WORDS[row.type] ?? row.type, row.reason, row.by)),
    }
  }, [moves, bills, sales, units, prices, returns, needle])

  function download(format: "csv" | "xlsx") {
    const when = (date: Date) => formatShopWhen(date)
    const sheets: Record<Tab, Array<Array<string | number>>> = {
      moves: [
        ["When", "What happened", "Qty", "Shop", "Paper", "By"],
        ...shown.moves.map((row) => [when(row.when), moveWords(row.kind), row.quantity, row.shop, row.reference ?? "", row.by]),
      ],
      bills: [
        ["When", "Bill", "Kind", "Supplier", "Shop", "Qty", ...(showCost ? ["Unit cost"] : [])],
        ...shown.bills.map((row) => [
          when(row.when),
          row.invoice,
          row.opening ? "Opening stock" : "Supplier bill",
          row.supplier,
          row.shop,
          row.quantity,
          ...(showCost ? [row.cost ?? 0] : []),
        ]),
      ],
      sales: [
        ["When", "Invoice", "Shop", "Customer", "Sold by", "IMEI", "Qty", "Unit price", "Line total"],
        ...shown.sales.map((row) => [when(row.when), row.invoice, row.shop, row.customer, row.seller, row.imei?.imei1 ?? "", row.quantity, row.unitPrice, row.total]),
      ],
      returns: [
        ["When", "Return", "Shop", "Customer", "IMEI", "Reason", "Outcome", "Where it went", "Status", "Value"],
        ...shown.returns.map((row) => [
          when(row.when),
          row.number,
          row.shop,
          row.customer,
          row.imei?.imei1 ?? "",
          row.reason.replace(/_/g, " ").toLowerCase(),
          row.outcome.replace(/_/g, " ").toLowerCase(),
          row.status === "COMPLETED" ? SHELF_WORDS[row.faultClass] ?? row.faultClass : "Not applied yet",
          row.status,
          row.value,
        ]),
      ],
      units: [
        ["IMEI", "Serial", "Status", "Shop", "Booked in", "Last change"],
        ...shown.units.map((row) => [row.imei1, row.serial ?? "", row.status, row.shop, when(row.booked), when(row.changed)]),
      ],
      prices: [
        ["When", "Price", "From", "To", "By", "Why"],
        ...shown.prices.map((row) => [when(row.when), PRICE_WORDS[row.type] ?? row.type, row.from, row.to, row.by, row.reason ?? ""]),
      ],
    }
    const stamp = watDayKey()
    void downloadTable(sheets[tab], `item-activity-${sku}-${tab}-${stamp}.${format}`, format)
  }

  const empty = (text: string) => <p className="px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>
  const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
  const td = "px-3 py-2 align-top"

  return (
    <div className="surface-card space-y-4 p-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={`History of ${itemName}`}>
        {tabs.map((row) => (
          <button
            key={row.key}
            type="button"
            role="tab"
            aria-selected={tab === row.key}
            onClick={() => setTab(row.key)}
            className={cn(
              "rounded-full px-3 py-1.5 text-sm font-medium transition",
              tab === row.key ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-muted/70"
            )}
          >
            {row.label} <span className="tabular-nums opacity-75">{row.count}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search this list: invoice, shop, customer, IMEI, who"
          className="h-10 min-w-0 flex-1"
          aria-label="Search this list"
        />
        <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => download("xlsx")}>
          <FileSpreadsheet className="h-4 w-4 sm:mr-1.5" />
          <span className="hidden sm:inline">Excel</span>
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-10" onClick={() => download("csv")}>
          <Download className="h-4 w-4 sm:mr-1.5" />
          <span className="hidden sm:inline">CSV</span>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        {tab === "moves" ? (
          shown.moves.length ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>What happened</th>
                  <th className={cn(th, "text-right")}>Qty</th>
                  <th className={th}>Shop</th>
                  <th className={th}>Paper</th>
                  <th className={th}>By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.moves.map((row) => {
                  const href = referenceHref(row.reference)
                  return (
                    <tr key={row.id}>
                      <td className={cn(td, "whitespace-nowrap tabular-nums")}>{formatShopWhen(row.when)}</td>
                      <td className={td}>{moveWords(row.kind)}</td>
                      <td className={cn(td, "text-right font-semibold tabular-nums", row.quantity > 0 ? "text-success" : "text-danger")}>
                        {row.quantity > 0 ? "+" : "−"}
                        {Math.abs(row.quantity)}
                      </td>
                      <td className={td}>{row.shop}</td>
                      <td className={cn(td, "font-mono text-xs")}>
                        {href ? (
                          <Link href={href} className="text-primary hover:underline">
                            {row.reference}
                          </Link>
                        ) : (
                          row.reference ?? "-"
                        )}
                      </td>
                      <td className={td}>{row.by}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            empty("No stock movement recorded for this item yet. Stock already on the shelf before the movement record began shows under Booked in.")
          )
        ) : null}

        {tab === "bills" ? (
          shown.bills.length ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Bill</th>
                  <th className={th}>Supplier</th>
                  <th className={th}>Shop</th>
                  <th className={cn(th, "text-right")}>Qty</th>
                  {showCost ? <th className={cn(th, "text-right")}>Unit cost</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.bills.map((row) => (
                  <tr key={row.id}>
                    <td className={cn(td, "whitespace-nowrap tabular-nums")}>{formatShopWhen(row.when)}</td>
                    <td className={td}>
                      <Link href={`/purchases/${row.purchaseId}`} className="font-mono text-xs text-primary hover:underline">
                        {row.invoice}
                      </Link>
                      {row.opening ? <span className="block text-xs text-muted-foreground">Opening stock</span> : null}
                    </td>
                    <td className={td}>{row.supplier}</td>
                    <td className={td}>{row.shop}</td>
                    <td className={cn(td, "text-right font-semibold tabular-nums")}>{row.quantity}</td>
                    {showCost ? <td className={cn(td, "text-right tabular-nums")}>{formatCurrency(row.cost ?? 0)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            empty("Nothing booked in for this item yet.")
          )
        ) : null}

        {tab === "sales" ? (
          shown.sales.length ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Invoice</th>
                  <th className={th}>Shop</th>
                  <th className={th}>Customer</th>
                  <th className={th}>IMEI</th>
                  <th className={cn(th, "text-right")}>Qty</th>
                  <th className={cn(th, "text-right")}>Price</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.sales.map((row) => (
                  <tr key={row.id}>
                    <td className={cn(td, "whitespace-nowrap tabular-nums")}>{formatShopWhen(row.when)}</td>
                    <td className={td}>
                      <Link href={`/sales/${row.saleId}`} className="font-mono text-xs text-primary hover:underline">
                        {row.invoice}
                      </Link>
                      {row.seller ? <span className="block text-xs text-muted-foreground">by {row.seller}</span> : null}
                    </td>
                    <td className={td}>{row.shop}</td>
                    <td className={td}>{row.customer}</td>
                    <td className={cn(td, "font-mono text-xs")}>
                      {row.imei ? (
                        <Link href={`/imei/${row.imei.id}`} className="text-primary hover:underline">
                          {row.imei.imei1}
                        </Link>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className={cn(td, "text-right font-semibold tabular-nums")}>{row.quantity}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{formatCurrency(row.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            empty("This item has not been sold yet.")
          )
        ) : null}

        {tab === "returns" ? (
          shown.returns.length ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Return</th>
                  <th className={th}>Shop</th>
                  <th className={th}>Customer</th>
                  <th className={th}>IMEI</th>
                  <th className={th}>Outcome</th>
                  <th className={th}>Where it went</th>
                  <th className={cn(th, "text-right")}>Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.returns.map((row) => (
                  <tr key={row.id}>
                    <td className={cn(td, "whitespace-nowrap tabular-nums")}>{formatShopWhen(row.when)}</td>
                    <td className={td}>
                      <Link href="/returns" className="font-mono text-xs text-primary hover:underline">
                        {row.number}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{row.reason.replace(/_/g, " ").toLowerCase()}</span>
                    </td>
                    <td className={td}>{row.shop}</td>
                    <td className={td}>{row.customer || "-"}</td>
                    <td className={cn(td, "font-mono text-xs")}>
                      {row.imei ? (
                        <Link href={`/imei/${row.imei.id}`} className="text-primary hover:underline">
                          {row.imei.imei1}
                        </Link>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className={td}>{row.outcome.replace(/_/g, " ").toLowerCase()}</td>
                    <td className={cn(td, row.status !== "COMPLETED" ? "text-warning" : row.backOnShelf ? "text-success" : "text-warning")}>
                      {row.status !== "COMPLETED" ? "Not applied yet: finish it on Returns" : SHELF_WORDS[row.faultClass] ?? row.faultClass}
                    </td>
                    <td className={cn(td, "text-right tabular-nums")}>{formatCurrency(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            empty("This item has not been returned.")
          )
        ) : null}

        {tab === "units" ? (
          shown.units.length ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className={th}>IMEI or serial</th>
                  <th className={th}>Status</th>
                  <th className={th}>Shop</th>
                  <th className={th}>Booked in</th>
                  <th className={th}>Last change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.units.map((row) => (
                  <tr key={row.id}>
                    <td className={td}>
                      <Link href={`/imei/${row.id}`} className="font-mono text-xs text-primary hover:underline">
                        {row.imei1}
                      </Link>
                      {row.serial && row.serial !== row.imei1 ? (
                        <span className="block font-mono text-xs text-muted-foreground">Serial {row.serial}</span>
                      ) : null}
                    </td>
                    <td className={td}>
                      <StatusBadge value={row.status} />
                    </td>
                    <td className={td}>{row.shop}</td>
                    <td className={cn(td, "whitespace-nowrap tabular-nums")}>{formatShopWhen(row.booked)}</td>
                    <td className={cn(td, "whitespace-nowrap tabular-nums")}>{formatShopWhen(row.changed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            empty("No phone matches this search.")
          )
        ) : null}

        {tab === "prices" ? (
          shown.prices.length ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/60">
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Price</th>
                  <th className={cn(th, "text-right")}>From</th>
                  <th className={cn(th, "text-right")}>To</th>
                  <th className={th}>By</th>
                  <th className={th}>Why</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.prices.map((row) => (
                  <tr key={row.id}>
                    <td className={cn(td, "whitespace-nowrap tabular-nums")}>{formatShopWhen(row.when)}</td>
                    <td className={td}>{PRICE_WORDS[row.type] ?? row.type}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{formatCurrency(row.from)}</td>
                    <td className={cn(td, "text-right font-semibold tabular-nums")}>{formatCurrency(row.to)}</td>
                    <td className={td}>{row.by || "-"}</td>
                    <td className={cn(td, "text-muted-foreground")}>{row.reason ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            empty("No price has been changed on this item.")
          )
        ) : null}
      </div>
    </div>
  )
}
