"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Pencil } from "lucide-react"
import { setSupplierOpeningBalance } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { balanceMeaning, formatSignedBalance } from "@/lib/balance-sign"
import { formatCurrency } from "@/lib/utils"

/**
 * What stood between us and this supplier before the software, and (for the
 * CEO, main admin and books desk) Add or Change. A minus is money we owed them.
 */
export function SupplierOpeningCard({
  supplierId,
  supplierName,
  opening,
  paidOnIt,
  bills,
  canChange,
}: {
  supplierId: string
  supplierName: string
  opening: number
  paidOnIt: number
  bills: Array<{ id: string; invoiceNumber: string; total: number; paid: number }>
  canChange: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const set = Math.abs(opening) > 0.005
  const wanted = typed.trim() === "" ? null : Number(typed)
  const valid = wanted !== null && Number.isFinite(wanted)

  return (
    <div className="surface-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Opening balance</p>
          <p className="text-2xl font-semibold tabular-nums">{formatSignedBalance(opening)}</p>
          <p className="text-xs text-muted-foreground">
            {set ? `${balanceMeaning(opening)} before this software.` : "No opening balance on this account yet."}
            {opening < 0 && paidOnIt > 0 ? ` ${formatCurrency(paidOnIt)} of it paid so far.` : ""}
          </p>
          {bills.length ? (
            <p className="mt-1 text-xs">
              {bills.map((bill) => (
                <Link key={bill.id} href={`/purchases/${bill.id}`} className="mr-2 font-medium text-primary hover:underline">
                  {bill.invoiceNumber}
                </Link>
              ))}
              <span className="text-muted-foreground"> Pay it on this bill like any other.</span>
            </p>
          ) : null}
        </div>
        {canChange ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => {
              setTyped(set ? String(opening) : "")
              setOpen(true)
            }}
          >
            <Pencil className="mr-1.5 h-3.5 w-3.5" /> {set ? "Change" : "Add"}
          </Button>
        ) : null}
      </div>

      {canChange ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader className="pr-8">
              <DialogTitle className="text-lg font-bold">
                {set ? "Change opening balance" : "Add opening balance"}: {supplierName}
              </DialogTitle>
              <DialogDescription>
                What stood between us and this supplier before the shops started on this software. A minus: we owed them,
                and it becomes a bill to pay. No sign: they owed us.
              </DialogDescription>
            </DialogHeader>
            <ActionForm
              action={async (formData) => {
                const result = await setSupplierOpeningBalance(formData)
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
              <input type="hidden" name="supplierId" value={supplierId} />
              <FormField label="Opening balance (₦)" hint="Example: −1400000 when we owed them ₦1,400,000. Type 0 to clear one put on by mistake.">
                <Input
                  name="openingBalance"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  required
                  autoFocus
                />
              </FormField>
              {valid ? (
                <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
                  {formatSignedBalance(opening)} → <span className="font-semibold">{formatSignedBalance(wanted)}</span> ·{" "}
                  {balanceMeaning(wanted)}
                </p>
              ) : null}
              <FormField label="Why" hint="Kept in Who did what.">
                <Input name="reason" required minLength={3} placeholder="Old ledger book balance" />
              </FormField>
            </ActionForm>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}
