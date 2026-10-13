"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { DataTable, type DataColumn } from "@/components/data-table"
import { FilterChips } from "@/components/filter-chips"
import { EmptyState, StatusBadge } from "@/components/shared"
import { formatShopWhen } from "@/lib/lagos-day"
import { cn, formatCurrency } from "@/lib/utils"

export type PurchaseRow = {
  id: string
  invoiceNumber: string
  status: string
  isOpening: boolean
  supplier: string
  origin: string
  shop: string
  item: string
  itemCount: number
  expectedDate: string | null
  when: string
  received: boolean
  total: number
  /** Shipping fee inside the value, not owed to the supplier. */
  shipping: number
  /** Value sent back to the supplier on this bill. */
  sentBack: number
  paid: number
  owed: number
  surplus: number
  comingLots: number
  trace: { expected: number; recorded: number; sold: number; soldToday: number; inShop: number; shortVsBill: number }
}

const STATUS_CHIPS = [
  { key: "all", label: "All bills" },
  { key: "RECEIVED", label: "Received", tone: "success" as const },
  { key: "PARTIAL_RECEIVED", label: "Part received", tone: "warning" as const },
  { key: "PENDING", label: "Waiting", tone: "warning" as const },
  { key: "ORDERED", label: "Ordered", tone: "primary" as const },
  { key: "CANCELLED", label: "Cancelled", tone: "danger" as const },
]

function Owing({ row }: { row: PurchaseRow }) {
  if (row.isOpening) return <span className="text-xs text-muted-foreground">Value only</span>
  if (row.surplus > 0) return <span className="font-semibold text-success">+{formatCurrency(row.surplus)}</span>
  if (row.owed > 0) return <span className="font-semibold text-warning">-{formatCurrency(row.owed)}</span>
  return <span className="text-success">Settled</span>
}

export function PurchasesList({ purchases, search }: { purchases: PurchaseRow[]; search?: string }) {
  const router = useRouter()
  const [status, setStatus] = useState("all")

  const filtered = useMemo(
    () => purchases.filter((row) => (status === "all" ? true : row.status === status)),
    [purchases, status]
  )
  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { all: purchases.length }
    for (const row of purchases) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    return byStatus
  }, [purchases])

  if (purchases.length === 0) {
    return (
      <EmptyState
        title={search?.trim() ? "No supplier bill matches that search" : "No supplier goods booked yet"}
        hint={
          search?.trim()
            ? "Try another IMEI, or clear the search."
            : "Use the form to book goods from China, Dubai, Lagos, or any supplier you have named."
        }
      />
    )
  }

  const columns: DataColumn<PurchaseRow>[] = [
    {
      id: "bill",
      header: "Bill",
      sortValue: (row) => row.invoiceNumber,
      cell: (row) => (
        <div>
          <div className="flex items-center gap-2">
            <Link href={`/purchases/${row.id}`} className="whitespace-nowrap font-medium text-primary hover:underline">
              {row.invoiceNumber}
            </Link>
            {row.isOpening ? (
              <span className="rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold text-primary">Opening stock</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {row.isOpening ? "Opening count" : row.supplier}
            {row.origin && !row.isOpening ? ` · ${row.origin}` : ""} · {row.shop}
          </p>
        </div>
      ),
    },
    {
      id: "goods",
      header: "Goods",
      hideBelow: "xl",
      cell: (row) => (
        <div className="text-xs">
          <p className="font-medium text-foreground">
            {row.item}
            {row.itemCount > 1 ? ` +${row.itemCount - 1} more` : ""}
          </p>
          <p className="tabular-nums text-muted-foreground">
            {row.trace.expected} on bill · {row.trace.recorded} in · {row.trace.sold} sold · {row.trace.inShop} on shelf
          </p>
          {row.trace.shortVsBill > 0 ? (
            <p className="text-warning">{row.trace.shortVsBill} never scanned in</p>
          ) : null}
          {row.comingLots ? <p className="text-warning">{row.comingLots} carton list still coming</p> : null}
        </div>
      ),
    },
    {
      id: "value",
      header: "Value",
      align: "right",
      sortValue: (row) => row.total,
      cell: (row) => <span className="font-medium">{formatCurrency(row.total)}</span>,
    },
    {
      id: "shipping",
      header: "Shipping fee",
      align: "right",
      hideBelow: "lg",
      sortValue: (row) => row.shipping,
      cell: (row) =>
        row.shipping > 0 ? (
          <span className="font-medium">−{formatCurrency(row.shipping)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "sentBack",
      header: "Sent back",
      align: "right",
      hideBelow: "lg",
      sortValue: (row) => row.sentBack,
      cell: (row) =>
        row.sentBack > 0 ? (
          <span className="font-medium text-warning">−{formatCurrency(row.sentBack)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "paid",
      header: "Paid",
      align: "right",
      hideBelow: "lg",
      sortValue: (row) => row.paid,
      cell: (row) => (row.isOpening ? <span className="text-muted-foreground">—</span> : <span className="text-success">{formatCurrency(row.paid)}</span>),
    },
    {
      id: "owing",
      header: "Owing",
      align: "right",
      sortValue: (row) => row.surplus - row.owed,
      cell: (row) => <Owing row={row} />,
    },
    {
      id: "status",
      header: "Status",
      hideBelow: "lg",
      sortValue: (row) => row.status,
      cell: (row) => (
        <div className="whitespace-nowrap">
          <StatusBadge value={row.status} />
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
            {row.received ? "Received" : "Booked"} {formatShopWhen(row.when)}
          </p>
        </div>
      ),
    },
  ]

  return (
    <DataTable
      rows={filtered}
      columns={columns}
      rowKey={(row) => row.id}
      noun="bills"
      filterKey={status}
      onRowClick={(row) => router.push(`/purchases/${row.id}`)}
      searchText={(row) => [row.invoiceNumber, row.supplier, row.origin, row.shop, row.item].join(" ")}
      searchPlaceholder="Filter by bill, supplier, place or item"
      filters={
        <FilterChips
          label="Bill status"
          activeKey={status}
          onSelect={setStatus}
          chips={STATUS_CHIPS.filter((chip) => chip.key === "all" || (counts[chip.key] ?? 0) > 0).map((chip) => ({
            ...chip,
            count: counts[chip.key] ?? 0,
          }))}
        />
      }
      card={(row) => ({
        title: row.isOpening ? `${row.invoiceNumber} · Opening stock` : row.supplier,
        subtitle: `${row.isOpening ? row.shop : row.invoiceNumber} · ${formatShopWhen(row.when)}`,
        value: formatCurrency(row.total),
        valueHint: <Owing row={row} />,
        badge: <StatusBadge value={row.status} />,
        meta: (
          <span className={cn(row.trace.shortVsBill > 0 && "text-warning")}>
            {row.trace.expected} on bill · {row.trace.inShop} on shelf
            {row.trace.shortVsBill > 0 ? ` · ${row.trace.shortVsBill} never scanned` : ""}
          </span>
        ),
      })}
      empty="No bill matches this filter."
    />
  )
}
