"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, CheckCircle2, Loader2, PackageCheck, RotateCcw, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { lookupSupplierReturnImei, sendUnitsToSupplier } from "@/app/actions/ops"
import { ScanField } from "@/components/scan-field"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn, formatCurrency } from "@/lib/utils"

type ReturnUnit = {
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

/** One number on the list: being checked, ready to go back, or with a problem to fix. */
type Line = {
  /** What was scanned or typed. */
  code: string
  state: "checking" | "ready" | "problem"
  unit?: ReturnUnit
  problem?: string
}

export type WaitingUnit = {
  id: string
  imei1: string
  productName: string
  supplierId: string | null
  supplierName: string
  shop: string
  status: string
}

type Sent = { reference: string; supplierName: string; count: number }

function cleanCode(raw: string) {
  return raw.replace(/[\s-]/g, "").trim().toUpperCase()
}

function numbersOf(line: Line) {
  return [line.code, line.unit?.imei].filter(Boolean).map((code) => cleanCode(code as string))
}

/**
 * The list is kept on this device until it is sent, so a refresh, a dropped
 * connection or stepping away from the counter does not lose the phones
 * already scanned. It holds the numbers only; every one is checked again on load.
 */
function draftKey(userId: string) {
  return `abutwins.send-back.draft.v1:${userId}`
}

/** Where the previous send-back screen kept its list, picked up once so an unsent list is not lost. */
const OLD_DRAFT_KEY = "supplier-return-draft:v1"

function readOldDraft(): { codes: string[]; reason: string } | null {
  try {
    const raw = window.localStorage.getItem(OLD_DRAFT_KEY)
    window.localStorage.removeItem(OLD_DRAFT_KEY)
    const saved = JSON.parse(raw || "[]") as Array<{ imei?: unknown }>
    const codes = Array.isArray(saved) ? saved.map((row) => row?.imei).filter((code): code is string => typeof code === "string") : []
    return codes.length ? { codes, reason: "" } : null
  } catch {
    return null
  }
}

function readDraft(userId: string): { codes: string[]; reason: string } | null {
  try {
    const raw = window.localStorage.getItem(draftKey(userId))
    if (!raw) return readOldDraft()
    const parsed = JSON.parse(raw) as { codes?: unknown; reason?: unknown }
    const codes = Array.isArray(parsed.codes) ? parsed.codes.filter((code): code is string => typeof code === "string") : []
    return { codes, reason: typeof parsed.reason === "string" ? parsed.reason : "" }
  } catch {
    return null
  }
}

function writeDraft(userId: string, lines: Line[], reason: string) {
  try {
    if (!lines.length && !reason.trim()) window.localStorage.removeItem(draftKey(userId))
    else window.localStorage.setItem(draftKey(userId), JSON.stringify({ codes: lines.map((line) => line.code), reason }))
  } catch {
    // Private window or storage blocked: the list still works, it just is not kept.
  }
}

/**
 * Send back to supplier, built as a basket: scan or type each phone one after
 * the other, watch the list fill and check it against the pile on the table,
 * then review and send. Scanning only ever adds to the list. Nothing leaves
 * the shop until the review is confirmed, and the scan box is not inside a
 * form, so a scanner's Enter has nothing it could submit.
 */
export function SupplierReturnForm({ userId, waiting }: { userId: string; waiting: WaitingUnit[] }) {
  const router = useRouter()
  const [lines, setLines] = useState<Line[]>([])
  const [typed, setTyped] = useState("")
  const [reason, setReason] = useState("")
  const [reviewOpen, setReviewOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sent, setSent] = useState<Sent | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Scanners fire faster than the server answers, so numbers wait in a queue
  // and are checked one at a time against the list as it really is.
  const linesRef = useRef<Line[]>([])
  const queueRef = useRef<string[]>([])
  const workingRef = useRef(false)

  const commit = useCallback((next: Line[]) => {
    linesRef.current = next
    setLines(next)
  }, [])

  const runQueue = useCallback(async () => {
    if (workingRef.current) return
    workingRef.current = true
    try {
      while (queueRef.current.length) {
        const code = queueRef.current.shift() as string
        if (!linesRef.current.some((line) => line.code === code)) continue // removed while waiting
        let outcome: Partial<Line>
        try {
          const found = await lookupSupplierReturnImei(code)
          if ("error" in found && found.error) outcome = { state: "problem", problem: found.error, unit: undefined }
          else if (!("imei" in found)) {
            outcome = { state: "problem", problem: "We could not find that IMEI or serial on the system.", unit: undefined }
          } else {
            const others = linesRef.current.filter((line) => line.code !== code)
            const house = others.find((line) => line.state === "ready")?.unit
            if (others.some((line) => line.unit && cleanCode(line.unit.imei) === cleanCode(found.imei))) {
              outcome = { state: "problem", unit: found, problem: `This is the same phone as ${found.imei}, already on the list.` }
            } else if (house && found.supplierId !== house.supplierId) {
              outcome = {
                state: "problem",
                unit: found,
                problem: `From ${found.supplierName || "another supplier"}, but this send-back is for ${house.supplierName}. Remove it and send it in its own send-back.`,
              }
            } else outcome = { state: "ready", unit: found, problem: undefined }
          }
        } catch {
          outcome = { state: "problem", problem: "Could not reach the server. Check the connection, then press Check again." }
        }
        commit(linesRef.current.map((line) => (line.code === code ? { ...line, ...outcome } : line)))
        if (outcome.state === "problem" && typeof navigator !== "undefined") navigator.vibrate?.(180)
      }
    } finally {
      workingRef.current = false
    }
  }, [commit])

  const add = useCallback(
    (raw: string) => {
      const code = cleanCode(raw)
      if (code.length < 4) {
        toast.error("That number is too short. Scan it again, or type every digit.")
        return
      }
      const already = linesRef.current.find((line) => numbersOf(line).includes(code))
      if (already) {
        toast.message(`${code} is already on the list.`)
        setFlash(already.code)
        return
      }
      setSent(null)
      commit([...linesRef.current, { code, state: "checking" }])
      setFlash(code)
      queueRef.current.push(code)
      void runQueue()
    },
    [commit, runQueue],
  )

  function recheck(code: string) {
    commit(linesRef.current.map((line) => (line.code === code ? { code: line.code, state: "checking" } : line)))
    queueRef.current.push(code)
    void runQueue()
  }

  function remove(code: string) {
    commit(linesRef.current.filter((line) => line.code !== code))
  }

  function clearAll() {
    queueRef.current = []
    commit([])
    setReason("")
  }

  // Bring back what was on the list before a refresh, and check it all again:
  // a phone may have been sold or moved since it was scanned.
  useEffect(() => {
    const draft = readDraft(userId)
    if (draft?.codes.length) {
      const codes = [...new Set(draft.codes.map(cleanCode).filter((code) => code.length >= 4))]
      // Device storage is only readable after mount, so the draft comes back here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      commit(codes.map((code) => ({ code, state: "checking" })))
      queueRef.current.push(...codes)
      void runQueue()
      toast.message(`Your unsent list of ${codes.length} is back. Checking each one again.`)
    }
    if (draft?.reason) setReason(draft.reason)
    setLoaded(true)
  }, [userId, commit, runQueue])

  useEffect(() => {
    if (loaded) writeDraft(userId, lines, reason)
  }, [loaded, userId, lines, reason])

  useEffect(() => {
    if (!flash) return
    const timer = window.setTimeout(() => setFlash(null), 1600)
    return () => window.clearTimeout(timer)
  }, [flash])

  const ready = lines.filter((line) => line.state === "ready")
  const problems = lines.filter((line) => line.state === "problem")
  const checking = lines.filter((line) => line.state === "checking")
  const house = ready[0]?.unit
  const moneyTotal = ready.reduce((sum, line) => sum + (line.unit?.moneyMoves ? line.unit.cost : 0), 0)
  const costTotal = ready.reduce((sum, line) => sum + (line.unit?.cost ?? 0), 0)
  const onList = new Set(lines.flatMap(numbersOf))

  const blocker = !lines.length
    ? "Scan or type the first phone going back."
    : checking.length
      ? `Checking ${checking.length} number${checking.length === 1 ? "" : "s"}…`
      : problems.length
        ? `Fix or remove the ${problems.length} line${problems.length === 1 ? "" : "s"} marked in red before you send.`
        : null

  function openReview() {
    const left = cleanCode(typed)
    if (left) {
      // A number typed but not added goes on the list for checking, never straight out.
      add(left)
      setTyped("")
      toast.message(`${left} was still in the box, so it is now on the list. Check it, then review again.`)
      return
    }
    if (blocker) {
      toast.error(blocker)
      return
    }
    setSendError(null)
    setReviewOpen(true)
  }

  async function confirmSend() {
    // The list may have changed while the review was open.
    const toSend = linesRef.current.filter((line) => line.state === "ready" && line.unit)
    if (!toSend.length || linesRef.current.some((line) => line.state !== "ready")) {
      setSendError("The list changed. Go back to the list, check every line, then review again.")
      return
    }
    setSending(true)
    setSendError(null)
    try {
      const formData = new FormData()
      formData.set("imeis", toSend.map((line) => line.unit!.imei).join("\n"))
      if (reason.trim()) formData.set("note", reason.trim())
      const result = await sendUnitsToSupplier(formData)
      if ("error" in result && result.error) {
        setSendError(`${result.error} Nothing was sent.`)
        return
      }
      const done: Sent = {
        reference: "reference" in result && result.reference ? result.reference : "",
        supplierName: toSend[0].unit?.supplierName || "the supplier",
        count: toSend.length,
      }
      setSent(done)
      setReviewOpen(false)
      clearAll()
      toast.success(
        `${done.count} phone${done.count === 1 ? "" : "s"} sent back to ${done.supplierName}${done.reference ? ` on ${done.reference}` : ""}.`,
      )
      router.refresh()
    } catch {
      setSendError("Could not reach the server. Nothing was sent. Check the connection and try again.")
    } finally {
      setSending(false)
    }
  }

  const waitingLeft = waiting.filter((row) => !onList.has(cleanCode(row.imei1)))

  return (
    <div className="space-y-4">
      {sent ? (
        <div className="flex items-start gap-3 rounded-xl border border-success/30 bg-success-soft/60 p-4 text-sm">
          <PackageCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold">
              {sent.count} phone{sent.count === 1 ? "" : "s"} sent back to {sent.supplierName}
            </p>
            <p className="text-muted-foreground">
              {sent.reference ? `Reference ${sent.reference}. ` : ""}Scan the next phone to start a new send-back.
            </p>
          </div>
        </div>
      ) : null}

      {/* Step 1: build the list. */}
      <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
        <div>
          <p className="text-sm font-semibold">1. Scan or type each phone going back</p>
          <p className="text-xs text-muted-foreground">
            One after the other. Each one joins the list below. Nothing is sent until you review and confirm.
          </p>
        </div>
        <ScanField
          kind="ANY"
          autoFocus
          onScan={add}
          value={typed}
          onValueChange={setTyped}
          placeholder="Scan or type an IMEI or serial, then Enter"
          hint="Use a USB or Bluetooth scanner, the camera, or type the number and press Enter or Add. You can paste a whole list into the box too."
        />
      </div>

      {waitingLeft.length ? (
        <details className="group rounded-xl border border-border bg-card">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
            <span>Waiting to go back ({waitingLeft.length})</span>
            <span className="text-xs font-normal text-muted-foreground group-open:hidden">Tap to add without scanning</span>
          </summary>
          <ul className="max-h-64 divide-y divide-border overflow-auto border-t border-border">
            {waitingLeft.map((row) => {
              const otherHouse = Boolean(house && row.supplierId && row.supplierId !== house.supplierId)
              return (
                <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0 text-sm">
                    <p className="truncate font-medium">{row.productName}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {row.imei1} · {row.shop}
                      {row.supplierName ? ` · ${row.supplierName}` : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={otherHouse}
                    title={otherHouse ? `Not from ${house?.supplierName}` : undefined}
                    onClick={() => add(row.imei1)}
                  >
                    {otherHouse ? "Other supplier" : "Add"}
                  </Button>
                </li>
              )
            })}
          </ul>
        </details>
      ) : null}

      {/* Step 2: check the list against the phones on the table. */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">2. Check the list against the phones in front of you</p>
            <p className="text-xs text-muted-foreground">
              {lines.length
                ? `${lines.length} on the list · ${ready.length} ready${problems.length ? ` · ${problems.length} to fix` : ""}${checking.length ? ` · ${checking.length} checking` : ""}`
                : "Each phone shows here as you scan it."}
            </p>
          </div>
          {lines.length ? (
            <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={clearAll}>
              <Trash2 className="mr-1.5 h-4 w-4" />
              Clear list
            </Button>
          ) : null}
        </div>

        {house ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-semibold">{house.supplierName}</p>
              <p className="text-sm text-muted-foreground">
                Every phone on this send-back must be from this supplier
                {moneyTotal > 0 ? ` · ${formatCurrency(moneyTotal)} comes off what we owe them` : ""}
              </p>
            </div>
            <span className="rounded-full bg-warning-soft px-3 py-1 text-sm font-semibold tabular-nums text-warning">{ready.length}</span>
          </div>
        ) : null}

        {lines.length ? (
          <ol className="space-y-2">
            {lines
              .map((line, index) => ({ line, number: index + 1 }))
              .reverse()
              .map(({ line, number }) => (
                <li
                  key={line.code}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors",
                    line.state === "problem" ? "border-danger/40 bg-danger-soft/40" : "border-border bg-card",
                    flash === line.code && "ring-2 ring-primary/50",
                  )}
                >
                  <span className="mt-0.5 w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-muted-foreground">{number}</span>
                  <span className="mt-0.5 shrink-0" aria-hidden>
                    {line.state === "checking" ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : line.state === "ready" ? (
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-danger" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="break-all font-mono text-xs text-muted-foreground">{line.unit?.imei || line.code}</p>
                    {line.unit ? <p className="text-sm font-medium">{line.unit.productName}</p> : null}
                    {line.state === "checking" ? <p className="text-xs text-muted-foreground">Checking this number…</p> : null}
                    {line.state === "ready" && line.unit ? (
                      <p className="text-xs text-muted-foreground">
                        {[line.unit.supplierName, line.unit.invoice ? `bill ${line.unit.invoice}` : "", line.unit.shop, `cost ${formatCurrency(line.unit.cost)}`]
                          .filter(Boolean)
                          .join(" · ")}
                        {!line.unit.moneyMoves && line.unit.moneyNote ? ` · ${line.unit.moneyNote}` : ""}
                      </p>
                    ) : null}
                    {line.state === "problem" ? <p className="text-xs font-medium text-danger">{line.problem}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {line.state === "problem" ? (
                      <button
                        type="button"
                        aria-label={`Check ${line.code} again`}
                        title="Check again"
                        className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        onClick={() => recheck(line.code)}
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Remove ${line.code}`}
                      title="Remove from the list"
                      className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                      onClick={() => remove(line.code)}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
          </ol>
        ) : (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No phone on the list yet. Scan or type the first one above.
          </p>
        )}

        {lines.length ? (
          <p className="text-xs text-muted-foreground">This list is kept on this device until you send it, even if the page is closed.</p>
        ) : null}
      </div>

      {/* Step 3: review, then send. */}
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <p className="text-sm font-semibold">3. Review and send</p>
        <div className="space-y-1.5">
          <label htmlFor="send-back-reason" className="text-xs font-medium text-muted-foreground">
            Why are these going back? (optional)
          </label>
          <Textarea
            id="send-back-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value.slice(0, 300))}
            rows={2}
            placeholder="For example: faulty screens, wrong model delivered"
          />
        </div>
        <Button type="button" className="w-full" disabled={Boolean(blocker) && !cleanCode(typed)} onClick={openReview}>
          {ready.length ? `Review ${ready.length} phone${ready.length === 1 ? "" : "s"} before sending` : "Review before sending"}
        </Button>
        {blocker && lines.length ? <p className="text-center text-xs text-muted-foreground">{blocker}</p> : null}
      </div>

      <Dialog open={reviewOpen} onOpenChange={(open) => !sending && setReviewOpen(open)}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>
              Send {ready.length} phone{ready.length === 1 ? "" : "s"} back to {house?.supplierName || "the supplier"}?
            </DialogTitle>
            <DialogDescription>
              Count the phones in front of you against this list. Once sent, they leave stock and the supplier account changes.
            </DialogDescription>
          </DialogHeader>
          <ol className="max-h-72 divide-y divide-border overflow-auto rounded-xl border border-border text-sm">
            {ready.map((line, index) => (
              <li key={line.code} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {index + 1}. {line.unit?.productName}
                  </p>
                  <p className="break-all font-mono text-xs text-muted-foreground">{line.unit?.imei}</p>
                </div>
                <span className="shrink-0 tabular-nums text-xs">{formatCurrency(line.unit?.cost ?? 0)}</span>
              </li>
            ))}
          </ol>
          <div className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm">
            <p className="flex justify-between gap-3">
              <span className="text-muted-foreground">Phones</span>
              <span className="font-semibold tabular-nums">{ready.length}</span>
            </p>
            <p className="flex justify-between gap-3">
              <span className="text-muted-foreground">Cost value</span>
              <span className="font-semibold tabular-nums">{formatCurrency(costTotal)}</span>
            </p>
            {moneyTotal > 0 ? (
              <p className="flex justify-between gap-3">
                <span className="text-muted-foreground">Comes off what we owe {house?.supplierName}</span>
                <span className="font-semibold tabular-nums">{formatCurrency(moneyTotal)}</span>
              </p>
            ) : null}
            {reason.trim() ? <p className="pt-1 text-xs text-muted-foreground">Reason: {reason.trim()}</p> : null}
          </div>
          {sendError ? (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {sendError}
            </p>
          ) : null}
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" disabled={sending} onClick={() => setReviewOpen(false)}>
              Back to the list
            </Button>
            <Button type="button" disabled={sending} onClick={() => void confirmSend()}>
              {sending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Sending these phones back
                </>
              ) : (
                `Yes, send ${ready.length} back`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
