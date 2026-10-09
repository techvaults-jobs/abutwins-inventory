"use client"

import { useMemo } from "react"
import { setIncomingVisible } from "@/app/actions/incoming"
import { PreviewIncomingModal } from "./preview-incoming-modal"
import { ActionForm } from "@/components/action-form"
import { EmptyState, StatusBadge } from "@/components/shared"
import { TablePager, usePagedRows } from "@/components/table-pager"
import { WorkflowSteps } from "@/components/workflow-steps"
import { Badge } from "@/components/ui/badge"
import { formatShopWhen, watBounds, watDayKey } from "@/lib/lagos-day"
import { useUrlFilter } from "@/lib/use-url-filter"

type IncomingLot = {
  id: string
  lotNumber: string
  status: string
  visible: boolean
  expectedDate: Date | null
  notes: string | null
  createdAt: Date
  updatedAt: Date
  branch: { name: string }
  supplier: { name: string } | null
  purchase: { invoiceNumber: string } | null
  items: Array<{
    id: string
    productId: string
    quantity: number
    expectedQuantity?: number
    receivedQuantity?: number | null
    identity: "IMEI" | "SERIAL" | "NONE"
    identifiers: string | null
    suggestedCost?: number
    catalogCost?: number
    billCost?: number | null
    product: { name: string; brand?: { name: string }; costPrice?: number }
  }>
}

const INCOMING_FILTERS = ["all", "COMING", "LATE", "PENDING_APPROVAL", "ARRIVED", "CANCELLED"] as const

export function IncomingList({
  lots,
  canBook,
  isAdmin,
  initialStatus,
}: {
  lots: IncomingLot[]
  canBook: boolean
  isAdmin: boolean
  /** ?status= from the address bar, e.g. Home's link to late goods. */
  initialStatus?: string
}) {
  const [status, setStatus] = useUrlFilter(initialStatus, INCOMING_FILTERS)

  // Late: still coming after the day it was due, the same rule as Home.
  const isLate = useMemo(() => {
    const todayStart = watBounds(watDayKey()).start.getTime()
    return (lot: IncomingLot) =>
      lot.status === "COMING" && lot.expectedDate !== null && new Date(lot.expectedDate).getTime() < todayStart
  }, [])

  const filtered = useMemo(
    () =>
      lots.filter((lot) => (status === "all" ? true : status === "LATE" ? isLate(lot) : lot.status === status)),
    [lots, status, isLate]
  )

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { all: lots.length, LATE: 0 }
    for (const lot of lots) {
      byStatus[lot.status] = (byStatus[lot.status] ?? 0) + 1
      if (isLate(lot)) byStatus.LATE += 1
    }
    return byStatus
  }, [lots, isLate])

  const pager = usePagedRows(filtered, status)

  return (
    <div className="space-y-4">
      <WorkflowSteps
        activeKey={status}
        onSelect={setStatus}
        steps={[
          { key: "all", label: "All", count: counts.all, hint: "Every booking" },
          { key: "COMING", label: "Coming", count: counts.COMING ?? 0, hint: "Left the supplier" },
          { key: "LATE", label: "Late", count: counts.LATE, hint: "Past the day it was due" },
          { key: "PENDING_APPROVAL", label: "Waiting for yes", count: counts.PENDING_APPROVAL ?? 0, hint: "Needs approval" },
          { key: "ARRIVED", label: "In shop", count: counts.ARRIVED ?? 0, hint: "Counted in" },
          { key: "CANCELLED", label: "Cancelled", count: counts.CANCELLED ?? 0, hint: "Not coming" },
        ]}
      />

      <div className="space-y-3">
        {lots.length === 0 ? (
          <EmptyState
            title="No goods on the way"
            hint="Book a carton on the right."
          />
        ) : null}
        {pager.pageRows.map((lot) => (
          <div key={lot.id} className="surface-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">{lot.lotNumber}</p>
                <p className="text-sm text-muted-foreground">
                  {lot.branch.name}
                  {lot.supplier ? ` · ${lot.supplier.name}` : ""}
                  {lot.purchase ? ` · bill ${lot.purchase.invoiceNumber}` : ""}
                  {lot.expectedDate ? ` · due ${formatShopWhen(lot.expectedDate)}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={lot.visible ? "info" : "muted"}>
                    {lot.visible ? "Shown to staff" : "Hidden"}
                  </Badge>
                  <StatusBadge value={lot.status} />
                </div>
                <p className="text-xs font-medium tabular-nums text-muted-foreground">
                  Booked {formatShopWhen(lot.createdAt)}
                </p>
              </div>
            </div>
            <ul className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
              {lot.items.map((item) => {
                const expected = item.expectedQuantity && item.expectedQuantity > 0 ? item.expectedQuantity : item.quantity
                const received = item.receivedQuantity
                const short = received != null ? expected - received : 0
                return (
                  <li key={item.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0">{item.product.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {received != null ? (
                        <>
                          On bill {expected} · In shop {received}
                          {short !== 0 ? (
                            <span className="text-warning">
                              {" "}
                              · {short > 0 ? `short ${short}` : `extra ${-short}`}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <>
                          {expected} ·{" "}
                          {item.identity === "IMEI" ? "IMEI" : item.identity === "SERIAL" ? "Serial" : "No number"}
                        </>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
            {lot.status === "PENDING_APPROVAL" ? (
              <p className="mt-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
                Counted. Waiting for yes on Needs approval before Shop stock rises.
              </p>
            ) : null}
            {lot.status === "ARRIVED" &&
            lot.items.some((item) => {
              const expected = item.expectedQuantity && item.expectedQuantity > 0 ? item.expectedQuantity : item.quantity
              return item.receivedQuantity != null && item.receivedQuantity !== expected
            }) ? (
              <p className="mt-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
                Count does not match the bill. Check Who did what for the short or extra units.
              </p>
            ) : null}
            {lot.notes ? <p className="mt-2 text-xs text-muted-foreground">{lot.notes}</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {canBook && lot.status === "COMING" ? <PreviewIncomingModal lot={lot} /> : null}
              {isAdmin && lot.status === "COMING" ? (
                <ActionForm
                  action={setIncomingVisible}
                  submit={lot.visible ? "Hide from staff" : "Show to staff"}
                  variant="outline"
                  size="sm"
                  buttonClassName=""
                >
                  <input type="hidden" name="id" value={lot.id} />
                  <input type="hidden" name="visible" value={lot.visible ? "false" : "true"} />
                </ActionForm>
              ) : null}
            </div>
          </div>
        ))}
        {lots.length > 0 && filtered.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
            Nothing in this stage. Tap another stage above.
          </p>
        ) : null}
        {filtered.length > 0 ? (
          <div className="surface-card overflow-hidden">
            <TablePager
              page={pager.page}
              pageCount={pager.pageCount}
              pageSize={pager.pageSize}
              total={pager.total}
              start={pager.start}
              end={pager.end}
              onPageChange={pager.setPage}
              onPageSizeChange={pager.setPageSize}
              noun="cartons"
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
