"use client"

import { useMemo, useState } from "react"
import { Package, Smartphone, Search, ReceiptText, Info, AlertCircle, ScanLine, X } from "lucide-react"
import { toast } from "sonner"
import { createReturn, findReplacementUnit, findSoldImei, findSaleByInvoice } from "@/app/actions/ops"
import type { SaleReturnRoom } from "@/lib/return-limits"
import { ActionForm } from "@/components/action-form"
import { DifferenceSettle } from "@/components/difference-settle"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { formatCurrency, money } from "@/lib/utils"
import { warrantyState } from "@/lib/warranty"
import { cn } from "@/lib/utils"

// ─── Types ────────────────────────────────────────────────────────────────────

type Sold = {
  id: string
  imei1: string
  serialNumber?: string | null
  branchId: string
  product: { name: string; sellingPrice: number; warrantyDays: number }
  customer: { name: string } | null
  sale: {
    invoiceNumber: string
    saleDate: Date
    items: Array<{ imeiId: string | null; totalPrice: number }>
  } | null
  branch: { code: string }
}

type SaleLineItem = {
  id: string
  productId: string
  quantity: number
  unitPrice: number
  totalPrice: number
  product: {
    name: string
    sellingPrice: number
    category: { name: string } | null
  }
  imei: { imei1: string } | null
}

type FoundSale = {
  id: string
  invoiceNumber: string
  saleDate: Date
  branchId: string
  customer: { id: string; name: string } | null
  branch: { code: string; name: string }
  items: SaleLineItem[]
}

export type ReturnBank = { id: string; label: string; branchId: string }

/** Money goes back by bank from a named account; this shop's accounts first. */
function BankSelect({ banks, branchId, label, required }: { banks: ReturnBank[]; branchId: string | null; label: string; required: boolean }) {
  const ordered = [...banks].sort((a, b) => Number(b.branchId === branchId) - Number(a.branchId === branchId))
  if (!banks.length) {
    return (
      <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
        No bank account is listed yet. Add one under Money in &amp; out before paying money back.
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor="return-bank-select">{label}</Label>
      <Select id="return-bank-select" name="bankAccountId" required={required} defaultValue="">
        <option value="">{required ? "Pick the bank account" : "Pick the bank account (when money goes back)"}</option>
        {ordered.map((bank) => (
          <option key={bank.id} value={bank.id}>
            {bank.label}
          </option>
        ))}
      </Select>
    </div>
  )
}

type StockUnit = {
  id: string
  imei1: string
  serialNumber: string | null
  branchId: string
  product: { name: string; sellingPrice: number }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REASONS = [
  { value: "FAULTY", label: "Faulty" },
  { value: "WARRANTY", label: "Under warranty" },
  { value: "CUSTOMER_DISSATISFACTION", label: "Dissatisfaction / change of mind" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "WRONG_PRODUCT", label: "Wrong product" },
  { value: "EXCHANGE", label: "Replacement (wants another item)" },
  { value: "SUPPLIER_RETURN", label: "Send toward supplier" },
] as const

/**
 * A return from the shop floor is a return inward: it comes back into the
 * shop. Only these reasons, and only a replacement from our stock or a refund.
 * Anything beyond the shop is for the Vault Manager, Manager, CEO or main
 * admin (the server holds the same rule).
 */
const INWARD_REASONS = [
  { value: "FAULTY", label: "Faulty" },
  { value: "CUSTOMER_DISSATISFACTION", label: "Dissatisfaction / change of mind" },
  { value: "EXCHANGE", label: "Replacement (wants another item)" },
] as const

const FAULTS = [
  { value: "GOOD_STOCK", label: "Good — put back on shelf" },
  { value: "FAULTY_STOCK", label: "Faulty — not for sale" },
  { value: "REPAIR_STOCK", label: "Needs repair" },
  { value: "SCRAP_STOCK", label: "Scrap — write off" },
] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deviceLabel(row: { imei1: string; serialNumber?: string | null }) {
  if (row.serialNumber && row.serialNumber !== row.imei1) return `${row.imei1} · serial ${row.serialNumber}`
  return row.imei1
}

function mapFoundSold(row: {
  id: string
  imei1: string
  serialNumber: string | null
  branchId: string
  product: { name: string; sellingPrice: unknown; warrantyDays: number }
  customer: { name: string } | null
  sale: {
    invoiceNumber: string
    saleDate: Date
    items: Array<{ imeiId: string | null; totalPrice: unknown }>
  } | null
  branch: { code: string }
}): Sold {
  return {
    id: row.id,
    imei1: row.imei1,
    serialNumber: row.serialNumber,
    branchId: row.branchId,
    product: {
      name: row.product.name,
      sellingPrice: money(row.product.sellingPrice),
      warrantyDays: row.product.warrantyDays,
    },
    customer: row.customer ? { name: row.customer.name } : null,
    sale: row.sale
      ? {
          invoiceNumber: row.sale.invoiceNumber,
          saleDate: row.sale.saleDate,
          items: row.sale.items.map((item) => ({
            imeiId: item.imeiId,
            totalPrice: money(item.totalPrice),
          })),
        }
      : null,
    branch: { code: row.branch.code },
  }
}

function mapFoundSale(raw: {
  id: string
  invoiceNumber: string
  saleDate: Date
  branchId: string
  customer: { id: string; name: string } | null
  branch: { code: string; name: string }
  items: Array<{
    id: string
    productId: string
    quantity: number
    unitPrice: unknown
    totalPrice: unknown
    product: {
      name: string
      sellingPrice: unknown
      category: { name: string } | null
    }
    imei: { imei1: string } | null
  }>
}): FoundSale {
  return {
    id: raw.id,
    invoiceNumber: raw.invoiceNumber,
    saleDate: raw.saleDate,
    branchId: raw.branchId,
    customer: raw.customer,
    branch: raw.branch,
    items: raw.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: money(item.unitPrice),
      totalPrice: money(item.totalPrice),
      product: {
        name: item.product.name,
        sellingPrice: money(item.product.sellingPrice),
        category: item.product.category,
      },
      imei: item.imei ? { imei1: item.imei.imei1 } : null,
    })),
  }
}

// ─── Tab Switcher ─────────────────────────────────────────────────────────────

function TabBar({
  active,
  onChange,
}: {
  active: "imei" | "invoice"
  onChange: (v: "imei" | "invoice") => void
}) {
  return (
    <div className="flex rounded-xl border border-border bg-muted/40 p-1 gap-1">
      <button
        type="button"
        onClick={() => onChange("imei")}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          active === "imei"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Smartphone className="h-4 w-4 shrink-0" />
        Phone or laptop
      </button>
      <button
        type="button"
        onClick={() => onChange("invoice")}
        className={cn(
          "flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          active === "invoice"
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Package className="h-4 w-4 shrink-0" />
        Other item by invoice
      </button>
    </div>
  )
}

// ─── Replacement going out: scan or type its IMEI ─────────────────────────────

const unitCode = (value: string) => value.replace(/[\s-]/g, "").toUpperCase()

/**
 * The client asked not to scroll a drop-down of nearly every item in the shop:
 * "we just scan in, it logs that particular phone's details, provided it has
 * been uploaded on the system". Scan or type the IMEI (or serial) of the item
 * in hand. A full code fills it in at once; part of a code, a serial or a
 * model name lists the few that match. A code not in the loaded list is looked
 * up across the whole stock, which also says why a unit cannot go out.
 */
function ReplacementPicker({
  stock,
  branchId,
  picked,
  onPick,
}: {
  stock: StockUnit[]
  branchId: string | null
  picked: StockUnit | null
  onPick: (unit: StockUnit | null) => void
}) {
  const [query, setQuery] = useState("")
  const [finding, setFinding] = useState(false)
  const code = unitCode(query)
  const words = query.trim().toLowerCase()

  const exactHit = (value: string) =>
    stock.find((row) => unitCode(row.imei1) === value || (row.serialNumber && unitCode(row.serialNumber) === value))

  const matches = useMemo(() => {
    if (code.length < 3 && words.length < 3) return []
    return stock
      .filter(
        (row) =>
          (code.length >= 3 &&
            (unitCode(row.imei1).includes(code) || (row.serialNumber ? unitCode(row.serialNumber).includes(code) : false))) ||
          (words.length >= 3 && row.product.name.toLowerCase().includes(words))
      )
      .slice(0, 8)
  }, [stock, code, words])

  function choose(unit: StockUnit) {
    onPick(unit)
    setQuery("")
  }

  async function lookUp() {
    if (!code) {
      toast.error("Type or scan the IMEI of the item going out.")
      return
    }
    const local = exactHit(code)
    if (local) return choose(local)
    // Part of a code that points at one unit only is enough.
    if (matches.length === 1) return choose(matches[0])
    setFinding(true)
    const result = await findReplacementUnit(code, branchId)
    setFinding(false)
    if ("error" in result && result.error) {
      toast.error(result.error)
      return
    }
    if ("unit" in result && result.unit) {
      choose(result.unit)
      toast.success("Item found. Check the details below.")
    }
  }

  function onType(value: string) {
    setQuery(value)
    // A scanner that sends no Enter still lands: a full code that only one
    // unit has (and that is not the start of a longer one) is taken at once.
    const next = unitCode(value)
    const hit = next.length >= 5 ? exactHit(next) : undefined
    const longer = stock.some(
      (row) =>
        (unitCode(row.imei1).startsWith(next) && unitCode(row.imei1) !== next) ||
        (row.serialNumber ? unitCode(row.serialNumber).startsWith(next) && unitCode(row.serialNumber) !== next : false)
    )
    if (hit && !longer) choose(hit)
  }

  if (picked) {
    return (
      <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
        <input type="hidden" name="replacementImeiId" value={picked.id} />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{picked.product.name}</p>
          <p className="mt-0.5 break-all text-xs text-muted-foreground">
            {deviceLabel(picked)} · {formatCurrency(picked.product.sellingPrice)}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onPick(null)} className="shrink-0">
          <X className="h-4 w-4" /> Change
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          id="replacement-scan-input"
          value={query}
          onChange={(e) => onType(e.target.value)}
          placeholder="Type or scan the IMEI or serial"
          aria-label="Type or scan the IMEI or serial of the item going out"
          autoComplete="off"
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void lookUp()
            }
          }}
        />
        <Button type="button" variant="outline" onClick={() => void lookUp()} disabled={finding} className="shrink-0">
          {finding ? "Looking up" : <><Search className="h-4 w-4" /> Find</>}
        </Button>
      </div>
      {matches.length ? (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-background">
          {matches.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => choose(row)}
                className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50 focus:bg-muted/50 focus:outline-none"
              >
                <span className="font-medium">{row.product.name}</span>
                <span className="block break-all text-xs text-muted-foreground">
                  {deviceLabel(row)} · {formatCurrency(row.product.sellingPrice)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ScanLine className="h-3.5 w-3.5 shrink-0" />
          {words.length >= 3
            ? "Nothing in the list matches. Press Enter or Find to look it up in the whole stock."
            : "Scan the phone, or type its IMEI, serial or model. Its details fill in from the system."}
        </p>
      )}
    </div>
  )
}

// ─── Shared outcome + fault + notes fields ────────────────────────────────────

function OutcomeFields({
  outcome,
  onOutcomeChange,
  returnValue,
  onReturnValueChange,
  suggestedReturn,
  maxReturn,
  shopStock,
  branchId,
  isInvoicePath,
  fullControl,
  banks,
}: {
  banks: ReturnBank[]
  /** The most this return may be worth: what the item sold for, less earlier returns. */
  maxReturn?: number
  outcome: string
  onOutcomeChange: (v: string) => void
  returnValue: string
  onReturnValueChange: (v: string) => void
  suggestedReturn: number
  shopStock: StockUnit[]
  branchId: string | null
  isInvoicePath: boolean
  /** Vault Manager, Manager, CEO, main admin: every reason and outcome. */
  fullControl: boolean
}) {
  const [picked, setPicked] = useState<StockUnit | null>(null)
  const [reason, setReason] = useState("FAULTY")
  const [replacementValue, setReplacementValue] = useState("")
  const [payMethod, setPayMethod] = useState("CASH")

  const filteredStock = branchId ? shopStock.filter((r) => r.branchId === branchId) : shopStock
  // A unit from another shop drops away when the sold device changes shop.
  const pickedReplacement = picked && (!branchId || picked.branchId === branchId) ? picked : null
  const replacementId = pickedReplacement?.id ?? ""
  const returnAmount = Number(returnValue !== "" ? returnValue : suggestedReturn || 0)
  const givenAmount = Number(replacementValue || 0)
  const balance = givenAmount - returnAmount
  const isReplace = outcome === "REPLACEMENT"

  // Reset replacement when outcome changes
  const handleOutcome = (v: string) => {
    onOutcomeChange(v)
    setPicked(null)
    setReplacementValue("")
  }

  // Outcomes available for non-IMEI items (no send-to-supplier, no repair for accessories)
  const outcomeOptions = !fullControl
    ? [
        { value: "REPLACEMENT", label: "Replacement from our stock" },
        { value: "REFUND", label: "Refund (paid by bank)" },
      ]
    : isInvoicePath
    ? [
        { value: "REFUND", label: "Refund" },
        { value: "CREDIT_NOTE", label: "Credit note" },
        { value: "REPLACEMENT", label: "Replace from our stock" },
        { value: "RESTOCK", label: "Put back on the shelf (nothing back to the customer)" },
      ]
    : [
        { value: "REPAIR", label: "Repair" },
        { value: "REPLACEMENT", label: "Replace from our stock" },
        { value: "REFUND", label: "Refund" },
        { value: "CREDIT_NOTE", label: "Credit note" },
        { value: "SEND_TO_SUPPLIER", label: "Send back to the supplier" },
        { value: "RESTOCK", label: "Put back on the shelf (nothing back to the customer)" },
      ]

  return (
    <div className="space-y-3">
      {/* Return reason */}
      <div className="space-y-1.5">
        <Label htmlFor="reason-select">Why is it coming back?</Label>
        <Select id="reason-select" name="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {(fullControl ? REASONS : INWARD_REASONS).map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </Select>
      </div>

      {/* Outcome */}
      <div className="space-y-1.5">
        <Label htmlFor="outcome-select">What happens next?</Label>
        <Select
          id="outcome-select"
          name="outcome"
          value={outcome}
          onChange={(e) => handleOutcome(e.target.value)}
          required
        >
          {outcomeOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </div>

      {/* On the shop floor the condition follows the reason: the item always
          comes back into the shop. */}
      {!fullControl ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          It comes back into this shop&apos;s stock, ready to sell. If it is broken, a manager can mark it Damaged on its phone page.
        </p>
      ) : null}

      {/* Fault classification — not needed for refund/credit on accessories */}
      {fullControl && outcome !== "RESTOCK" && (!isInvoicePath || (outcome !== "REFUND" && outcome !== "CREDIT_NOTE")) && (
        <div className="space-y-1.5">
          <Label htmlFor="fault-select">Condition of the returned item</Label>
          <Select id="fault-select" name="faultClass" defaultValue="GOOD_STOCK">
            {FAULTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* Return value */}
      <div className="space-y-1.5">
        <Label htmlFor="return-value-input">Return item value (₦)</Label>
        <Input
          id="return-value-input"
          name="returnValue"
          type="number"
          min={0}
          max={maxReturn != null ? maxReturn : undefined}
          step="0.01"
          value={returnValue !== "" ? returnValue : String(suggestedReturn || "")}
          onChange={(e) => onReturnValueChange(e.target.value)}
          placeholder="Return item value"
          aria-invalid={maxReturn != null && returnAmount > maxReturn + 0.005}
          required
        />
        {maxReturn != null && returnAmount > maxReturn + 0.005 ? (
          <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
            <Info className="h-3.5 w-3.5 shrink-0" />
            That is more than it sold for. The most that can be returned is {formatCurrency(maxReturn)}.
          </p>
        ) : maxReturn != null ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" />
            The most that can be returned is {formatCurrency(maxReturn)}, what it sold for on the invoice. It can be
            less, never more.
          </p>
        ) : suggestedReturn > 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 shrink-0" />
            Suggested from original sale: {formatCurrency(suggestedReturn)}
          </p>
        ) : null}
      </div>

      {/* Replacement picker */}
      {isReplace && (
        <div className="rounded-xl border border-border bg-muted/30 p-3.5 space-y-3">
          <p className="text-sm font-medium">Replacement item going out</p>
          <div className="space-y-1.5">
            <Label htmlFor="replacement-scan-input">Item going out (In shop)</Label>
            <ReplacementPicker
              stock={filteredStock}
              branchId={branchId}
              picked={pickedReplacement}
              onPick={(unit) => {
                setPicked(unit)
                setReplacementValue(unit ? String(unit.product.sellingPrice) : "")
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="replacement-value-input">Value of item given out (₦)</Label>
            <Input
              id="replacement-value-input"
              name="replacementValue"
              type="number"
              min={0}
              value={replacementValue}
              onChange={(e) => setReplacementValue(e.target.value)}
              placeholder="Value of the replacement"
              required
            />
            {pickedReplacement && (
              <p className="text-xs text-muted-foreground">
                List price: {formatCurrency(pickedReplacement.product.sellingPrice)}. Change if a different figure was agreed.
              </p>
            )}
          </div>
          {/* Balance indicator */}
          <div
            className={cn(
              "rounded-lg border px-3 py-2 text-sm font-medium",
              !replacementId || !Number.isFinite(returnAmount)
                ? "border-border bg-muted/30 text-muted-foreground"
                : balance > 0
                  ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400"
                  : balance < 0
                    ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-400"
                    : "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-400"
            )}
          >
            {!replacementId || !Number.isFinite(returnAmount)
              ? "Balance shows after you pick the replacement and both values."
              : balance > 0
                ? `Receivable — customer pays us ${formatCurrency(balance)}`
                : balance < 0
                  ? `Payable — we refund the customer ${formatCurrency(Math.abs(balance))}`
                  : "Balance is even — no money either way."}
          </div>
          {replacementId && Number.isFinite(returnAmount) && balance !== 0 ? (
            <div className="border-t border-border pt-3">
              <DifferenceSettle
                key={`${replacementId}-${balance}`}
                balance={balance}
                moneyFields={
                  balance > 0 ? (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="settle-method-select">How they paid</Label>
                        <Select id="settle-method-select" name="method" value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                          <option value="CASH">Cash</option>
                          <option value="TRANSFER">Bank transfer</option>
                          <option value="POS">POS</option>
                        </Select>
                      </div>
                      {payMethod !== "CASH" ? <BankSelect banks={banks} branchId={branchId} label="Bank that received it" required={false} /> : null}
                    </>
                  ) : (
                    <>
                      <input type="hidden" name="method" value="TRANSFER" />
                      <BankSelect banks={banks} branchId={branchId} label="Pay the difference back from" required />
                    </>
                  )
                }
              />
            </div>
          ) : null}
        </div>
      )}

      {(outcome === "REFUND" || outcome === "CREDIT_NOTE") && !isReplace && (
        <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {outcome === "REFUND"
            ? "The refund uses the return item value above. Anything the customer still owed on the invoice is cleared first; only what they paid comes back, by bank."
            : "Credit note will use the return item value above."}{" "}
          The original invoice stays on the books.
        </p>
      )}
      {outcome === "RESTOCK" ? (
        <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          It goes back In shop, ready to sell. What the customer still owes on the invoice is cleared; no refund or credit
          goes out. If they paid toward it, pick Refund or Credit note instead.
        </p>
      ) : null}
      {outcome === "REFUND" && !isReplace ? (
        <BankSelect banks={banks} branchId={branchId} label="Pay the refund from" required={false} />
      ) : null}

      {/* Notes */}
      <div className="space-y-1.5">
        <Label htmlFor="notes-textarea">Notes (optional)</Label>
        <Textarea id="notes-textarea" name="notes" placeholder="What the customer told you" />
      </div>
    </div>
  )
}

// ─── IMEI path sub-form ───────────────────────────────────────────────────────

function ImeiReturnForm({
  sold,
  stock,
  successHref,
  fullControl,
  banks,
}: {
  sold: Sold[]
  stock: StockUnit[]
  successHref?: string
  fullControl: boolean
  banks: ReturnBank[]
}) {
  const [extraSold, setExtraSold] = useState<Sold[]>([])
  const [findCode, setFindCode] = useState("")
  const [finding, setFinding] = useState(false)
  const [outcome, setOutcome] = useState(fullControl ? "REPAIR" : "REPLACEMENT")
  const [returnValue, setReturnValue] = useState("")

  const soldList = useMemo(() => {
    const seen = new Set(sold.map((r) => r.imei1))
    return [...sold, ...extraSold.filter((r) => !seen.has(r.imei1))]
  }, [sold, extraSold])

  const [imei1, setImei1] = useState(sold[0]?.imei1 ?? "")
  const selected = useMemo(() => soldList.find((r) => r.imei1 === imei1), [soldList, imei1])
  const line = selected?.sale?.items.find((item) => item.imeiId === selected.id)
  const suggestedReturn = money(line?.totalPrice) || money(selected?.product.sellingPrice)
  const warranty = selected?.sale ? warrantyState(selected.sale.saleDate, selected.product.warrantyDays) : null

  function pickSold(next: string, list: Sold[] = soldList) {
    setImei1(next)
    const hit = list.find((r) => r.imei1 === next)
    const nextLine = hit?.sale?.items.find((item) => item.imeiId === hit.id)
    const nextValue = money(nextLine?.totalPrice) || money(hit?.product.sellingPrice)
    setReturnValue(nextValue ? String(nextValue) : "")
  }

  async function lookupSold() {
    const code = findCode.trim()
    if (!code) { toast.error("Type or paste the sold IMEI first."); return }
    setFinding(true)
    const result = await findSoldImei(code)
    setFinding(false)
    if ("error" in result && result.error) { toast.error(result.error); return }
    if (!("sold" in result) || !result.sold) { toast.error("That IMEI was not found."); return }
    const mapped = mapFoundSold(result.sold)
    const nextList = [...extraSold.filter((r) => r.imei1 !== mapped.imei1), mapped]
    setExtraSold(nextList)
    pickSold(mapped.imei1, [...sold, ...nextList])
    setFindCode("")
    toast.success("Sold phone found. Check the details below.")
  }

  return (
    <ActionForm
      action={createReturn}
      successHref={successHref}
      submit="Save return"
      successMessage="Return saved. The item is back in this shop's stock."
      confirmModal={{
        title: "Save this return?",
        description: "It takes effect now: the item comes back into this shop's stock, and the refund or replacement is settled. No approval is needed.",
        confirmLabel: "Save return",
        tone: "warning",
      }}
      className="space-y-4"
    >
      <input type="hidden" name="returnMode" value="imei" />

      {/* Find by IMEI */}
      <div className="rounded-xl border border-border bg-muted/30 p-3.5 space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Find IMEI not in the list below
        </p>
        <div className="flex gap-2">
          <Input
            value={findCode}
            onChange={(e) => setFindCode(e.target.value)}
            placeholder="Type or scan the sold IMEI"
            aria-label="Type or scan the sold IMEI"
            className="flex-1"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void lookupSold() } }}
          />
          <Button type="button" variant="outline" onClick={() => void lookupSold()} disabled={finding} className="shrink-0">
            {finding ? "Looking up" : <><Search className="h-4 w-4" /> Find</>}
          </Button>
        </div>
      </div>

      {/* Sold device picker */}
      <div className="space-y-1.5">
        <Label htmlFor="imei-select">Sold device</Label>
        <Select
          id="imei-select"
          name="imei1"
          value={imei1}
          onChange={(e) => pickSold(e.target.value)}
          required
          emptyLabel="This shop has not sold any device yet. A return needs a device that was sold with a buyer name."
        >
          {soldList.map((row) => (
            <option key={row.imei1} value={row.imei1}>
              {deviceLabel(row)} · {row.product.name} · {row.customer?.name ?? "Walk-in"}
            </option>
          ))}
        </Select>
      </div>

      {/* Selected device card */}
      {selected ? (
        <div className="rounded-xl border border-border bg-card p-3.5 space-y-1">
          <p className="font-semibold text-sm">{selected.product.name}</p>
          <p className="text-xs text-muted-foreground">
            {deviceLabel(selected)}
            {selected.sale ? ` · Invoice ${selected.sale.invoiceNumber}` : ""}
            {" · "}{selected.branch.code}
          </p>
          {selected.customer && (
            <p className="text-xs text-muted-foreground">Buyer: {selected.customer.name}</p>
          )}
          {!selected.sale ? (
            <p className="rounded-lg bg-info-soft px-2.5 py-1.5 text-xs text-info">
              Given out on a Swap Deal that was not settled yet. Saving this return settles that swap first (writes its
              invoice; anything the customer still owed on it goes on their account), then takes the phone back.
            </p>
          ) : null}
          {warranty && (
            <p className={cn(
              "text-xs font-medium",
              warranty.active ? "text-green-600 dark:text-green-400" : "text-muted-foreground"
            )}>
              {warranty.label}
            </p>
          )}
          <p className="text-xs font-medium pt-0.5">
            Original sale line: {formatCurrency(suggestedReturn)}
          </p>
        </div>
      ) : (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
          <AlertCircle className="h-4 w-4 shrink-0" />
          No device found. Use the search above, or attach a buyer name on the invoice first.
        </p>
      )}

      <OutcomeFields
        outcome={outcome}
        onOutcomeChange={setOutcome}
        returnValue={returnValue}
        onReturnValueChange={setReturnValue}
        suggestedReturn={suggestedReturn}
        // A phone can be returned for what it sold for on its invoice, never more.
        maxReturn={suggestedReturn > 0 ? suggestedReturn : undefined}
        shopStock={stock}
        branchId={selected?.branchId ?? null}
        isInvoicePath={false}
        fullControl={fullControl}
        banks={banks}
      />
    </ActionForm>
  )
}

// ─── Invoice path sub-form ────────────────────────────────────────────────────

function InvoiceReturnForm({
  stock,
  successHref,
  fullControl,
  banks,
}: {
  stock: StockUnit[]
  successHref?: string
  fullControl: boolean
  banks: ReturnBank[]
}) {
  const [invoiceInput, setInvoiceInput] = useState("")
  const [finding, setFinding] = useState(false)
  const [foundSale, setFoundSale] = useState<FoundSale | null>(null)
  // What can still come back on each line, from the server: pieces left,
  // what each sold for after any order discount, and the value left.
  const [room, setRoom] = useState<SaleReturnRoom | null>(null)
  const [selectedItemId, setSelectedItemId] = useState("")
  const [returnQty, setReturnQty] = useState("1")
  const [outcome, setOutcome] = useState("REFUND")
  const [returnValue, setReturnValue] = useState("")

  async function lookupInvoice() {
    const inv = invoiceInput.trim()
    if (!inv) { toast.error("Type the invoice number first."); return }
    setFinding(true)
    const result = await findSaleByInvoice(inv)
    setFinding(false)
    if ("error" in result && result.error) { toast.error(result.error); return }
    if (!("sale" in result) || !result.sale) { toast.error("Invoice not found."); return }
    // Filter out IMEI items — they must go through the IMEI path
    const mapped = mapFoundSale(result.sale)
    const nonImeiItems = mapped.items.filter((item) => !item.imei)
    if (nonImeiItems.length === 0) {
      toast.error("That invoice has only phones or laptops. Use the Phone or laptop tab to return them by IMEI.")
      return
    }
    const nextRoom = "room" in result && result.room ? result.room : null
    const stillReturnable = nonImeiItems.filter((item) => (nextRoom?.lines[item.id]?.qtyLeft ?? item.quantity) > 0)
    if (stillReturnable.length === 0) {
      toast.error(`Everything on invoice ${mapped.invoiceNumber} that can be returned here has already been returned.`)
      return
    }
    setFoundSale({ ...mapped, items: nonImeiItems })
    setRoom(nextRoom)
    const first = stillReturnable[0]
    setSelectedItemId(first.id)
    const firstRoom = nextRoom?.lines[first.id]
    setReturnValue(
      String(
        firstRoom
          ? Math.min(firstRoom.unitSold, firstRoom.valueLeft, nextRoom!.saleLeft)
          : first.totalPrice / Math.max(1, first.quantity)
      )
    )
    setReturnQty("1")
    toast.success(`Invoice ${mapped.invoiceNumber} found — ${nonImeiItems.length} item${nonImeiItems.length !== 1 ? "s" : ""} available.`)
  }

  const selectedItem = foundSale?.items.find((item) => item.id === selectedItemId)
  const lineRoom = (itemId: string) => room?.lines[itemId] ?? null
  const selectedRoom = selectedItem ? lineRoom(selectedItem.id) : null
  // Pieces that can still come back on this line (earlier returns taken off).
  const qtyLeft = selectedItem ? selectedRoom?.qtyLeft ?? selectedItem.quantity : 1
  const qty = Math.max(1, Math.min(Number(returnQty) || 1, Math.max(1, qtyLeft)))
  const unitPrice = selectedItem
    ? selectedRoom?.unitSold ?? selectedItem.totalPrice / Math.max(1, selectedItem.quantity)
    : 0
  /** The most `count` pieces of a line may be returned for. */
  const limitFor = (itemId: string, count: number) => {
    const item = foundSale?.items.find((i) => i.id === itemId)
    if (!item) return 0
    const line = lineRoom(itemId)
    const unit = line?.unitSold ?? item.totalPrice / Math.max(1, item.quantity)
    return Math.round(Math.min(unit * count, line?.valueLeft ?? unit * count, room?.saleLeft ?? unit * count) * 100) / 100
  }
  const maxReturn = selectedItem ? limitFor(selectedItem.id, qty) : undefined
  const suggestedReturn = maxReturn ?? unitPrice * qty

  function handleItemChange(itemId: string) {
    setSelectedItemId(itemId)
    const item = foundSale?.items.find((i) => i.id === itemId)
    if (item) {
      setReturnValue(String(limitFor(itemId, 1)))
      setReturnQty("1")
    }
  }

  function handleQtyChange(v: string) {
    setReturnQty(v)
    const n = Number(v) || 1
    const newQty = Math.max(1, Math.min(n, Math.max(1, qtyLeft)))
    if (selectedItem) setReturnValue(String(limitFor(selectedItem.id, newQty)))
  }

  return (
    <ActionForm
      action={createReturn}
      successHref={successHref}
      submit="Save return"
      successMessage="Return saved. The item is back in this shop's stock."
      confirmModal={{
        title: "Save this return?",
        description: "It takes effect now: the item comes back into this shop's stock, and the refund or replacement is settled. No approval is needed.",
        confirmLabel: "Save return",
        tone: "warning",
      }}
      className="space-y-4"
    >
      <input type="hidden" name="returnMode" value="invoice" />
      {selectedItem && <input type="hidden" name="saleItemId" value={selectedItem.id} />}
      {selectedItem && <input type="hidden" name="returnQty" value={String(qty)} />}

      {/* Invoice lookup */}
      <div className="space-y-2">
        <Label htmlFor="invoice-input">Invoice number</Label>
        <div className="flex gap-2">
          <Input
            id="invoice-input"
            value={invoiceInput}
            onChange={(e) => setInvoiceInput(e.target.value.toUpperCase())}
            placeholder="e.g. INV-20260921-0042"
            aria-label="Invoice number"
            className="flex-1 font-mono"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void lookupInvoice() } }}
          />
          <Button type="button" variant="outline" onClick={() => void lookupInvoice()} disabled={finding} className="shrink-0">
            {finding ? "Looking up" : <><Search className="h-4 w-4" /> Find</>}
          </Button>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ReceiptText className="h-3.5 w-3.5 shrink-0" />
          Type the invoice number from the receipt. The items on that sale will appear below.
        </p>
      </div>

      {/* Found sale summary */}
      {foundSale && (
        <div className="rounded-xl border border-border bg-card p-3.5 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">{foundSale.invoiceNumber}</p>
              <p className="text-xs text-muted-foreground">
                {foundSale.branch.name}
                {foundSale.customer ? ` · ${foundSale.customer.name}` : ""}
              </p>
            </div>
            <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 dark:border-green-800 dark:bg-green-950/30 dark:text-green-400">
              Invoice found
            </span>
          </div>

          {/* Item picker */}
          <div className="space-y-1.5 pt-1">
            <Label htmlFor="item-select">Which item is being returned?</Label>
            <Select
              id="item-select"
              value={selectedItemId}
              onChange={(e) => handleItemChange(e.target.value)}
              required
            >
              {foundSale.items.map((item) => (
                <option key={item.id} value={item.id} disabled={(lineRoom(item.id)?.qtyLeft ?? item.quantity) <= 0}>
                  {item.product.name}
                  {item.product.category ? ` (${item.product.category.name})` : ""}
                  {" · "}Qty {item.quantity}
                  {" · "}{formatCurrency(item.totalPrice)}
                  {(lineRoom(item.id)?.qtyLeft ?? item.quantity) <= 0
                    ? " · already returned"
                    : (lineRoom(item.id)?.qtyLeft ?? item.quantity) < item.quantity
                      ? ` · ${lineRoom(item.id)?.qtyLeft} left to return`
                      : ""}
                </option>
              ))}
            </Select>
          </div>

          {/* Quantity to return */}
          {selectedItem && selectedItem.quantity > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="return-qty-input">
                How many are coming back? (max {qtyLeft})
              </Label>
              <Input
                id="return-qty-input"
                type="number"
                min={1}
                max={Math.max(1, qtyLeft)}
                value={returnQty}
                onChange={(e) => handleQtyChange(e.target.value)}
              />
            </div>
          )}

          {/* Selected item detail */}
          {selectedItem && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
              <p className="font-medium text-foreground">{selectedItem.product.name}</p>
              <p>
                Sold qty: {selectedItem.quantity} · Line total: {formatCurrency(selectedItem.totalPrice)}
                {qtyLeft < selectedItem.quantity ? ` · ${selectedItem.quantity - qtyLeft} already returned` : ""}
              </p>
              <p>
                Sold for {formatCurrency(unitPrice)} each · Returning: {qty} · Most that can be returned:{" "}
                {formatCurrency(maxReturn ?? 0)}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Empty state before lookup */}
      {!foundSale && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <ReceiptText className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Enter the invoice number above to see what can be returned.</p>
        </div>
      )}

      {/* Outcome + fault + value fields — only shown once an item is selected */}
      {selectedItem && (
        <OutcomeFields
          outcome={outcome}
          onOutcomeChange={setOutcome}
          returnValue={returnValue}
          onReturnValueChange={setReturnValue}
          suggestedReturn={suggestedReturn}
          maxReturn={maxReturn}
          shopStock={stock}
          branchId={foundSale?.branchId ?? null}
          isInvoicePath={true}
          fullControl={fullControl}
          banks={banks}
        />
      )}
    </ActionForm>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function ReturnForm({
  sold,
  stock,
  successHref,
  fullControl = false,
  banks = [],
}: {
  banks?: ReturnBank[]
  sold: Sold[]
  stock: StockUnit[]
  successHref?: string
  /** Vault Manager, Manager, CEO, main admin. Everyone else logs a return inward. */
  fullControl?: boolean
}) {
  const [tab, setTab] = useState<"imei" | "invoice">("imei")

  return (
    <div className="space-y-4">
      <TabBar active={tab} onChange={setTab} />
      {tab === "imei" ? (
        <ImeiReturnForm sold={sold} stock={stock} successHref={successHref} fullControl={fullControl} banks={banks} />
      ) : (
        <InvoiceReturnForm stock={stock} successHref={successHref} fullControl={fullControl} banks={banks} />
      )}
    </div>
  )
}
