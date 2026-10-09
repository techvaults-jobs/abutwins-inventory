"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { advanceRepair } from "@/app/actions/ops"
import { ActionForm } from "@/components/action-form"
import { StatusBadge } from "@/components/shared"
import { DataTable, type DataColumn } from "@/components/data-table"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { WorkflowSteps } from "@/components/workflow-steps"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { formatShopWhen } from "@/lib/lagos-day"
import { statusLabel } from "@/lib/status"
import { formatCurrency } from "@/lib/utils"
import { useUrlFilter } from "@/lib/use-url-filter"

const stages = ["PENDING", "DIAGNOSING", "REPAIRING", "WAITING_PARTS", "COMPLETED", "DELIVERED"]

type RepairRow = {
  id: string
  repairNumber: string
  status: string
  issue: string
  diagnosis: string | null
  repairCost: number | null
  createdAt: Date
  completedAt: Date | null
  imei: { id: string; imei1: string; product: { name: string; specs: string } }
  customer: { name: string } | null
}

const REPAIR_FILTERS = ["all", "PENDING", "DIAGNOSING", "WAITING_PARTS", "REPAIRING", "DELIVERED"] as const

export function RepairsList({
  rows,
  initialStatus,
}: {
  rows: RepairRow[]
  /** ?status= from the address bar. */
  initialStatus?: string
}) {
  const [status, setStatus] = useUrlFilter(initialStatus, REPAIR_FILTERS)

  const filtered = useMemo(
    () => rows.filter((row) => (status === "all" ? true : row.status === status)),
    [rows, status]
  )

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { all: rows.length }
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    }
    return byStatus
  }, [rows])

  const [open, setOpen] = useState<RepairRow | null>(null)
  const whenOf = (row: RepairRow) => row.completedAt ?? row.createdAt
  const isOpenJob = (row: RepairRow) => row.status !== "DELIVERED" && row.status !== "CANCELLED"

  const columns: DataColumn<RepairRow>[] = [
    { id: "number", header: "Repair", sortValue: (row) => row.repairNumber, cell: (row) => <span className="whitespace-nowrap font-medium text-primary">{row.repairNumber}</span> },
    {
      id: "phone",
      header: "Phone",
      sortValue: (row) => row.imei.product.name,
      cell: (row) => (
        <div>
          <p className="font-medium">{row.imei.product.name}</p>
          {row.imei.product.specs ? <p className="text-xs text-muted-foreground">{row.imei.product.specs}</p> : null}
          <p className="font-mono text-xs text-muted-foreground">{row.imei.imei1}</p>
        </div>
      ),
    },
    { id: "issue", header: "Issue", hideBelow: "lg", cell: (row) => <span className="line-clamp-2 max-w-xs">{row.issue}</span> },
    { id: "owner", header: "Owner", hideBelow: "xl", sortValue: (row) => row.customer?.name ?? "", cell: (row) => row.customer?.name ?? <span className="text-muted-foreground">Shop phone</span> },
    { id: "status", header: "Stage", sortValue: (row) => stages.indexOf(row.status), cell: (row) => <StatusBadge value={row.status} /> },
    {
      id: "when",
      header: "When",
      hideBelow: "xl",
      sortValue: (row) => new Date(whenOf(row)).getTime(),
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{formatShopWhen(whenOf(row))}</span>,
    },
  ]

  return (
    <div className="space-y-4">
      <WorkflowSteps
        activeKey={status}
        onSelect={setStatus}
        steps={[
          { key: "all", label: "All repairs", count: counts.all, hint: "Every job on the bench" },
          { key: "PENDING", label: "Take in", count: counts.PENDING ?? 0, hint: "Just opened" },
          { key: "DIAGNOSING", label: "Find fault", count: counts.DIAGNOSING ?? 0, hint: "Checking" },
          { key: "WAITING_PARTS", label: "Wait for parts", count: counts.WAITING_PARTS ?? 0, hint: "Parts not yet" },
          { key: "REPAIRING", label: "Repair", count: counts.REPAIRING ?? 0, hint: "On the bench" },
          { key: "DELIVERED", label: "Give back", count: counts.DELIVERED ?? 0, hint: "Back with buyer" },
        ]}
      />

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(row) => row.id}
        noun="repairs"
        filterKey={status}
        onRowClick={setOpen}
        searchText={(row) => [row.repairNumber, row.imei.imei1, row.imei.product.name, row.imei.product.specs, row.issue, row.customer?.name].filter(Boolean).join(" ")}
        searchPlaceholder="Search repair, IMEI, phone, issue or owner"
        card={(row) => ({
          title: row.imei.product.name,
          subtitle: `${row.repairNumber} · ${row.issue}`,
          badge: <StatusBadge value={row.status} />,
          meta: (
            <>
              <span>{row.customer?.name ?? "Shop phone"}</span>
              <span>· {formatShopWhen(whenOf(row))}</span>
            </>
          ),
        })}
        empty={rows.length === 0 ? "No repairs on the books yet." : "No repair matches this stage. Tap another step above."}
      />

      <Sheet open={Boolean(open)} onOpenChange={(value) => !value && setOpen(null)}>
        {open ? (
          <SheetContent title={open.repairNumber} description={`${open.imei.product.name} · ${formatShopWhen(whenOf(open))}`}>
            <div className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Phone</dt>
                <dd>
                  <Link href={`/imei/${open.imei.id}`} className="font-mono text-primary hover:underline">
                    {open.imei.imei1}
                  </Link>
                </dd>
                <dt className="text-muted-foreground">Stage</dt>
                <dd><StatusBadge value={open.status} /></dd>
                <dt className="text-muted-foreground">Issue</dt>
                <dd>{open.issue}</dd>
                {open.diagnosis ? (
                  <>
                    <dt className="text-muted-foreground">Found</dt>
                    <dd>{open.diagnosis}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Owner</dt>
                <dd>
                  {open.customer
                    ? `${open.customer.name}${open.repairCost ? ` · charge ${formatCurrency(open.repairCost)} on deliver` : ""}`
                    : "Shop phone. When finished it goes back into shop stock."}
                </dd>
              </dl>
              {isOpenJob(open) ? (
                <ActionForm
                  action={advanceRepair}
                  submit="Update repair"
                  successMessage="Repair updated."
                  className="space-y-2 rounded-xl border border-border p-4"
                  onSuccess={() => setOpen(null)}
                >
                  <input type="hidden" name="id" value={open.id} />
                  <Select name="status" defaultValue={open.status} aria-label="Stage">
                    {stages.map((item) => (
                      <option key={item} value={item}>
                        {statusLabel(item)}
                      </option>
                    ))}
                  </Select>
                  <Input name="repairCost" type="number" placeholder="Repair cost" defaultValue={open.repairCost ? String(open.repairCost) : ""} />
                  <Textarea name="diagnosis" placeholder="What you found wrong with this phone" defaultValue={open.diagnosis ?? ""} />
                </ActionForm>
              ) : null}
            </div>
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  )
}
