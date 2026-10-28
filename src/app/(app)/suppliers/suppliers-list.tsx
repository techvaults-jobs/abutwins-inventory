"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Coins, FileSpreadsheet, HandCoins, PackageCheck, Undo2, Wallet } from "lucide-react"
import { DataTable, type DataColumn } from "@/components/data-table"
import { FilterChips } from "@/components/filter-chips"
import { StatCard, StatGrid, StatusBadge, TonePill } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { downloadTable, downloadWorkbook } from "@/lib/download-table"
import { groupByPartyIdentity } from "@/lib/party-key"
import { watDayKey } from "@/lib/lagos-day"
import { formatCurrency, formatDate } from "@/lib/utils"
import { statusLabel } from "@/lib/status"
import {
  formatPurchaseBalanceCell,
  formatValueOwingMinus,
  formatValueOwingPlus,
  purchaseBalance,
} from "@/lib/purchase-money"

export type SupplierBillRow = {
  id: string
  invoiceNumber: string
  totalAmount: number
  paidAmount: number
  returnedAmount?: number
  shippingFee: number
  status: string
  createdAt: string
  branchCode: string
  branchName: string
}

/** Opening stock loaded under a supplier's name: a value, never money owed. */
export type OpeningBillRow = {
  id: string
  invoiceNumber: string
  totalAmount: number
  createdAt: string
  branchCode: string
  branchName: string
  units: number
}

export type SupplierRow = {
  id: string
  name: string
  kind: string
  phone: string
  city: string | null
  country: string | null
  purchases: SupplierBillRow[]
  openingBills?: OpeningBillRow[]
  /** Named for opening stock ("Opening Stock", "Opening Stock Adjustment"...). */
  isOpeningStock?: boolean
  /** Phones held under this opening stock name with no bill, at item cost. */
  unbilledOpening?: { units: number; value: number }
  creditBalance?: number
}

/** One opening stock name inside the Opening stock row, with what sits under it. */
type OpeningName = { id: string; name: string; loads: number; billValue: number; unbilledUnits: number; unbilledValue: number }

type HouseFilter = "all" | "bought" | "paid" | "owing" | "credit" | "opening"

type House = {
  key: string
  name: string
  kind: string
  phone: string
  from: string
  copies: SupplierRow[]
  bills: SupplierBillRow[]
  purchased: number
  paid: number
  sentBack: number
  extraCredit: number
  owed: number
  surplus: number
  /** Opening stock under this name: shown as a value, kept out of owed. */
  openingBills: OpeningBillRow[]
  openingValue: number
  /** Every opening stock name in this row, each with its own value. */
  openingNames: OpeningName[]
  openHref: string
}

function buildHouses(suppliers: SupplierRow[]): House[] {
  // Each opening stock name keeps its own row ("Opening Stock", "OPENING
  // STOCK (FAULTY)", "Opening Stock Adjustment"), listed together first, and
  // is never merged with a real supplier through a shared phone number.
  const opening = suppliers.filter((row) => row.isOpeningStock)
  const real = suppliers.filter((row) => !row.isOpeningStock)
  const groups = [...groupByPartyIdentity(real), ...opening.map((row) => [row])]
  return groups
    .map((copies) => {
      const ranked = [...copies].sort((a, b) => {
        const aValue = a.purchases.reduce((sum, row) => sum + row.totalAmount, 0)
        const bValue = b.purchases.reduce((sum, row) => sum + row.totalAmount, 0)
        if (bValue !== aValue) return bValue - aValue
        return b.purchases.length - a.purchases.length
      })
      const primary = ranked[0]
      const bills = copies
        .flatMap((copy) => copy.purchases)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      const purchased = bills.reduce((sum, row) => sum + row.totalAmount, 0)
      const openingBills = copies
        .flatMap((copy) => copy.openingBills ?? [])
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      const unbilledValue = copies.reduce((sum, copy) => sum + (copy.unbilledOpening?.value ?? 0), 0)
      const openingValue = openingBills.reduce((sum, row) => sum + row.totalAmount, 0) + unbilledValue
      const isOpeningRow = copies.every((copy) => copy.isOpeningStock)
      const openingNames: OpeningName[] = isOpeningRow
        ? copies
            .map((copy) => ({
              id: copy.id,
              name: copy.name,
              loads: copy.openingBills?.length ?? 0,
              billValue: (copy.openingBills ?? []).reduce((sum, bill) => sum + bill.totalAmount, 0),
              unbilledUnits: copy.unbilledOpening?.units ?? 0,
              unbilledValue: copy.unbilledOpening?.value ?? 0,
            }))
            .sort((a, b) => b.billValue + b.unbilledValue - (a.billValue + a.unbilledValue))
        : []
      const paid = bills.reduce((sum, row) => sum + row.paidAmount, 0)
      const sentBack = bills.reduce((sum, row) => sum + (row.returnedAmount ?? 0), 0)
      const extraCredit = copies.reduce((sum, copy) => sum + (copy.creditBalance ?? 0), 0)
      let net = 0
      for (const bill of bills) {
        const bal = purchaseBalance(bill)
        net += bal.remaining - bal.paid
      }
      net -= extraCredit
      const from =
        copies
          .map((copy) => [copy.city, copy.country].filter(Boolean).join(", "))
          .find((place) => place) || "Not recorded"
      return {
        key: primary.id,
        name: primary.name,
        kind: primary.kind,
        phone: primary.phone,
        from,
        copies: ranked,
        bills,
        purchased,
        paid,
        sentBack,
        extraCredit,
        owed: Math.max(0, net),
        surplus: Math.max(0, -net),
        openingBills,
        openingValue,
        openingNames,
        openHref: `/suppliers/${primary.id}`,
      }
    })
    // Opening stock names first, together, then every supplier A to Z.
    .sort((a, b) => Number(b.openingNames.length > 0) - Number(a.openingNames.length > 0) || a.name.localeCompare(b.name))
}

function houseSearchText(house: House) {
  return [house.name, house.phone, house.from, ...house.copies.map((copy) => copy.name), ...house.bills.map((bill) => bill.invoiceNumber)].join(" ")
}

const FILTER_NAMES: Record<HouseFilter, string> = {
  all: "every-supplier",
  bought: "bought-from",
  paid: "paid",
  owing: "we-owe",
  credit: "they-owe-us",
  opening: "opening-stock",
}

function houseKind(house: House) {
  if (house.openingNames.length) return "Opening stock"
  return house.kind === "NEIGHBOR" ? "Neighbouring shop" : "Carton supplier"
}

function houseStatus(house: House) {
  if (house.openingValue > 0 && house.bills.length === 0 && house.surplus <= 0) return "Opening stock · not owed"
  if (house.surplus > 0) return "They owe us"
  if (house.owed === 0) return "Settled"
  return "We owe"
}

/**
 * The suppliers on screen as a sheet. The client could not take the supplier
 * accounts to Excel. Plain numbers, not "₦1.2m", so the columns add up in
 * Excel; the chip and the search on screen decide which suppliers go in.
 */
function supplierSheet(houses: House[]): Array<Array<string | number>> {
  const sum = (pick: (house: House) => number) => houses.reduce((total, house) => total + pick(house), 0)
  return [
    ["Supplier", "Type", "Phone", "From", "Bills", "Bought (₦)", "Opening stock value (₦)", "Paid (₦)", "Sent back (₦)", "We owe (₦)", "They owe us (₦)", "Status"],
    ...houses.map((house) => [
      house.name,
      houseKind(house),
      house.openingNames.length ? "" : house.phone,
      house.from,
      house.bills.length,
      house.purchased,
      house.openingValue,
      house.paid,
      house.sentBack,
      house.owed,
      house.surplus,
      houseStatus(house),
    ]),
    [
      `Total (${houses.length} supplier${houses.length === 1 ? "" : "s"})`,
      "",
      "",
      "",
      sum((house) => house.bills.length),
      sum((house) => house.purchased),
      sum((house) => house.openingValue),
      sum((house) => house.paid),
      sum((house) => house.sentBack),
      sum((house) => house.owed),
      sum((house) => house.surplus),
      "",
    ],
  ]
}

/** Every bill behind those suppliers, one line each, as on the supplier page. */
function billSheet(houses: House[]): Array<Array<string | number>> {
  return [
    ["Supplier", "Bill number", "Date", "Shop", "Uploaded value (₦)", "Shipping fee (₦)", "Payable value (₦)", "Paid (₦)", "Sent back (₦)", "We owe (₦)", "They owe us (₦)", "Status"],
    ...houses.flatMap((house) => [
      ...house.bills.map((bill) => {
        const bal = purchaseBalance(bill)
        return [
          house.name,
          bill.invoiceNumber,
          watDayKey(new Date(bill.createdAt)),
          bill.branchName || bill.branchCode,
          bal.billed,
          bal.shipping,
          bal.payable,
          bal.paid,
          bal.sentBack,
          bal.owed,
          bal.surplus,
          statusLabel(bill.status),
        ]
      }),
      ...house.openingBills.map((bill) => [
        house.name,
        bill.invoiceNumber,
        watDayKey(new Date(bill.createdAt)),
        bill.branchName || bill.branchCode,
        bill.totalAmount,
        0,
        0,
        0,
        0,
        0,
        0,
        "Opening stock · not owed",
      ]),
    ]),
  ]
}

export function SuppliersList({ suppliers }: { suppliers: SupplierRow[] }) {
  const houses = useMemo(() => buildHouses(suppliers), [suppliers])
  const [filter, setFilter] = useState<HouseFilter>("all")
  const [open, setOpen] = useState<House | null>(null)
  const [query, setQuery] = useState("")

  const totalInvoiced = houses.reduce((sum, house) => sum + house.purchased, 0)
  const totalPaid = houses.reduce((sum, house) => sum + house.paid, 0)
  const totalOwed = houses.reduce((sum, house) => sum + house.owed, 0)
  const totalSurplus = houses.reduce((sum, house) => sum + house.surplus, 0)
  const owingCount = houses.filter((house) => house.owed > 0).length
  const totalOpening = houses.reduce((sum, house) => sum + house.openingValue, 0)
  const openingCount = houses.filter((house) => house.openingValue > 0).length

  const filtered = useMemo(() => {
    return houses.filter((house) => {
      if (filter === "bought") return house.purchased > 0
      if (filter === "paid") return house.paid > 0
      if (filter === "owing") return house.owed > 0
      if (filter === "credit") return house.surplus > 0
      if (filter === "opening") return house.openingValue > 0
      return true
    })
  }, [houses, filter])

  // What the table shows after the chip and the search, so the file matches the screen.
  function shownHouses() {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return filtered
    return filtered.filter((house) => {
      const hay = houseSearchText(house).toLowerCase()
      return words.every((word) => hay.includes(word))
    })
  }
  const fileName = () => `suppliers-${FILTER_NAMES[filter]}-${watDayKey()}`

  function pickFilter(next: HouseFilter) {
    setFilter(next)
    requestAnimationFrame(() => {
      document.getElementById("supplier-houses")?.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }

  const columns: DataColumn<House>[] = [
    {
      id: "name",
      header: "Supplier",
      sortValue: (house) => house.name,
      cell: (house) => (
        <div>
          <p className="font-medium">{house.name}</p>
          <p className="text-xs text-muted-foreground">
            {house.openingNames.length
              ? "Opening stock · starting stock value, not owed"
              : `${house.kind === "NEIGHBOR" ? "Neighbouring shop" : "Carton supplier"} · ${house.phone}${house.copies.length > 1 ? ` · ${house.copies.length} copies` : ""}`}
          </p>
        </div>
      ),
    },
    { id: "from", header: "From", hideBelow: "xl", sortValue: (house) => house.from, cell: (house) => <span className="text-muted-foreground">{house.from}</span> },
    { id: "bills", header: "Bills", align: "right", hideBelow: "lg", sortValue: (house) => house.bills.length, cell: (house) => house.bills.length },
    {
      id: "bought",
      header: "Bought",
      align: "right",
      sortValue: (house) => house.purchased + house.openingValue,
      cell: (house) => (
        <div>
          <span className="font-medium">{formatCurrency(house.purchased)}</span>
          {house.openingValue > 0 ? (
            <p className="whitespace-nowrap text-xs text-muted-foreground">
              Opening stock {formatCurrency(house.openingValue)}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      id: "paid",
      header: "Paid",
      align: "right",
      hideBelow: "lg",
      sortValue: (house) => house.paid,
      cell: (house) => <span className="text-success">{formatCurrency(house.paid)}</span>,
    },
    {
      id: "balance",
      header: "Balance",
      align: "right",
      sortValue: (house) => house.surplus - house.owed,
      cell: (house) => <HouseBalance house={house} />,
    },
  ]

  return (
    <div className="space-y-5">
      <StatGrid>
        <StatCard
          label="Bought, all time"
          value={formatCurrency(totalInvoiced)}
          icon={<Coins className="h-4 w-4" />}
          tone="primary"
          onClick={() => pickFilter("bought")}
        />
        <StatCard
          label="Paid"
          value={formatCurrency(totalPaid)}
          icon={<HandCoins className="h-4 w-4" />}
          tone="success"
          onClick={() => pickFilter("paid")}
        />
        <StatCard
          label="We owe"
          value={formatValueOwingMinus(totalOwed)}
          hint={owingCount > 0 ? `${owingCount} supplier${owingCount === 1 ? "" : "s"}` : undefined}
          icon={<Wallet className="h-4 w-4" />}
          tone={totalOwed > 0 ? "warning" : "neutral"}
          onClick={() => pickFilter("owing")}
        />
        <StatCard
          label="They owe us"
          value={formatValueOwingPlus(totalSurplus)}
          icon={<Undo2 className="h-4 w-4" />}
          tone={totalSurplus > 0 ? "success" : "neutral"}
          onClick={() => pickFilter("credit")}
        />
        {totalOpening > 0 ? (
          <StatCard
            label="Opening stock value"
            value={formatCurrency(totalOpening)}
            hint="Stock on the shelf at the start · not owed"
            icon={<PackageCheck className="h-4 w-4" />}
            onClick={() => pickFilter("opening")}
          />
        ) : null}
      </StatGrid>

      <div id="supplier-houses" className="scroll-mt-20">
        <DataTable
          rows={filtered}
          columns={columns}
          rowKey={(house) => house.key}
          noun="suppliers"
          filterKey={filter}
          onRowClick={setOpen}
          searchText={houseSearchText}
          searchPlaceholder="Search supplier, phone, place or bill number"
          query={query}
          onQueryChange={setQuery}
          actions={
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const shown = shownHouses()
                  void downloadWorkbook(
                    [
                      { name: "Suppliers", rows: supplierSheet(shown) },
                      { name: "Bills", rows: billSheet(shown) },
                    ],
                    `${fileName()}.xlsx`
                  )
                }}
              >
                <FileSpreadsheet className="mr-1.5 h-4 w-4" aria-hidden /> Excel
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void downloadTable(supplierSheet(shownHouses()), `${fileName()}.csv`, "csv")}
              >
                CSV
              </Button>
            </>
          }
          filters={
            <FilterChips
              label="Show"
              activeKey={filter}
              onSelect={(key) => setFilter(key as HouseFilter)}
              chips={[
                { key: "all", label: "Every supplier", count: houses.length },
                { key: "owing", label: "We owe", count: houses.filter((house) => house.owed > 0).length, tone: "warning" },
                { key: "credit", label: "They owe us", count: houses.filter((house) => house.surplus > 0).length, tone: "success" },
                { key: "bought", label: "Bought from", count: houses.filter((house) => house.purchased > 0).length },
                { key: "paid", label: "Paid", count: houses.filter((house) => house.paid > 0).length },
                ...(openingCount > 0 ? [{ key: "opening", label: "Opening stock", count: openingCount }] : []),
              ]}
            />
          }
          card={(house) => ({
            title: house.name,
            subtitle: house.openingNames.length
              ? "Opening stock · not owed"
              : `${house.phone} · ${house.bills.length} bill${house.bills.length === 1 ? "" : "s"}${
                  house.openingValue > 0 ? ` · opening stock ${formatCurrency(house.openingValue)}` : ""
                }`,
            value: formatCurrency(house.bills.length || !house.openingValue ? house.purchased : house.openingValue),
            valueHint: <HouseBalance house={house} />,
          })}
          empty={houses.length === 0 ? "No suppliers on the books yet. Add one with the form." : "No supplier matches this filter."}
        />
      </div>

      <Sheet open={Boolean(open)} onOpenChange={(value) => !value && setOpen(null)}>
        {open ? (
          <SheetContent
            title={open.name}
            description={`${open.kind === "NEIGHBOR" ? "Neighbouring shop" : "Carton supplier"} · ${open.phone} · ${open.from}`}
            className="sm:w-[560px]"
            footer={
              <Button asChild className="w-full">
                <Link href={open.openHref}>Open the full supplier page</Link>
              </Button>
            }
          >
            <HouseBreakdown house={open} />
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  )
}

function HouseBalance({ house }: { house: House }) {
  // Opening stock only: the shop's starting value, nothing to settle.
  if (house.openingValue > 0 && house.bills.length === 0 && house.surplus <= 0) {
    return <TonePill tone="neutral">Opening stock · not owed</TonePill>
  }
  if (house.surplus > 0) return <TonePill tone="success">{formatValueOwingPlus(house.surplus)}</TonePill>
  if (house.owed === 0) return <TonePill tone="success">Settled</TonePill>
  return <TonePill tone="warning">{formatValueOwingMinus(house.owed)}</TonePill>
}

function HouseBreakdown({ house }: { house: House }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/60 p-3 text-center">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Bought</p>
          <p className="font-semibold tabular-nums">{formatCurrency(house.purchased)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Paid</p>
          <p className="font-semibold tabular-nums text-success">{formatCurrency(house.paid)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Balance</p>
          <p className="font-semibold tabular-nums">{formatPurchaseBalanceCell(house.owed, house.surplus)}</p>
        </div>
      </div>

      {house.openingBills.length ? (
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Opening stock</p>
            <p className="text-sm font-semibold tabular-nums">{formatCurrency(house.openingValue)}</p>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            Stock already on the shelf when the shops started on the software. Its value is shown here, and it is not
            money we owe.
          </p>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {house.openingBills.map((bill) => (
              <li key={bill.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <Link href={`/purchases/${bill.id}`} className="font-medium text-primary hover:underline">
                    {bill.invoiceNumber}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(bill.createdAt)} · {bill.branchName || bill.branchCode || "Shop not recorded"}
                    {bill.units ? ` · ${bill.units} phone${bill.units === 1 ? "" : "s"}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-semibold tabular-nums">{formatCurrency(bill.totalAmount)}</p>
                  <p className="text-xs text-muted-foreground">Not owed</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {house.openingNames.length > 1 ? (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Names under opening stock
          </p>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {house.openingNames.map((row) => (
              <li key={row.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <Link href={`/suppliers/${row.id}`} className="font-medium text-primary hover:underline">
                    {row.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {row.loads} load{row.loads === 1 ? "" : "s"}
                    {row.unbilledUnits
                      ? ` · ${row.unbilledUnits} phone${row.unbilledUnits === 1 ? "" : "s"} added without a bill`
                      : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-semibold tabular-nums">{formatCurrency(row.billValue + row.unbilledValue)}</p>
                  <p className="text-xs text-muted-foreground">Not owed</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {house.copies.length > 1 && !house.openingNames.length ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            This supplier was saved more than once. New copies are refused. Use one name going forward.
          </p>
          <ul className="space-y-1 text-sm">
            {house.copies.map((copy) => (
              <li key={copy.id} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span>
                  {copy.name} · {copy.phone}
                </span>
                <Link href={`/suppliers/${copy.id}`} className="font-medium text-primary hover:underline">
                  Open this copy
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {house.bills.length} bill{house.bills.length === 1 ? "" : "s"}
        </p>
        {house.bills.length ? (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {house.bills.map((bill) => {
              const bal = purchaseBalance(bill)
              return (
                <li key={bill.id} className="px-3 py-2.5 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/purchases/${bill.id}`} className="font-medium text-primary hover:underline">
                        {bill.invoiceNumber}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(bill.createdAt)} · {bill.branchName || bill.branchCode || "Shop not recorded"}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-semibold tabular-nums">{formatCurrency(bill.totalAmount)}</p>
                      <p className="text-xs tabular-nums">{formatPurchaseBalanceCell(bal.owed, bal.surplus)}</p>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <StatusBadge value={bill.status} />
                    <span className="tabular-nums">Paid {formatCurrency(bill.paidAmount)}</span>
                    {bal.shipping > 0 ? (
                      <span className="tabular-nums">
                        · Shipping fee {formatCurrency(bal.shipping)} · Payable {formatCurrency(bal.payable)}
                      </span>
                    ) : null}
                    {bal.sentBack > 0 ? <span className="tabular-nums">· Sent back {formatCurrency(bal.sentBack)}</span> : null}
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {house.openingBills.length ? "No supplier bill. Only opening stock is loaded under this name." : "No supplier bill yet."}
          </p>
        )}
      </div>
      {house.extraCredit > 0 ? (
        <p className="text-sm text-muted-foreground">
          Extra send-back credit not on a bill: {formatCurrency(house.extraCredit)}.
        </p>
      ) : null}
    </div>
  )
}
