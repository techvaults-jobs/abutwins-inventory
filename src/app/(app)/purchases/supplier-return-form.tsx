"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { ClipboardList, PackageX, Send, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { lookupSupplierReturnImei, sendUnitsToSupplier } from "@/app/actions/ops"
import { ScanField } from "@/components/scan-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { formatCurrency } from "@/lib/utils"

type ReturnLine = {
  imei: string
  productName: string
  supplierId: string
  supplierName: string
  cost: number
  invoice: string
  shop: string
  status: string
  moneyMoves: boolean
  moneyNote: string
}

/** The list being built, kept on this device so a refresh or an interruption does not lose it. */
const DRAFT_KEY = "supplier-return-draft:v1"

function cleanCode(raw: string) {
  return raw.replace(/[\s-]/g, "").trim()
}

/** Every number in a box: one per line, or split by commas, semicolons or spaces. */
function codesIn(raw: string) {
  return [...new Set(raw.split(/[\n,;\s]+/).map(cleanCode).filter((code) => code.length >= 4))]
}

type Looked = { line: ReturnLine } | { error: string }

/**
 * Look one number up for this send-back: on the system, sendable, and from
 * the same supplier as whatever is already on `onList`.
 */
async function lookUp(code: string, onList: ReturnLine[]): Promise<Looked> {
  if (onList.some((row) => row.imei === code)) return { error: `${code} is already on this list.` }
  const found = await lookupSupplierReturnImei(code)
  if ("error" in found && found.error) return { error: `${code}: ${found.error}` }
  if (!("imei" in found)) return { error: `${code}: we could not find that IMEI or serial on the system.` }
  // A serial typed for a unit booked under its IMEI comes back as that IMEI.
  if (onList.some((row) => row.imei === found.imei)) return { error: `${code} is already on this list.` }
  const first = onList[0]
  if (first && found.supplierId && first.supplierId !== found.supplierId) {
    return {
      error: `${code} is from ${found.supplierName || "another supplier"}, but this list is for ${first.supplierName}. Send this list first, then start one for that supplier.`,
    }
  }
  return { line: found }
}

/**
 * Send back to supplier, in two deliberate steps.
 *
 * 1. Build the list. Scanning or typing a number (Enter, the Add button, a
 *    scanner, the camera or a phone keyboard's Go key) only ever ADDS it to
 *    the list below, where it can be checked and removed. The list stays on
 *    this device until it is sent or cleared.
 * 2. Review and send. A summary of every phone, the supplier and the value
 *    opens; only its Send button sends.
 *
 * The scan box is its own small form whose submit means "add", so no key on
 * any keyboard or scanner can send the phones back by accident. (It used to
 * be one form with the Send button: a phone keyboard's Go key, or a scanner
 * whose Enter the page did not see as Enter, submitted it, and the phones
 * went back on the first scan.)
 */
export function SupplierReturnForm() {
  const router = useRouter()
  const [items, setItems] = useState<ReturnLine[]>([])
  const [loaded, setLoaded] = useState(false)
  const [looking, setLooking] = useState(false)
  const [scanValue, setScanValue] = useState("")
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteValue, setPasteValue] = useState("")
  const [pasting, setPasting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [note, setNote] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const pasteRef = useRef<HTMLTextAreaElement>(null)
  // The list as it stands right now, for checks made while lookups are still
  // coming back (several numbers pasted into the scan box at once).
  const itemsRef = useRef<ReturnLine[]>([])
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  // The saved list from this device, read once after the page opens.
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(DRAFT_KEY) || "[]")
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one read of saved browser state after mount
      if (Array.isArray(saved) && saved.length) setItems(saved as ReturnLine[])
    } catch {
      // No saved list, or storage is blocked: start empty.
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (!loaded) return
    try {
      if (items.length) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(items))
      else window.localStorage.removeItem(DRAFT_KEY)
    } catch {
      // Storage blocked: the list still works for this visit.
    }
  }, [items, loaded])

  async function addOne(code: string) {
    const clean = cleanCode(code)
    if (!clean) return
    setLooking(true)
    try {
      const result = await lookUp(clean, itemsRef.current)
      if ("error" in result) {
        toast.error(result.error)
        return
      }
      const line = result.line
      const current = itemsRef.current
      if (current.some((row) => row.imei === line.imei)) {
        toast.error(`${clean} is already on this list.`)
        return
      }
      if (current[0] && line.supplierId && current[0].supplierId !== line.supplierId) {
        toast.error(`${clean} is from ${line.supplierName || "another supplier"}, but this list is for ${current[0].supplierName}.`)
        return
      }
      itemsRef.current = [...current, line]
      setItems(itemsRef.current)
      toast.success(`${line.productName} added to the list. Nothing is sent until you review and send.`)
    } finally {
      setLooking(false)
    }
  }

  /** Paste path: parse newline/comma/space separated codes and look each one up. */
  async function addPasted() {
    const codes = codesIn(pasteValue)
    if (!codes.length) {
      toast.error("No IMEI or serial number found in what you pasted. Each number must be at least 4 characters.")
      return
    }
    setPasting(true)
    // Checked against the list as it grows, so the first phone sets the supplier for the rest.
    let list = itemsRef.current
    const before = list.length
    let failed = 0
    for (const code of codes) {
      try {
        const result = await lookUp(code, list)
        if ("error" in result) {
          toast.error(result.error)
          failed++
          continue
        }
        list = [...list, result.line]
      } catch {
        failed++
      }
    }
    const added = list.length - before
    itemsRef.current = list
    setItems(list)
    setPasting(false)
    setPasteMode(false)
    setPasteValue("")
    if (added > 0) toast.success(`${added} phone${added === 1 ? "" : "s"} added to the list.`)
    if (failed > 0 && added === 0) toast.error("None of those numbers could be added. Check each one and try again.")
  }

  /** Open the review. A number still typed in the box is added to the list first, so it is seen before sending. */
  async function startReview() {
    if (scanValue.trim()) {
      const typed = scanValue
      setScanValue("")
      await addOne(typed)
      return
    }
    if (!items.length) {
      toast.error("Scan or type at least one IMEI or serial number first.")
      return
    }
    setSendError(null)
    setReviewing(true)
  }

  async function send() {
    setSending(true)
    setSendError(null)
    const data = new FormData()
    data.set("imeis", items.map((row) => row.imei).join("\n"))
    data.set("note", note.trim())
    try {
      const result = await sendUnitsToSupplier(data)
      if (result && "error" in result && result.error) {
        setSendError(result.error)
        return
      }
      const reference = result && "reference" in result ? result.reference : null
      toast.success(
        `${items.length} phone${items.length === 1 ? "" : "s"} sent back to ${items[0]?.supplierName || "the supplier"}${reference ? ` on ${reference}` : ""}.`
      )
      setItems([])
      setNote("")
      setReviewing(false)
      router.refresh()
    } catch {
      setSendError("The network failed before the send-back was saved. Nothing was sent. Check your connection and try again.")
    } finally {
      setSending(false)
    }
  }

  const house = items[0]
  const moneyTotal = items.filter((row) => row.moneyMoves).reduce((sum, row) => sum + row.cost, 0)
  const costTotal = items.reduce((sum, row) => sum + row.cost, 0)

  return (
    <div className="space-y-4">
      {/* Step 1: build the list. */}
      <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">1. Scan or type each phone going back</p>
            <p className="text-xs text-muted-foreground">Each one goes on the list below. Nothing is sent yet.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setPasteMode((value) => !value)
              if (!pasteMode) setTimeout(() => pasteRef.current?.focus(), 60)
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <ClipboardList className="h-3.5 w-3.5" />
            {pasteMode ? "Close paste" : "Paste a list"}
          </button>
        </div>

        {pasteMode ? (
          <div className="space-y-2">
            <textarea
              ref={pasteRef}
              value={pasteValue}
              onChange={(event) => setPasteValue(event.target.value)}
              rows={5}
              placeholder={"Paste IMEIs or serials here, one per line, or separated by commas or spaces.\nExample:\n356938035643809\n356938035643810"}
              className="w-full rounded-lg border border-input bg-card px-3 py-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex gap-2">
              <Button type="button" onClick={() => void addPasted()} disabled={pasting || !pasteValue.trim()} className="flex-1">
                {pasting ? "Looking up each number" : `Add ${codesIn(pasteValue).length || ""} to the list`}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPasteMode(false)
                  setPasteValue("")
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          // The scan box's own form: submitting it (a phone keyboard's Go key,
          // a scanner's Enter) adds the number. It can never send.
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const typed = scanValue
              setScanValue("")
              void addOne(typed)
            }}
          >
            <ScanField
              kind="ANY"
              onScan={(code) => void addOne(code)}
              value={scanValue}
              onValueChange={setScanValue}
              placeholder="Scan or type IMEI or serial, then Enter or Add"
              hint="USB and Bluetooth scanners, the camera, or typing by hand all add to the list. All phones on one list must be from the same supplier."
            />
          </form>
        )}

        {looking && !pasteMode ? <p className="text-sm text-muted-foreground">Looking up this number</p> : null}
      </div>

      {/* The list. */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold">2. Check the list</p>
            <p className="text-xs text-muted-foreground">
              {house
                ? `${items.length} phone${items.length === 1 ? "" : "s"} for ${house.supplierName} · ${formatCurrency(costTotal)}${
                    moneyTotal > 0 ? ` · ${formatCurrency(moneyTotal)} comes off what we owe them` : ""
                  }`
                : "Empty. Scan the first phone above."}
            </p>
          </div>
          {items.length ? (
            <Button type="button" variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={() => setItems([])}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Clear list
            </Button>
          ) : null}
        </div>
        {items.length ? (
          <ul className="divide-y divide-border">
            {items.map((item, index) => (
              <li key={item.imei} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                    {index + 1}
                  </span>
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium">{item.productName}</p>
                    <p className="font-mono text-xs text-muted-foreground">{item.imei}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.supplierName}
                      {item.invoice ? ` · bill ${item.invoice}` : ""}
                      {item.shop ? ` · ${item.shop}` : ""}
                    </p>
                    <p className="text-xs">
                      Cost {formatCurrency(item.cost)}
                      {!item.moneyMoves && item.moneyNote ? <span className="ml-1 text-muted-foreground">· {item.moneyNote}</span> : null}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${item.imei} from the list`}
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                  onClick={() => setItems((current) => current.filter((row) => row.imei !== item.imei))}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
            <PackageX className="h-6 w-6" />
            <p>No phone on the list yet. Scan as many as are going back, check them here, then review and send.</p>
          </div>
        )}
      </div>

      {/* Step 3: the only way to send. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {items.length ? "The list is kept on this device until you send it or clear it." : ""}
        </p>
        <Button type="button" size="lg" disabled={!items.length || looking || pasting} onClick={() => void startReview()}>
          <Send className="mr-1.5 h-4 w-4" />
          {items.length ? `3. Review and send ${items.length} phone${items.length === 1 ? "" : "s"}` : "3. Review and send"}
        </Button>
      </div>

      <Dialog open={reviewing} onOpenChange={(open) => !sending && setReviewing(open)}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader className="pr-8">
            <DialogTitle className="text-lg font-bold">Send back to {house?.supplierName || "the supplier"}?</DialogTitle>
            <DialogDescription>
              Check every phone below. Once sent, they leave the shelf and are recorded as gone back to this supplier.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <ol className="divide-y divide-border rounded-xl border border-border text-sm">
              {items.map((item, index) => (
                <li key={item.imei} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {index + 1}. {item.productName}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {item.imei}
                      {item.invoice ? ` · bill ${item.invoice}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 tabular-nums">{formatCurrency(item.cost)}</span>
                </li>
              ))}
            </ol>
            <dl className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-3 text-xs">
              <div>
                <dt className="text-muted-foreground">Phones</dt>
                <dd className="text-base font-semibold tabular-nums">{items.length}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Value at cost</dt>
                <dd className="text-base font-semibold tabular-nums">{formatCurrency(costTotal)}</dd>
              </div>
              {moneyTotal > 0 ? (
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Comes off what we owe {house?.supplierName}</dt>
                  <dd className="font-semibold tabular-nums">{formatCurrency(moneyTotal)}</dd>
                </div>
              ) : null}
            </dl>
            <label className="block text-xs">
              <span className="mb-1 block font-medium text-muted-foreground">Why they are going back (optional)</span>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                maxLength={300}
                placeholder="Faulty screens, wrong model, supplier agreed to replace"
              />
            </label>
            {sendError ? (
              <p className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{sendError}</p>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" disabled={sending} onClick={() => setReviewing(false)}>
                Back to the list
              </Button>
              <Button type="button" disabled={sending} onClick={() => void send()}>
                {sending ? "Sending these phones back" : `Send ${items.length} phone${items.length === 1 ? "" : "s"} back`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
