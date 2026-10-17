"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Undo2 } from "lucide-react"
import type { SupplierReturnRow } from "@/app/actions/supplier-returns"
import { undoSupplierSendBack } from "@/app/actions/ops"
import { ActionForm } from "@/components/action-form"
import { DayRangeFilter } from "@/components/day-range-filter"
import { FilterChips } from "@/components/filter-chips"
import {
  EmptyNote,
  ShopTag,
  StatCard,
  StatGrid,
  TableShell,
  TonePill,
} from "@/components/shared"
import { TableDownload } from "@/components/table-download"
import { Input } from "@/components/ui/input"
import { matchesDayRange, formatShopWhen } from "@/lib/lagos-day"
import { cn, formatCurrency } from "@/lib/utils"

type SourceFilter = "all" | "SEND_BACK" | "CUSTOMER_RETURN"

export function ReturnsHistoryView({ rows, canUndo = false }: { rows: SupplierReturnRow[]; canUndo?: boolean }) {
  const [source, setSource] = useState<SourceFilter>("all")
  const [range, setRange] = useState({ from: "", to: "" })
  const [supplierFilter, setSupplierFilter] = useState("all")

  /* ── Filtered rows ─────────────────────────────────── */
  const inRange = useMemo(
    () => rows.filter((row) => matchesDayRange(row.sentAt, range.from, range.to)),
    [rows, range]
  )

  const suppliers = useMemo(() => {
    const names = [...new Set(inRange.map((row) => row.supplier))].sort()
    return names
  }, [inRange])

  const filtered = useMemo(() => {
    let out = inRange
    if (source !== "all") out = out.filter((row) => row.source === source)
    if (supplierFilter !== "all") out = out.filter((row) => row.supplier === supplierFilter)
    return out
  }, [inRange, source, supplierFilter])

  /* ── Counts for chips ──────────────────────────────── */
  const counts = useMemo(() => ({
    all: inRange.length,
    SEND_BACK: inRange.filter((r) => r.source === "SEND_BACK").length,
    CUSTOMER_RETURN: inRange.filter((r) => r.source === "CUSTOMER_RETURN").length,
  }), [inRange])

  /* ── Aggregates ────────────────────────────────────── */
  const totalValue = filtered.reduce((sum, row) => sum + row.value, 0)
  const uniqueRTVs = new Set(filtered.map((row) => row.reference)).size
  const uniqueSuppliers = new Set(filtered.map((row) => row.supplier)).size

  /* ── By-supplier summary ───────────────────────────── */
  const bySupplier = useMemo(() => {
    const map = new Map<
      string,
      { supplier: string; units: number; value: number; sendBacks: Set<string>; shops: Set<string> }
    >()
    for (const row of filtered) {
      const entry = map.get(row.supplier) ?? {
        supplier: row.supplier,
        units: 0,
        value: 0,
        sendBacks: new Set<string>(),
        shops: new Set<string>(),
      }
      entry.units += 1
      entry.value += row.value
      entry.sendBacks.add(row.reference)
      entry.shops.add(row.shopCode)
      map.set(row.supplier, entry)
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }, [filtered])

  /* ── Excel export rows ─────────────────────────────── */
  function exportSummary() {
    return [
      ["Supplier", "Send-backs", "Units", "Value (₦)", "Shops"],
      ...bySupplier.map((row) => [
        row.supplier,
        row.sendBacks.size,
        row.units,
        row.value,
        [...row.shops].join(" "),
      ]),
      [],
      ["Total", uniqueRTVs, filtered.length, totalValue, ""],
    ]
  }

  function exportDetail() {
    return [
      ["Date", "Reference", "Supplier", "Shop", "Item", "IMEI / Serial", "Supplier bill", "Value (₦)", "Money effect", "Source", "Done by"],
      ...filtered.map((row) => [
        formatShopWhen(row.sentAt),
        row.reference,
        row.supplier,
        row.shop,
        row.item,
        row.imei,
        row.bill ?? "",
        row.value,
        row.effect,
        row.source === "CUSTOMER_RETURN" ? "From a customer return" : "Send back to supplier",
        row.by,
      ]),
    ]
  }

  return (
    <div className="space-y-5">

      {/* ── Filters ───────────────────────────────────── */}
      <div className="surface-card space-y-3 p-4">
        <div className="grid gap-3 lg:grid-cols-2">
          <FilterChips
            label="Source"
            activeKey={source}
            onSelect={(key) => setSource(key as SourceFilter)}
            chips={[
              { key: "all",             label: "All",              count: counts.all },
              { key: "SEND_BACK",       label: "Direct send-back", count: counts.SEND_BACK },
              { key: "CUSTOMER_RETURN", label: "Via customer return", count: counts.CUSTOMER_RETURN },
            ]}
          />
          <DayRangeFilter
            label="When it was sent back"
            from={range.from}
            to={range.to}
            onChange={setRange}
          />
        </div>

        {/* Supplier quick-filter */}
        {suppliers.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Supplier</span>
            <button
              type="button"
              onClick={() => setSupplierFilter("all")}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                supplierFilter === "all"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
              )}
            >
              All suppliers
            </button>
            {suppliers.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setSupplierFilter(name === supplierFilter ? "all" : name)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  supplierFilter === name
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                )}
              >
                {name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Stat cards ────────────────────────────────── */}
      <StatGrid className="xl:grid-cols-3">
        <StatCard
          lead
          label="Total value sent back"
          value={formatCurrency(totalValue)}
          hint={`${filtered.length} unit${filtered.length === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Send-backs"
          value={String(uniqueRTVs)}
          hint="Separate trips back to a supplier"
        />
        <StatCard
          label="Suppliers"
          value={String(uniqueSuppliers)}
          hint="Received goods back from us"
        />
      </StatGrid>

      {filtered.length === 0 ? (
        <div className="surface-card">
          <EmptyNote
            icon={Undo2}
            title="Nothing sent back in this period."
            hint="Change the date range or source filter to see earlier records."
          />
        </div>
      ) : (
        <>
          {/* ── By supplier summary ───────────────────── */}
          <TableShell
            caption={
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">By supplier</h3>
                  <p className="text-xs text-muted-foreground">{bySupplier.length} supplier{bySupplier.length === 1 ? "" : "s"} · click a row to filter the detail table</p>
                </div>
                <TableDownload filename="returns-to-suppliers-by-supplier" rows={exportSummary} />
              </div>
            }
            columns={[
              { label: "Supplier" },
              { label: "Send-backs", align: "right" },
              { label: "Units",      align: "right" },
              { label: "Value",      align: "right" },
              { label: "Shops",      className: "hidden sm:table-cell" },
            ]}
          >
            {bySupplier.map((row) => (
              <tr
                key={row.supplier}
                className={cn(
                  "cursor-pointer transition-colors hover:bg-muted/60",
                  supplierFilter === row.supplier && "bg-primary/5"
                )}
                onClick={() => setSupplierFilter(supplierFilter === row.supplier ? "all" : row.supplier)}
              >
                <td className="font-medium">{row.supplier}</td>
                <td className="text-right tabular-nums">{row.sendBacks.size}</td>
                <td className="text-right tabular-nums">{row.units}</td>
                <td className="text-right tabular-nums font-semibold">{formatCurrency(row.value)}</td>
                <td className="hidden sm:table-cell">
                  <span className="flex flex-wrap gap-1">
                    {[...row.shops].map((code) => (
                      <ShopTag key={code}>{code}</ShopTag>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
            <tr className="bg-muted/40 font-semibold">
              <td>Total</td>
              <td className="text-right tabular-nums">{uniqueRTVs}</td>
              <td className="text-right tabular-nums">{filtered.length}</td>
              <td className="text-right tabular-nums">{formatCurrency(totalValue)}</td>
              <td className="hidden sm:table-cell" />
            </tr>
          </TableShell>

          {/* ── Per-unit detail ───────────────────────── */}
          <TableShell
            caption={
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold">Every unit sent back</h3>
                  <p className="text-xs text-muted-foreground">{filtered.length} unit{filtered.length === 1 ? "" : "s"}</p>
                </div>
                <TableDownload filename="returns-to-suppliers-detail" rows={exportDetail} />
              </div>
            }
            columns={[
              { label: "Date" },
              { label: "Reference" },
              { label: "Supplier" },
              { label: "Item" },
              { label: "Shop",          className: "hidden md:table-cell" },
              { label: "Supplier bill", className: "hidden lg:table-cell" },
              { label: "Value",         align: "right" },
              { label: "Money",         className: "hidden lg:table-cell" },
              ...(canUndo ? [{ label: "Sent by mistake?" }] : []),
            ]}
          >
            {filtered.map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap">{formatShopWhen(row.sentAt)}</td>
                <td className="whitespace-nowrap">
                  <span className="font-mono text-xs">{row.reference}</span>
                  {row.source === "CUSTOMER_RETURN" ? (
                    <span className="mt-0.5 block">
                      <TonePill tone="info">Via customer return</TonePill>
                    </span>
                  ) : null}
                </td>
                <td className="font-medium">{row.supplier}</td>
                <td className="min-w-40">
                  <p className="font-medium">{row.item}</p>
                  <p className="font-mono text-xs text-muted-foreground">{row.imei}</p>
                </td>
                <td className="hidden md:table-cell">
                  <ShopTag>{row.shopCode}</ShopTag>
                </td>
                <td className="hidden font-mono text-xs lg:table-cell">
                  {row.bill ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="text-right tabular-nums font-semibold">{formatCurrency(row.value)}</td>
                <td className="hidden text-xs text-muted-foreground lg:table-cell">{row.effect}</td>
                {canUndo ? (
                  <td className="min-w-48">
                    {row.source === "SEND_BACK" ? (
                      <UndoSendBack row={row} />
                    ) : (
                      <Link href="/returns" className="text-xs font-medium text-primary hover:underline">
                        Put right on the return
                      </Link>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </TableShell>
        </>
      )}
    </div>
  )
}

/**
 * The CEO's and the main admin's fix for a phone put on a send-back by
 * mistake: it never left the shop.
 */
function UndoSendBack({ row }: { row: SupplierReturnRow }) {
  return (
    <details>
      <summary className="cursor-pointer text-xs font-medium text-primary">It stayed in the shop</summary>
      <ActionForm
        action={undoSupplierSendBack}
        submit="Bring it back"
        successMessage="Back in the shop and off the supplier. What came off their bill is back on it."
        size="sm"
        variant="outline"
        buttonClassName="mt-2"
        className="mt-2 space-y-2"
        confirmModal={{
          title: `Undo ${row.reference} for ${row.imei}?`,
          description: `The phone goes back to what it was before it was sent, and ${formatCurrency(row.value)} is taken off what went back to ${row.supplier}.`,
          confirmLabel: "Bring it back",
        }}
      >
        <input type="hidden" name="id" value={row.id} />
        <Input name="editReason" placeholder="Why: picked by mistake, phone never left" required minLength={4} />
      </ActionForm>
    </details>
  )
}
