"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Download, FileSpreadsheet } from "lucide-react"
import { toast } from "sonner"
import { receiveTransfer, rejectTransfer } from "@/app/actions/ops"
import { ActionForm } from "@/components/action-form"
import { StatusBadge } from "@/components/shared"
import { DataTable, type DataColumn } from "@/components/data-table"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { WorkflowSteps } from "@/components/workflow-steps"
import { UnitChecklist } from "@/components/scan-field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { downloadTable } from "@/lib/download-table"
import { formatShopWhen } from "@/lib/lagos-day"
import { formatCurrency, money } from "@/lib/utils"
import { useUrlFilter } from "@/lib/use-url-filter"

type TransferRow = {
  id: string
  transferNumber: string
  status: string
  createdAt: Date
  sentAt: Date | null
  receivedAt: Date | null
  fromBranch: { code: string; name: string }
  toBranch: { code: string; name: string }
  items: Array<{
    id: string
    receivedQty: number
    productId: string
    product: { name: string; specs: string; sku: string; costPrice: number }
    quantity: number
  }>
  imeis: Array<{
    id: string
    imei1: string
    imei2: string | null
    serialNumber: string | null
    available: boolean
    productId: string
    name: string
    specs: string
    costPrice: number
  }>
  /** Phones that arrived, when only part of the transfer was accepted. */
  arrivedImeis: string[] | null
  /** Why it was rejected, when it was. */
  rejectedBecause: string | null
  sentBy: string | null
  receivedBy: string | null
  /** May this person accept or reject it (receiving shop's manager, CEO, main admin)? */
  canDecide: boolean
}

/** Accepted, but not all of it arrived. */
function isPartial(transfer: TransferRow) {
  if (transfer.status !== "RECEIVED") return false
  if (transfer.arrivedImeis && transfer.arrivedImeis.length < transfer.imeis.length) return true
  return pieceLines(transfer).some((item) => item.receivedQty < item.quantity)
}

function pieceLines(transfer: TransferRow) {
  const phoneProductIds = new Set(transfer.imeis.map((row) => row.productId))
  return transfer.items.filter((item) => !phoneProductIds.has(item.productId))
}

function transferTotals(transfer: TransferRow) {
  const pieces = pieceLines(transfer)
  const phoneQty = transfer.imeis.length
  const pieceQty = pieces.reduce((sum, item) => sum + item.quantity, 0)
  const phoneCost = transfer.imeis.reduce((sum, row) => sum + money(row.costPrice), 0)
  const pieceCost = pieces.reduce((sum, item) => sum + item.quantity * money(item.product.costPrice), 0)
  return {
    qty: phoneQty + pieceQty,
    costValue: phoneCost + pieceCost,
  }
}

const TRANSFER_FILTERS = ["all", "PENDING", "RECEIVED", "CANCELLED"] as const

/**
 * Which tile a transfer counts under. On the way is from before accepting
 * replaced sending: such a transfer still waits for the receiving shop, the
 * same as Waiting for accept, and Home counts the two together.
 */
function tileOf(status: string) {
  return status === "IN_TRANSIT" ? "PENDING" : status
}

/**
 * `atCost` for the CEO. Everyone else sees transfers valued at sell price; their
 * rows' "costPrice" fields already hold the selling price from the server.
 */
export function TransfersList({
  transfers,
  atCost = false,
  initialStatus,
}: {
  transfers: TransferRow[]
  atCost?: boolean
  /** ?status= from the address bar, e.g. Home's link to transfers still waiting. */
  initialStatus?: string
}) {
  const unitWord = atCost ? "Unit cost" : "Unit price"
  const valueWord = atCost ? "Cost value" : "Value at sell price"
  const [status, setStatus] = useUrlFilter(initialStatus, TRANSFER_FILTERS)

  const filtered = useMemo(
    () => transfers.filter((transfer) => (status === "all" ? true : tileOf(transfer.status) === status)),
    [transfers, status]
  )

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { all: transfers.length }
    for (const transfer of transfers) {
      const tile = tileOf(transfer.status)
      byStatus[tile] = (byStatus[tile] ?? 0) + 1
    }
    return byStatus
  }, [transfers])


  function extractList(format: "csv" | "xlsx") {
    const rows: Array<Array<string | number>> = [
      [
        "Transfer number",
        "Status",
        "From",
        "To",
        "Item",
        "IMEI or item code",
        "Qty",
        unitWord,
        valueWord,
        "When",
        "Sent by",
        "Received / rejected by",
      ],
    ]
    for (const transfer of filtered) {
      const when = formatShopWhen(transfer.receivedAt ?? transfer.sentAt ?? transfer.createdAt)
      const sentBy = transfer.sentBy ?? ""
      const receivedBy = transfer.receivedBy ?? ""
      if (transfer.imeis.length) {
        for (const imei of transfer.imeis) {
          const unit = money(imei.costPrice)
          rows.push([
            transfer.transferNumber,
            transfer.status,
            transfer.fromBranch.name,
            transfer.toBranch.name,
            imei.name,
            imei.imei1,
            1,
            unit.toFixed(2),
            unit.toFixed(2),
            when,
            sentBy,
            receivedBy,
          ])
        }
      }
      for (const item of pieceLines(transfer)) {
        const unit = money(item.product.costPrice)
        rows.push([
          transfer.transferNumber,
          transfer.status,
          transfer.fromBranch.name,
          transfer.toBranch.name,
          item.product.name,
          item.product.sku,
          item.quantity,
          unit.toFixed(2),
          (item.quantity * unit).toFixed(2),
          when,
          sentBy,
          receivedBy,
        ])
      }
      if (!transfer.imeis.length && !pieceLines(transfer).length) {
        rows.push([
          transfer.transferNumber,
          transfer.status,
          transfer.fromBranch.name,
          transfer.toBranch.name,
          "",
          "",
          0,
          "0.00",
          "0.00",
          when,
          sentBy,
          receivedBy,
        ])
      }
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const stage = status === "all" ? "all" : status.toLowerCase()
    void downloadTable(rows, `shop-to-shop-transfers-${stage}-${stamp}.${format}`, format)
    toast.success(format === "xlsx" ? "Excel extracted for this list." : "CSV extracted for this list.")
  }

  const [open, setOpen] = useState<TransferRow | null>(null)
  const isOpenWork = (row: TransferRow) => row.status === "PENDING" || row.status === "IN_TRANSIT"
  const whenOf = (row: TransferRow) => row.receivedAt ?? row.sentAt ?? row.createdAt

  const columns: DataColumn<TransferRow>[] = [
    {
      id: "number",
      header: "Transfer",
      sortValue: (row) => row.transferNumber,
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap font-medium text-primary">{row.transferNumber}</span>
          {isOpenWork(row) ? (
            <span className="whitespace-nowrap rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-semibold text-warning">
              {row.canDecide ? "Accept or reject" : "Waiting for the other shop"}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "route",
      header: "From → To",
      sortValue: (row) => `${row.fromBranch.name} ${row.toBranch.name}`,
      cell: (row) => (
        <span className="whitespace-nowrap">
          {row.fromBranch.name} <span className="text-muted-foreground">→</span> {row.toBranch.name}
        </span>
      ),
    },
    { id: "qty", header: "Qty", align: "right", sortValue: (row) => transferTotals(row).qty, cell: (row) => transferTotals(row).qty },
    {
      id: "value",
      header: valueWord,
      align: "right",
      hideBelow: "lg",
      sortValue: (row) => transferTotals(row).costValue,
      cell: (row) => formatCurrency(transferTotals(row).costValue),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (row) => row.status,
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge value={row.status} />
          {isPartial(row) ? <span className="whitespace-nowrap text-[11px] font-medium text-warning">part</span> : null}
        </span>
      ),
    },
    {
      id: "when",
      header: "When",
      hideBelow: "xl",
      sortValue: (row) => new Date(whenOf(row)).getTime(),
      cell: (row) => <span className="whitespace-nowrap tabular-nums">{formatShopWhen(whenOf(row))}</span>,
    },
    {
      id: "people",
      header: "Sent / received by",
      sortValue: (row) => `${row.sentBy ?? ""} ${row.receivedBy ?? ""}`,
      cell: (row) => <TransferPeople row={row} />,
    },
  ]

  return (
    <div className="space-y-4">
      <WorkflowSteps
        activeKey={status}
        onSelect={setStatus}
        steps={[
          { key: "all", label: "All transfers", count: counts.all, hint: "Every shop to shop" },
          { key: "PENDING", label: "Waiting for accept", count: counts.PENDING ?? 0, hint: "Receiving shop to check" },
          { key: "RECEIVED", label: "Accepted", count: counts.RECEIVED ?? 0, hint: "On the other shelf" },
          { key: "CANCELLED", label: "Rejected", count: counts.CANCELLED ?? 0, hint: "Stock went back" },
        ]}
      />

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(row) => row.id}
        noun="transfers"
        filterKey={status}
        onRowClick={setOpen}
        searchText={(row) =>
          [
            row.transferNumber,
            row.fromBranch.name,
            row.toBranch.name,
            ...row.imeis.flatMap((imei) => [imei.imei1, imei.name, imei.specs]),
            ...row.items.map((item) => `${item.product.name} ${item.product.specs}`),
            row.sentBy ?? "",
            row.receivedBy ?? "",
          ].join(" ")
        }
        searchPlaceholder="Search transfer number, shop, staff name, IMEI or item"
        actions={
          <>
            <Button type="button" variant="outline" size="sm" className="h-10" disabled={!filtered.length} onClick={() => extractList("xlsx")} aria-label="Download as Excel">
              <FileSpreadsheet className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Excel</span>
            </Button>
            <Button type="button" variant="outline" size="sm" className="hidden h-10 sm:inline-flex" disabled={!filtered.length} onClick={() => extractList("csv")}>
              <Download className="mr-1.5 h-4 w-4" /> CSV
            </Button>
          </>
        }
        card={(row) => {
          const totals = transferTotals(row)
          return {
            title: `${row.fromBranch.name} → ${row.toBranch.name}`,
            subtitle: `${row.transferNumber} · ${formatShopWhen(whenOf(row))}`,
            value: `${totals.qty} item${totals.qty === 1 ? "" : "s"}`,
            valueHint: <span className="text-muted-foreground">{formatCurrency(totals.costValue)}</span>,
            badge: <StatusBadge value={row.status} />,
            meta: (
              <span className="flex flex-col gap-0.5">
                <TransferPeople row={row} inline />
                {isOpenWork(row) ? (
                  <span className="font-medium text-warning">{row.canDecide ? "Accept or reject" : "Waiting for the other shop"}</span>
                ) : row.status === "CANCELLED" && row.rejectedBecause ? (
                  <span className="text-warning">Rejected: {row.rejectedBecause}</span>
                ) : isPartial(row) ? (
                  <span className="font-medium text-warning">Part arrived</span>
                ) : null}
              </span>
            ),
          }
        }}
        empty={transfers.length === 0 ? "No shop-to-shop transfers yet." : "Nothing in this stage. Tap another stage above."}
      />

      <Sheet open={Boolean(open)} onOpenChange={(value) => !value && setOpen(null)}>
        {open ? (
          <SheetContent
            title={open.transferNumber}
            description={`${open.fromBranch.name} → ${open.toBranch.name} · ${formatShopWhen(whenOf(open))}`}
            className="sm:w-[520px]"
          >
            <TransferDetail transfer={open} valueWord={valueWord} onDone={() => setOpen(null)} />
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  )
}

function TransferDetail({
  transfer,
  valueWord,
  onDone,
}: {
  transfer: TransferRow
  valueWord: string
  onDone: () => void
}) {
  const totals = transferTotals(transfer)
  const open = transfer.status === "PENDING" || transfer.status === "IN_TRANSIT"
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/60 p-3 text-center">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Items</p>
          <p className="font-semibold tabular-nums">{totals.qty}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{valueWord}</p>
          <p className="font-semibold tabular-nums">{formatCurrency(totals.costValue)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Status</p>
          <StatusBadge value={transfer.status} />
        </div>
      </div>

      {open ? null : (
      <ul className="divide-y divide-border rounded-xl border border-border">
        {transfer.imeis.map((imei) => {
          const stayed = transfer.arrivedImeis ? !transfer.arrivedImeis.includes(imei.imei1) : false
          return (
            <li key={imei.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{imei.name}</p>
                {imei.specs ? <p className="text-xs text-muted-foreground">{imei.specs}</p> : null}
                <Link href={`/imei/${imei.id}`} className="font-mono text-xs text-primary hover:underline">
                  {imei.imei1}
                </Link>
                {stayed ? <p className="text-xs text-warning">Did not arrive. Stayed at {transfer.fromBranch.name}.</p> : null}
              </div>
              <span className="shrink-0 tabular-nums">{formatCurrency(money(imei.costPrice))}</span>
            </li>
          )
        })}
        {pieceLines(transfer).map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="font-medium">{item.product.name}</p>
              {item.product.specs ? <p className="text-xs text-muted-foreground">{item.product.specs}</p> : null}
              <p className="text-xs text-muted-foreground">
                {item.quantity} × {formatCurrency(money(item.product.costPrice))} · <span className="font-mono">{item.product.sku}</span>
              </p>
              {transfer.status === "RECEIVED" && item.receivedQty < item.quantity ? (
                <p className="text-xs text-warning">
                  {item.receivedQty} of {item.quantity} arrived. {item.quantity - item.receivedQty} stayed at {transfer.fromBranch.name}.
                </p>
              ) : null}
            </div>
            <span className="shrink-0 tabular-nums">{formatCurrency(item.quantity * money(item.product.costPrice))}</span>
          </li>
        ))}
      </ul>
      )}

      <dl className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Sent by · {transfer.fromBranch.name}
          </dt>
          <dd className="truncate font-medium">{transfer.sentBy ?? "Not recorded"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {decisionWord(transfer.status)} · {transfer.toBranch.name}
          </dt>
          <dd
            className={`truncate font-medium ${
              transfer.status === "RECEIVED" ? "text-success" : transfer.status === "CANCELLED" ? "text-danger" : "text-muted-foreground"
            }`}
          >
            {transfer.receivedBy ?? (transfer.status === "RECEIVED" || transfer.status === "CANCELLED" ? "Not recorded" : "Not yet")}
          </dd>
        </div>
      </dl>
      {open && !transfer.canDecide ? (
        <p className="rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          Waiting for the manager of {transfer.toBranch.name}, the CEO or the main admin to accept or reject it. Stock
          stays In shop at {transfer.fromBranch.name} until then, and the sender gets an alert when it is decided.
        </p>
      ) : null}
      {open && transfer.canDecide ? (
        <div className="space-y-4 rounded-xl border border-warning/40 p-4">
          {transfer.status === "PENDING" ? (
            <p className="text-sm text-muted-foreground">
              Stock is still in shop at {transfer.fromBranch.name}. It leaves only when {transfer.toBranch.name} accepts.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{transfer.toBranch.name} accepts or rejects this transfer.</p>
          )}
          <ActionForm
            action={receiveTransfer}
            submit="Accept what arrived"
            successMessage="Accepted. What arrived is now In shop at the receiving branch."
            enterDoesNotSubmit
            className="space-y-2"
            onSuccess={onDone}
            confirmModal={{
              title: "Accept what arrived?",
              description: `What you ticked or counted lands In shop at ${transfer.toBranch.name}. Anything else stays at ${transfer.fromBranch.name}.`,
              confirmLabel: "Accept",
              tone: "warning",
            }}
          >
            <input type="hidden" name="id" value={transfer.id} />
            {transfer.imeis.length ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">Phones that arrived</p>
                <UnitChecklist
                  name="imeis"
                  units={transfer.imeis.map((imei) => ({
                    key: imei.imei1,
                    title: imei.specs ? `${imei.name} · ${imei.specs}` : imei.name,
                    codes: [imei.imei2, imei.serialNumber].filter((code): code is string => Boolean(code)),
                    unavailable: imei.available ? undefined : `No longer In shop at ${transfer.fromBranch.name} (sold or moved there).`,
                  }))}
                />
              </div>
            ) : null}
            {pieceLines(transfer).length ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">Pieces that arrived</p>
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {pieceLines(transfer).map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                      <label htmlFor={`piece-${item.id}`} className="min-w-0">
                        <span className="block font-medium">{item.product.name}</span>
                        {item.product.specs ? <span className="block text-xs text-muted-foreground">{item.product.specs}</span> : null}
                        <span className="block text-xs text-muted-foreground">
                          {item.quantity} sent · <span className="font-mono">{item.product.sku}</span>
                        </span>
                      </label>
                      <Input
                        id={`piece-${item.id}`}
                        name={`piece_${item.id}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={item.quantity}
                        step={1}
                        defaultValue={item.quantity}
                        className="h-10 w-20 shrink-0 text-center font-semibold tabular-nums"
                        aria-label={`How many ${item.product.name} arrived`}
                      />
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">Lower a number if fewer came. The rest stays at {transfer.fromBranch.name}.</p>
              </div>
            ) : null}
          </ActionForm>
          <ActionForm
            action={rejectTransfer}
            submit="Reject transfer"
            successMessage="Transfer rejected. Stock stays In shop at the sending branch."
            variant="outline"
            className="space-y-2"
            onSuccess={onDone}
            confirmModal={{
              title: "Reject this transfer?",
              description:
                transfer.status === "PENDING"
                  ? `Nothing leaves ${transfer.fromBranch.name}. The In shop record stays as it is.`
                  : `Stock returns to ${transfer.fromBranch.name}.`,
              confirmLabel: "Reject transfer",
              tone: "danger",
            }}
          >
            <input type="hidden" name="id" value={transfer.id} />
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Why are you rejecting it? (required)</span>
              <Textarea
                name="reason"
                required
                minLength={3}
                rows={2}
                placeholder="e.g. Wrong phones sent; two IMEIs do not match the boxes"
              />
              <span className="block text-xs text-muted-foreground">The sending shop sees this, with your name.</span>
            </label>
          </ActionForm>
        </div>
      ) : transfer.status === "RECEIVED" ? (
        <p className={`text-sm ${isPartial(transfer) ? "text-warning" : "text-success"}`}>
          {isPartial(transfer)
            ? `Part arrived. What arrived is In shop at ${transfer.toBranch.name}; the rest stayed at ${transfer.fromBranch.name}.`
            : `In shop at ${transfer.toBranch.name}.`}
        </p>
      ) : open ? null : (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">Rejected. Stock stayed at {transfer.fromBranch.name}.</p>
          {transfer.rejectedBecause ? (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">Why: {transfer.rejectedBecause}</p>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** What the receiving shop's person did: received it, rejected it, or has not yet. */
function decisionWord(status: string) {
  return status === "RECEIVED" ? "Received by" : status === "CANCELLED" ? "Rejected by" : "To be received by"
}

/** Who sent a transfer and who received (or rejected) it at the other shop. */
function TransferPeople({ row, inline = false }: { row: TransferRow; inline?: boolean }) {
  const decided = row.status === "RECEIVED" || row.status === "CANCELLED"
  const second = decided
    ? `${row.status === "RECEIVED" ? "Received" : "Rejected"} by ${row.receivedBy ?? "someone not recorded"}`
    : `Waiting at ${row.toBranch.name}`
  if (inline) {
    return (
      <span className="text-muted-foreground">
        Sent by {row.sentBy ?? "someone not recorded"} ·{" "}
        <span className={row.status === "RECEIVED" ? "text-success" : row.status === "CANCELLED" ? "text-danger" : ""}>{second}</span>
      </span>
    )
  }
  return (
    <div className="min-w-0 text-xs leading-snug">
      <p className="whitespace-nowrap">
        <span className="text-muted-foreground">Sent:</span> <span className="font-medium">{row.sentBy ?? "—"}</span>
      </p>
      <p className="whitespace-nowrap">
        <span className="text-muted-foreground">{decided ? (row.status === "RECEIVED" ? "Received:" : "Rejected:") : "Received:"}</span>{" "}
        {decided ? (
          <span className={`font-medium ${row.status === "RECEIVED" ? "text-success" : "text-danger"}`}>{row.receivedBy ?? "—"}</span>
        ) : (
          <span className="text-muted-foreground">not yet</span>
        )}
      </p>
    </div>
  )
}
