"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { Download, FileSpreadsheet, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { exportImeiRecords, setImeiShelfState } from "@/app/actions/imei"
import { downloadTable } from "@/lib/download-table"
import { StatusBadge } from "@/components/shared"
import { DataTable, type DataColumn } from "@/components/data-table"
import { Button } from "@/components/ui/button"
import { formatShopWhen, watDayKey } from "@/lib/lagos-day"
import { warrantyState } from "@/lib/warranty"
import { unitIdentityKind } from "@/lib/unit-identity"
import { ProductLabel } from "@/components/product-label"
import { productSpecLine } from "@/lib/product-specs"
import { phoneLookLabel } from "@/lib/phone-look"

type ImeiRow = {
  id: string
  imei1: string
  serialNumber: string | null
  status: string
  createdAt: Date
  updatedAt: Date
  cosmeticGrade: string | null
  batteryHealth: number | null
  product: { name: string; warrantyDays: number; storage: string | null; ram: string | null; color: string | null; condition: string }
  branch: { code: string }
  customer: { name: string } | null
  supplier: { name: string } | null
  sale: { saleDate: Date } | null
}

/** What is particular to this one phone: how it looks and its battery. */
function unitExtra(row: { cosmeticGrade: string | null; batteryHealth: number | null; product: { condition: string } }) {
  const look = row.cosmeticGrade && row.cosmeticGrade !== row.product.condition ? `Looks ${phoneLookLabel(row.cosmeticGrade)}` : ""
  const battery = row.batteryHealth != null ? `Battery ${row.batteryHealth}%` : ""
  return [look, battery].filter(Boolean).join(" · ") || null
}

function ShelfToggle({ id, status }: { id: string; status: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  if (status !== "IN_STOCK" && status !== "FAULTY") return null

  const go = (shelfState: "GOOD" | "DAMAGED") => {
    startTransition(async () => {
      const formData = new FormData()
      formData.set("id", id)
      formData.set("shelfState", shelfState)
      const result = await setImeiShelfState(formData)
      if (result && "error" in result && result.error) {
        toast.error(result.error)
        return
      }
      toast.success(shelfState === "GOOD" ? "Set to Good (sellable)" : "Set to Damaged")
      router.refresh()
    })
  }

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {status === "FAULTY" ? (
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => go("GOOD")}>
          Set Good (sellable)
        </Button>
      ) : (
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => go("DAMAGED")}>
          Set Damaged
        </Button>
      )}
    </div>
  )
}

export type ImeiFilters = { q?: string; status?: string; life?: string; when?: string }

/**
 * Download every phone under the current search and filters, with all its
 * details, for reconciling in Excel. Not limited to the rows on screen.
 */
function ExtractButtons({ filters }: { filters: ImeiFilters }) {
  const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null)
  async function extract(format: "xlsx" | "csv") {
    setBusy(format)
    try {
      const result = await exportImeiRecords(filters.q, filters.status, filters.life, filters.when)
      if ("error" in result && result.error) {
        toast.error(result.error)
        return
      }
      const rows = "rows" in result ? result.rows : undefined
      if (!rows) return
      const count = rows.length - 1
      if (count <= 0) {
        toast.error("No phone matches these filters, so there is nothing to download.")
        return
      }
      const stamp = watDayKey()
      const scope = [filters.status ?? filters.life, filters.when, filters.q].filter(Boolean).join("-").replace(/[^a-z0-9-]+/gi, "_")
      await downloadTable(rows, `all-phones${scope ? `-${scope}` : ""}-${stamp}.${format}`, format)
      toast.success(
        `${count.toLocaleString("en-NG")} phone${count === 1 ? "" : "s"} downloaded${result.truncated ? " (the first 50,000; narrow the filters for the rest)" : ""}.`
      )
    } catch {
      toast.error("The download did not finish. Check the line and try again.")
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <Button type="button" variant="outline" size="sm" className="h-10" disabled={busy !== null} onClick={() => extract("xlsx")} aria-label="Download these phones as Excel">
        {busy === "xlsx" ? <Loader2 className="h-4 w-4 animate-spin sm:mr-1.5" /> : <FileSpreadsheet className="h-4 w-4 sm:mr-1.5" />}
        <span className="hidden sm:inline">Excel</span>
      </Button>
      <Button type="button" variant="outline" size="sm" className="h-10" disabled={busy !== null} onClick={() => extract("csv")} aria-label="Download these phones as CSV">
        {busy === "csv" ? <Loader2 className="h-4 w-4 animate-spin sm:mr-1.5" /> : <Download className="h-4 w-4 sm:mr-1.5" />}
        <span className="hidden sm:inline">CSV</span>
      </Button>
    </>
  )
}

export function ImeiTable({
  records,
  resetKey,
  filters,
}: {
  records: ImeiRow[]
  resetKey: string
  /** The page's search and filters. Without them (the offline copy) there is no download. */
  filters?: ImeiFilters
}) {
  const router = useRouter()
  const owner = (row: ImeiRow) => row.customer?.name ?? row.supplier?.name ?? "Vault"
  const columns: DataColumn<ImeiRow>[] = [
    {
      id: "code",
      header: "IMEI or serial",
      sortValue: (row) => row.imei1,
      cell: (row) => (
        <div>
          <Link href={`/imei/${row.id}`} className="font-mono font-medium text-primary hover:underline">
            {row.imei1}
          </Link>
          {unitIdentityKind(row) === "SERIAL" ? (
            <p className="text-xs text-muted-foreground">Serial number</p>
          ) : row.serialNumber ? (
            <p className="text-xs text-muted-foreground">Serial {row.serialNumber}</p>
          ) : null}
        </div>
      ),
    },
    {
      id: "item",
      header: "Item",
      sortValue: (row) => `${row.product.name} ${productSpecLine(row.product)}`,
      cell: (row) => <ProductLabel product={row.product} extra={unitExtra(row)} />,
    },
    { id: "shop", header: "Shop", sortValue: (row) => row.branch.code, cell: (row) => row.branch.code },
    { id: "owner", header: "Owner", hideBelow: "lg", sortValue: owner, cell: owner },
    {
      id: "status",
      header: "Status",
      sortValue: (row) => row.status,
      cell: (row) => (
        <div>
          <StatusBadge value={row.status} />
          {row.status === "SOLD" && row.sale ? (
            <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
              Sold {formatShopWhen(row.sale.saleDate)} · {warrantyState(row.sale.saleDate, row.product.warrantyDays).label}
            </p>
          ) : null}
          <ShelfToggle id={row.id} status={row.status} />
        </div>
      ),
    },
    {
      id: "changed",
      header: "Last change",
      hideBelow: "xl",
      sortValue: (row) => new Date(row.updatedAt).getTime(),
      cell: (row) => (
        <div className="whitespace-nowrap">
          <p className="tabular-nums">{formatShopWhen(row.updatedAt)}</p>
          <p className="text-xs text-muted-foreground">First booked {formatShopWhen(row.createdAt)}</p>
        </div>
      ),
    },
  ]

  return (
    <DataTable
      rows={records}
      columns={columns}
      rowKey={(row) => row.id}
      noun="phones"
      filterKey={resetKey}
      onRowClick={(row) => router.push(`/imei/${row.id}`)}
      actions={filters ? <ExtractButtons filters={filters} /> : undefined}
      card={(row) => ({
        title: <span className="font-mono">{row.imei1}</span>,
        subtitle: (
          <>
            <span className="block">{row.product.name} · {row.branch.code}</span>
            {productSpecLine(row.product) || unitExtra(row) ? (
              <span className="block text-xs text-muted-foreground">
                {[productSpecLine(row.product), unitExtra(row)].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </>
        ),
        badge: <StatusBadge value={row.status} />,
        meta: (
          <>
            <span>{owner(row)}</span>
            <span>· {formatShopWhen(row.updatedAt)}</span>
          </>
        ),
      })}
      empty="No phone matches this filter. Tap another stage above, or clear the search."
    />
  )
}
