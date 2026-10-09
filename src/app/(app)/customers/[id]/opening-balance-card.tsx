"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { History, Pencil } from "lucide-react"
import { setCustomerOpeningBalance } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn, formatCurrency, formatDate } from "@/lib/utils"

type OpeningLine = { id: string; change: number; reference: string; description: string; createdAt: Date | string }

/**
 * What this customer owed before the software, with the history of the
 * figure, and (for the CEO, main admin and books desk) Set or Change.
 */
export function OpeningBalanceCard({
  customerId,
  customerName,
  opening,
  owing,
  history,
  canChange,
}: {
  customerId: string
  customerName: string
  /** The opening balance as it stands, every correction included. */
  opening: number
  /** What they still owe now, opening balance and sales together. */
  owing: number
  history: OpeningLine[]
  canChange: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [showHistory, setShowHistory] = useState(false)

  const wanted = typed.trim() === "" ? null : Number(typed)
  const valid = wanted !== null && Number.isFinite(wanted) && wanted >= 0
  const change = valid ? wanted - opening : 0
  const nextOwing = owing + change
  // Paid off already: the opening cannot go below that.
  const lowest = Math.max(0, opening - owing)
  const tooLow = valid && wanted < lowest - 0.005
  const set = history.length > 0

  function start() {
    setTyped(opening ? String(opening) : "")
    setOpen(true)
  }

  return (
    <div className="surface-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Opening balance</p>
          <p className="text-2xl font-semibold tabular-nums">{formatCurrency(opening)}</p>
          <p className="text-xs text-muted-foreground">
            {set
              ? history.length === 1
                ? `Owed before this software · set ${formatDate(history[0].createdAt)}`
                : `Owed before this software · changed ${history.length - 1} time${history.length === 2 ? "" : "s"}, last ${formatDate(history[history.length - 1].createdAt)}`
              : "No opening balance on this account yet."}
          </p>
        </div>
        {canChange ? (
          <Button type="button" size="sm" variant="outline" onClick={start} className="shrink-0">
            <Pencil className="mr-1.5 h-3.5 w-3.5" /> {set ? "Change" : "Add"}
          </Button>
        ) : null}
      </div>

      {history.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setShowHistory((value) => !value)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            aria-expanded={showHistory}
          >
            <History className="h-3.5 w-3.5" /> {showHistory ? "Hide" : "Show"} how this figure was set
          </button>
          {showHistory ? (
            <ul className="mt-2 space-y-2 text-xs">
              {history.map((line) => (
                <li key={line.id} className="flex justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-foreground">{line.description}</p>
                    <p className="text-muted-foreground">
                      {line.reference} · {formatDate(line.createdAt)}
                    </p>
                  </div>
                  <span
                    className={cn("shrink-0 font-semibold tabular-nums", line.change < 0 ? "text-success" : "text-warning")}
                  >
                    {line.change > 0 ? "+" : ""}
                    {formatCurrency(line.change)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {canChange ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader className="pr-8">
              <DialogTitle className="text-lg font-bold">
                {set ? "Change opening balance" : "Add opening balance"}: {customerName}
              </DialogTitle>
              <DialogDescription>
                Money this customer already owed us before the shops started on this software. The difference is posted
                to their account as its own line, so the old figure stays in the history.
              </DialogDescription>
            </DialogHeader>
            <ActionForm
              action={async (formData) => {
                const result = await setCustomerOpeningBalance(formData)
                if (result && "success" in result && result.success) {
                  setOpen(false)
                  router.refresh()
                }
                return result
              }}
              submit={set ? "Save new opening balance" : "Add opening balance"}
              pendingLabel="Saving the opening balance"
              successMessage="Opening balance saved"
              onCancel={() => setOpen(false)}
              className="space-y-4 pt-2"
            >
              <input type="hidden" name="customerId" value={customerId} />
              <FormField
                label="Opening balance they owe us (₦)"
                hint={
                  lowest > 0
                    ? `They have paid off ${formatCurrency(lowest)} of it already, so it cannot go below that.`
                    : "Type 0 to clear an opening balance put on by mistake."
                }
              >
                <Input
                  name="openingBalance"
                  type="number"
                  inputMode="decimal"
                  min={lowest}
                  step="0.01"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  required
                  autoFocus
                />
              </FormField>

              <dl className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs">
                <div>
                  <dt className="text-muted-foreground">Opening balance</dt>
                  <dd className="font-semibold tabular-nums">
                    {formatCurrency(opening)}
                    {valid && Math.abs(change) >= 0.005 ? <> → {formatCurrency(wanted)}</> : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Still owing</dt>
                  <dd className={cn("font-semibold tabular-nums", tooLow && "text-danger")}>
                    {formatCurrency(owing)}
                    {valid && Math.abs(change) >= 0.005 ? <> → {formatCurrency(Math.max(0, nextOwing))}</> : null}
                  </dd>
                </div>
              </dl>
              {tooLow ? (
                <p className="text-xs text-danger">
                  That is below what they have already paid off. The lowest it can be is {formatCurrency(lowest)}.
                </p>
              ) : null}

              <FormField label="Why" hint="Kept on their account and in Who did what.">
                <Input
                  name="reason"
                  required
                  minLength={3}
                  placeholder="Old ledger book balance, figure typed wrong at setup"
                />
              </FormField>
            </ActionForm>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}
