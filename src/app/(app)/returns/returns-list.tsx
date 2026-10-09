"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Package, Smartphone } from "lucide-react"
import { completeReturn, restockReturn } from "@/app/actions/ops"
import { ActionForm } from "@/components/action-form"
import { StatusBadge } from "@/components/shared"
import { DataTable, type DataColumn } from "@/components/data-table"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { WorkflowSteps } from "@/components/workflow-steps"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { formatShopWhen } from "@/lib/lagos-day"
import { formatCurrency, money } from "@/lib/utils"
import { useUrlFilter } from "@/lib/use-url-filter"

// ─── Types ────────────────────────────────────────────────────────────────────

type DeviceRef = {
  id: string
  imei1: string
  serialNumber?: string | null
  productName?: string
}

type SaleItemRef = {
  id: string
  productName: string
  quantity: number
}

/** A named bank a refund can be paid from. */
export type RefundBank = { id: string; label: string; branchId: string }

type ReturnRow = {
  id: string
  branchId: string
  returnNumber: string
  status: string
  reason: string
  outcome: string
  faultClass: string
  notes: string | null
  returnValue: number | null
  refundAmount: unknown
  replacementValue: number | null
  balanceAmount: number | null
  createdAt: Date
  approvedAt: Date | null
  completedAt: Date | null
  customer: { id: string; name: string }
  imei: DeviceRef | null
  replacementImei: DeviceRef | null
  saleItem: SaleItemRef | null
  /** The original sale, with what it cost and what was paid, so a refund can be shown before it happens. */
  invoice: { id: string; invoiceNumber: string; total: number; paid: number } | null
}

/**
 * How a refund splits, the same rule the server applies: the value first clears
 * what is still owed on the sale, and only the rest goes back as money, never
 * more than was paid.
 */
function refundSplit(value: number, invoice: { total: number; paid: number } | null) {
  if (!invoice) return { clearsDebt: 0, paysBack: value }
  const due = Math.max(0, invoice.total - invoice.paid)
  const clearsDebt = Math.min(due, value)
  return { clearsDebt, paysBack: Math.min(value - clearsDebt, invoice.paid) }
}

function refundWords(value: number | null, invoice: { total: number; paid: number } | null) {
  if (value == null) return "refund the return value"
  const { clearsDebt, paysBack } = refundSplit(value, invoice)
  const parts = [
    clearsDebt > 0 ? `clear ${formatCurrency(clearsDebt)} the customer still owes on this sale` : "",
    paysBack > 0 ? `pay ${formatCurrency(paysBack)} back to the customer` : "",
  ].filter(Boolean)
  return parts.length ? parts.join(" and ") : "change nothing in money (nothing was paid or owed)"
}

type StockUnit = {
  id: string
  imei1: string
  serialNumber: string | null
  branchId: string
  product: { name: string; sellingPrice: number }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deviceLabel(row: { imei1: string; serialNumber?: string | null }) {
  if (row.serialNumber && row.serialNumber !== row.imei1) return `${row.imei1} · serial ${row.serialNumber}`
  return row.imei1
}

function outcomeLabel(outcome: string) {
  if (outcome === "REPLACEMENT") return "Replace from our stock"
  if (outcome === "REFUND") return "Refund"
  if (outcome === "CREDIT_NOTE") return "Credit note"
  if (outcome === "SEND_TO_SUPPLIER") return "Send back to the supplier"
  if (outcome === "REPAIR") return "Repair"
  return outcome
}

function reasonLabel(reason: string) {
  if (reason === "FAULTY") return "Faulty"
  if (reason === "WARRANTY") return "Under warranty"
  if (reason === "CUSTOMER_DISSATISFACTION") return "Dissatisfaction / change of mind"
  if (reason === "DAMAGED") return "Damaged"
  if (reason === "WRONG_PRODUCT") return "Wrong product"
  if (reason === "SUPPLIER_RETURN") return "Send toward supplier"
  if (reason === "EXCHANGE") return "Replacement (wants another item)"
  return reason
}

/** Parse the quantity from notes written by the invoice path, e.g. "Item: X · Qty: 3 · ..." */
function parseReturnQty(notes: string | null): number | null {
  if (!notes) return null
  const match = notes.match(/Qty:\s*(\d+)/)
  return match ? Number(match[1]) : null
}

// ─── Item summary chip ────────────────────────────────────────────────────────

function ItemChip({ row }: { row: ReturnRow }) {
  if (row.imei) {
    return (
      <span className="inline-flex items-center gap-1 text-sm">
        <Smartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Link href={`/imei/${row.imei.id}`} className="text-primary hover:underline">
          {deviceLabel(row.imei)}
          {row.imei.productName ? ` · ${row.imei.productName}` : ""}
        </Link>
      </span>
    )
  }
  if (row.saleItem) {
    const qty = parseReturnQty(row.notes)
    return (
      <span className="inline-flex items-center gap-1 text-sm">
        <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span>{row.saleItem.productName}</span>
        {qty && qty > 1 ? (
          <span className="ml-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums">
            ×{qty}
          </span>
        ) : null}
      </span>
    )
  }
  return <span className="text-sm text-muted-foreground">No item recorded</span>
}

// ─── Type tag ─────────────────────────────────────────────────────────────────

function TypeTag({ row }: { row: ReturnRow }) {
  const isInvoice = !row.imei && !!row.saleItem
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        isInvoice
          ? "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950/30 dark:text-purple-400"
          : "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-400"
      )}
    >
      {isInvoice ? (
        <><Package className="h-3 w-3" /> Item</>
      ) : (
        <><Smartphone className="h-3 w-3" /> Phone</>
      )}
    </span>
  )
}

// ─── Balance row ──────────────────────────────────────────────────────────────

function BalanceLine({ row }: { row: ReturnRow }) {
  if (row.outcome !== "REPLACEMENT" || row.balanceAmount == null) return null
  return <BalanceFigure balance={row.balanceAmount ?? 0} />
}

/** Receivable, payable or even, for any replacement balance. */
function BalanceFigure({ balance }: { balance: number }) {
  const receivable = Math.max(balance, 0)
  const payable = Math.max(-balance, 0)
  return (
    <p
      className={cn(
        "mt-1 text-sm font-medium",
        receivable > 0 ? "text-amber-600 dark:text-amber-400" : payable > 0 ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground"
      )}
    >
      {receivable > 0
        ? `Receivable (customer pays us): ${formatCurrency(receivable)}`
        : payable > 0
          ? `Payable (we refund the customer): ${formatCurrency(payable)}`
          : "Balance: even"}
    </p>
  )
}

/** A finished return whose item never went back on the sellable shelf. */
function offShelf(row: { status: string; faultClass: string; outcome: string }) {
  return (
    row.status === "COMPLETED" &&
    row.faultClass !== "GOOD_STOCK" &&
    row.outcome !== "REPAIR" &&
    row.outcome !== "SEND_TO_SUPPLIER"
  )
}

// ─── Apply form (shown when status === APPROVED) ──────────────────────────────

/**
 * Which bank the money moves through. The return's own shop's accounts come
 * first. Money going back to a customer always leaves by bank: safer than cash
 * from the till, and most refunds are transfers anyway.
 */
function BankPicker({
  banks,
  branchId,
  label,
  required,
}: {
  banks: RefundBank[]
  branchId: string
  label: string
  required: boolean
}) {
  const ordered = [...banks].sort((a, b) => Number(b.branchId === branchId) - Number(a.branchId === branchId))
  if (!banks.length) {
    return (
      <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
        No bank account is listed yet. Add one under Money in &amp; out, then come back to apply this.
      </p>
    )
  }
  return (
    <label className="block space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <Select name="bankAccountId" required={required} defaultValue="">
        <option value="" disabled={required}>
          {required ? "Pick the bank account" : "Which bank received it (optional)"}
        </option>
        {ordered.map((bank) => (
          <option key={bank.id} value={bank.id}>
            {bank.label}
          </option>
        ))}
      </Select>
    </label>
  )
}

const OUTCOME_CHOICES = [
  { value: "REFUND", label: "Refund (paid by bank)" },
  { value: "REPLACEMENT", label: "Replacement from our stock" },
  { value: "CREDIT_NOTE", label: "Credit note" },
  { value: "REPAIR", label: "Repair", phoneOnly: true },
  { value: "SEND_TO_SUPPLIER", label: "Send back to the supplier", phoneOnly: true },
] as const

const CONDITION_CHOICES = [
  { value: "GOOD_STOCK", label: "Good — back on the shelf" },
  { value: "FAULTY_STOCK", label: "Faulty — kept in the shop, not for sale" },
  { value: "REPAIR_STOCK", label: "Needs repair" },
  { value: "SCRAP_STOCK", label: "Scrap — write off" },
] as const

/**
 * Apply an approved return. Everyone applies what was approved; the CEO and
 * the main admin can reconfirm first and change the course of action (for
 * example, send a faulty phone back to the supplier instead of refunding) or
 * the condition. The change is written to Who did what.
 */
function ApplyForm({
  row,
  stock,
  banks,
  canReconfirm,
  onDone,
}: {
  row: ReturnRow
  stock: StockUnit[]
  banks: RefundBank[]
  canReconfirm: boolean
  onDone?: () => void
}) {
  const returnValue = row.returnValue ?? money(row.refundAmount)
  const [outcome, setOutcome] = useState(row.outcome)
  const [condition, setCondition] = useState(row.faultClass)
  const [pickedId, setPickedId] = useState("")
  const [method, setMethod] = useState("CASH")
  const changed = outcome !== row.outcome || condition !== row.faultClass

  // A replacement agreed at logging keeps its unit and balance; one chosen now
  // takes its balance from the unit picked here.
  const keepsAgreedReplacement = outcome === "REPLACEMENT" && row.outcome === "REPLACEMENT" && row.replacementImei
  const shopStock = stock.filter((unit) => unit.branchId === row.branchId)
  const picked = shopStock.find((unit) => unit.id === pickedId)
  const balance = keepsAgreedReplacement
    ? row.balanceAmount ?? 0
    : picked
      ? picked.product.sellingPrice - returnValue
      : 0
  const receivable = Math.max(balance, 0)
  const payable = Math.max(-balance, 0)
  const refundOut = outcome === "REFUND" ? refundSplit(returnValue, row.invoice).paysBack : 0
  const choices = OUTCOME_CHOICES.filter((choice) => !("phoneOnly" in choice) || row.imei)

  return (
    <div className="mt-4 border-t border-border pt-4">
      <ActionForm
        action={completeReturn}
        submit={changed ? "Apply the changed outcome" : "Apply outcome"}
        className="space-y-3"
        onSuccess={onDone}
      >
        <input type="hidden" name="id" value={row.id} />

        {canReconfirm ? (
          <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3">
            <p className="text-sm font-semibold">Reconfirm before applying</p>
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium">Course of action</span>
              <Select name="outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                    {choice.value === row.outcome ? " (as approved)" : ""}
                  </option>
                ))}
              </Select>
            </label>
            {row.imei ? (
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Condition of what came back</span>
                <Select name="faultClass" value={condition} onChange={(event) => setCondition(event.target.value)}>
                  {CONDITION_CHOICES.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {changed ? (
              <p className="text-xs text-warning">
                Changed from {outcomeLabel(row.outcome)}. The change is kept on Who did what.
              </p>
            ) : null}
          </div>
        ) : null}

        {outcome === "REPLACEMENT" ? (
          <>
            {keepsAgreedReplacement ? (
              <input type="hidden" name="replacementImeiId" value={row.replacementImei!.id} />
            ) : (
              <Select
                name="replacementImeiId"
                required
                value={pickedId}
                onChange={(event) => setPickedId(event.target.value)}
                emptyLabel="No In shop unit is ready in this shop."
              >
                <option value="">Pick the item to give out</option>
                {shopStock.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {deviceLabel(unit)} · {unit.product.name} · {formatCurrency(unit.product.sellingPrice)}
                  </option>
                ))}
              </Select>
            )}
            {!keepsAgreedReplacement && picked ? <BalanceFigure balance={balance} /> : null}
            {receivable > 0 || payable > 0 ? (
              <Input
                name="paidAmount"
                type="number"
                key={`${pickedId}-${balance}`}
                defaultValue={receivable > 0 ? receivable : payable}
                placeholder={receivable > 0 ? "Amount received from customer (₦)" : "Amount paid to customer (₦)"}
              />
            ) : null}
            {payable > 0 ? (
              <>
                <input type="hidden" name="method" value="TRANSFER" />
                <BankPicker banks={banks} branchId={row.branchId} label="Pay the difference back from" required />
              </>
            ) : receivable > 0 ? (
              <>
                <Select name="method" value={method} onChange={(event) => setMethod(event.target.value)}>
                  <option value="CASH">Cash</option>
                  <option value="TRANSFER">Transfer</option>
                  <option value="POS">POS</option>
                </Select>
                {method !== "CASH" ? (
                  <BankPicker banks={banks} branchId={row.branchId} label="Which bank received it" required={false} />
                ) : null}
              </>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Stock moves on Apply. Collect the receivable or pay the payable so the books match the event.
            </p>
          </>
        ) : outcome === "REFUND" ? (
          <>
            <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              This will {refundWords(returnValue, row.invoice)} without editing the original invoice.
              {refundOut > 0 ? " Refunds are paid by bank." : ""}
            </p>
            {/* Only when money actually goes back: a refund on a sale still owed
                just clears the debt, with nothing to pay out. */}
            {refundOut > 0 ? (
              <BankPicker banks={banks} branchId={row.branchId} label="Pay the refund from" required />
            ) : null}
          </>
        ) : (
          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            This will{" "}
            {outcome === "REPAIR"
              ? "open a repair job for this phone"
              : outcome === "SEND_TO_SUPPLIER"
                ? "send this phone back to the supplier — it will not stay in this shop"
                : "post a credit note against what the customer owes"}{" "}
            without editing the original invoice.
          </p>
        )}
      </ActionForm>
    </div>
  )
}

// ─── Main list ────────────────────────────────────────────────────────────────

const RETURN_FILTERS = ["all", "PENDING", "APPROVED", "COMPLETED"] as const

export function ReturnsList({
  rows,
  stock,
  banks = [],
  canReconfirm = false,
  initialStatus,
}: {
  rows: ReturnRow[]
  stock: StockUnit[]
  banks?: RefundBank[]
  /** CEO and main admin: may change the course of action when applying. */
  canReconfirm?: boolean
  /** ?status= from the address bar, e.g. Home's link to approved returns. */
  initialStatus?: string
}) {
  const [status, setStatus] = useUrlFilter(initialStatus, RETURN_FILTERS)

  const filtered = useMemo(
    () => rows.filter((row) => (status === "all" ? true : row.status === status)),
    [rows, status]
  )

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { all: rows.length }
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    return byStatus
  }, [rows])

  const [open, setOpen] = useState<ReturnRow | null>(null)
  const whenOf = (row: ReturnRow) => row.completedAt ?? row.approvedAt ?? row.createdAt
  const valueOf = (row: ReturnRow) => row.returnValue ?? money(row.refundAmount)
  const itemName = (row: ReturnRow) => row.imei?.productName ?? row.saleItem?.productName ?? ""

  const columns: DataColumn<ReturnRow>[] = [
    {
      id: "number",
      header: "Return",
      sortValue: (row) => row.returnNumber,
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="whitespace-nowrap font-medium text-primary">{row.returnNumber}</span>
          <TypeTag row={row} />
        </div>
      ),
    },
    {
      id: "buyer",
      header: "Customer and item",
      sortValue: (row) => row.customer.name,
      cell: (row) => (
        <div className="min-w-0">
          <p className="font-medium">{row.customer.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {row.imei ? deviceLabel(row.imei) : ""}
            {row.imei && itemName(row) ? " · " : ""}
            {itemName(row)}
          </p>
        </div>
      ),
    },
    {
      id: "outcome",
      header: "Outcome",
      hideBelow: "lg",
      sortValue: (row) => outcomeLabel(row.outcome),
      cell: (row) => (
        <div>
          <p className="whitespace-nowrap">{outcomeLabel(row.outcome)}</p>
          <p className="text-xs text-muted-foreground">{reasonLabel(row.reason)}</p>
        </div>
      ),
    },
    {
      id: "value",
      header: "Value",
      align: "right",
      hideBelow: "xl",
      sortValue: (row) => valueOf(row) ?? 0,
      cell: (row) => (valueOf(row) != null ? formatCurrency(valueOf(row)) : "—"),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (row) => row.status,
      cell: (row) => (
        <div className="whitespace-nowrap">
          <StatusBadge value={row.status} />
          {row.status === "APPROVED" || row.status === "PENDING" ? <p className="mt-1 text-[11px] font-medium text-warning">Apply the outcome</p> : null}
          {offShelf(row) ? <p className="mt-1 text-[11px] font-medium text-warning">Not on the shelf</p> : null}
        </div>
      ),
    },
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
          { key: "all",       label: "All returns", count: counts.all,              hint: "Every item brought back" },
          { key: "PENDING",   label: "Waiting",     count: counts.PENDING   ?? 0,   hint: "From before: finish it" },
          { key: "APPROVED",  label: "Approved",    count: counts.APPROVED  ?? 0,   hint: "From before: finish it" },
          { key: "COMPLETED", label: "Done",        count: counts.COMPLETED ?? 0,   hint: "Refund or replace applied" },
        ]}
      />

      <DataTable
        rows={filtered}
        columns={columns}
        rowKey={(row) => row.id}
        noun="returns"
        filterKey={status}
        onRowClick={setOpen}
        searchText={(row) =>
          [row.returnNumber, row.customer.name, row.imei?.imei1, row.imei?.serialNumber, itemName(row), row.invoice?.invoiceNumber]
            .filter(Boolean)
            .join(" ")
        }
        searchPlaceholder="Search return, customer, IMEI or invoice"
        card={(row) => ({
          title: row.customer.name,
          subtitle: `${row.returnNumber} · ${itemName(row) || "No item recorded"}`,
          value: valueOf(row) != null ? formatCurrency(valueOf(row)) : undefined,
          badge: <StatusBadge value={row.status} />,
          meta: (
            <>
              <span>{outcomeLabel(row.outcome)}</span>
              <span>· {formatShopWhen(whenOf(row))}</span>
              {row.status === "APPROVED" || row.status === "PENDING" ? <span className="font-medium text-warning">· Apply the outcome</span> : null}
              {offShelf(row) ? <span className="font-medium text-warning">· Not on the shelf</span> : null}
            </>
          ),
        })}
        empty={rows.length === 0 ? "No returns on the books yet." : "No return matches this stage. Tap another step above."}
      />

      <Sheet open={Boolean(open)} onOpenChange={(value) => !value && setOpen(null)}>
        {open ? (
          <SheetContent
            title={open.returnNumber}
            description={`${open.customer.name} · ${formatShopWhen(whenOf(open))}`}
            className="sm:w-[520px]"
          >
            <ReturnDetail row={open} stock={stock} banks={banks} canReconfirm={canReconfirm} onDone={() => setOpen(null)} />
          </SheetContent>
        ) : null}
      </Sheet>
    </div>
  )
}

function ReturnDetail({
  row,
  stock,
  banks,
  canReconfirm,
  onDone,
}: {
  row: ReturnRow
  stock: StockUnit[]
  banks: RefundBank[]
  canReconfirm: boolean
  onDone: () => void
}) {
  const returnValue = row.returnValue ?? money(row.refundAmount)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge value={row.status} />
        <TypeTag row={row} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Customer</dt>
        <dd>
          <Link href={`/customers/${row.customer.id}`} className="font-medium text-primary hover:underline">
            {row.customer.name}
          </Link>
        </dd>
        <dt className="text-muted-foreground">Item</dt>
        <dd><ItemChip row={row} /></dd>
        {row.invoice ? (
          <>
            <dt className="text-muted-foreground">Invoice</dt>
            <dd>
              <Link href={`/sales/${row.invoice.id}`} className="text-primary hover:underline">
                {row.invoice.invoiceNumber}
              </Link>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Outcome</dt>
        <dd className="font-medium">{outcomeLabel(row.outcome)}</dd>
        <dt className="text-muted-foreground">Reason</dt>
        <dd>{reasonLabel(row.reason)}</dd>
        {returnValue != null ? (
          <>
            <dt className="text-muted-foreground">Return value</dt>
            <dd className="tabular-nums">{formatCurrency(returnValue)}</dd>
          </>
        ) : null}
        {row.outcome === "REPLACEMENT" ? (
          <>
            <dt className="text-muted-foreground">Replacement</dt>
            <dd>
              {row.replacementImei
                ? `${deviceLabel(row.replacementImei)}${row.replacementImei.productName ? ` · ${row.replacementImei.productName}` : ""}${row.replacementValue != null ? ` · ${formatCurrency(row.replacementValue)}` : ""}`
                : "Not locked yet"}
            </dd>
          </>
        ) : null}
      </dl>
      <BalanceLine row={row} />
      {row.notes ? <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">{row.notes}</p> : null}
      {row.status === "PENDING" ? (
        <p className="rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
          Logged before returns took effect on their own. Apply it below to bring the item back into stock and settle the money.
        </p>
      ) : null}
      {row.status === "APPROVED" || row.status === "PENDING" ? (
        <ApplyForm row={row} stock={stock} banks={banks} canReconfirm={canReconfirm} onDone={onDone} />
      ) : null}
      {offShelf(row) ? (
        <div className="space-y-2 rounded-xl border border-warning/30 bg-warning-soft/50 p-3">
          <p className="text-sm">
            This return was finished as <span className="font-semibold">{row.faultClass === "SCRAP_STOCK" ? "written off" : "not for sale"}</span>, so
            the item is not in Shop stock. If it is fine to sell, put it back on the shelf.
          </p>
          <ActionForm
            action={restockReturn}
            submit="Put back on the shelf"
            successMessage="Back on the shelf. It shows in Shop stock and on Sell now."
            size="sm"
            onSuccess={onDone}
          >
            <input type="hidden" name="id" value={row.id} />
          </ActionForm>
        </div>
      ) : null}
    </div>
  )
}
