"use client"

import { useState } from "react"
import { correctExpense } from "@/app/actions/finance"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { statusLabel } from "@/lib/status"
import type { ExpenseRow } from "./expenses-list"

const CATEGORIES = ["TRANSPORT", "FUEL", "RENT", "UTILITIES", "REPAIRS", "SALARY", "MISCELLANEOUS", "MARKETING"] as const

/** The CEO's and the main admin's fix for an expense typed wrong, or one to cancel. */
export function FixExpenseDialog({ expense, onOpenChange }: { expense: ExpenseRow | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={Boolean(expense)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {expense ? <FixExpenseForm key={expense.id} expense={expense} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function FixExpenseForm({ expense, onDone }: { expense: ExpenseRow; onDone: () => void }) {
  const [cancel, setCancel] = useState(false)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Fix {expense.expenseNumber}</DialogTitle>
        <DialogDescription>
          Change the amount, what it was for or its kind, or cancel it. The till follows. Who did what keeps the old figures
          and your reason.
        </DialogDescription>
      </DialogHeader>
      <ActionForm
        action={correctExpense}
        submit={cancel ? "Cancel this expense" : "Save the fix"}
        successMessage={cancel ? "Expense cancelled. The money is back in the till." : "Expense fixed. The till follows it."}
        variant={cancel ? "destructive" : "default"}
        onSuccess={onDone}
        className="space-y-3"
      >
        <input type="hidden" name="id" value={expense.id} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="cancel" checked={cancel} onChange={(event) => setCancel(event.target.checked)} />
          Cancel this expense (it should never have been written)
        </label>
        {!cancel ? (
          <>
            <FormField label="Amount (₦)">
              <Input name="amount" type="number" min={0} step="0.01" defaultValue={expense.amount} required />
            </FormField>
            <FormField label="What it was for">
              <Input name="description" defaultValue={expense.description} required />
            </FormField>
            <FormField label="Kind">
              <Select name="category" defaultValue={expense.category}>
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {statusLabel(value)}
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        ) : null}
        <FormField label="Why you are fixing it">
          <Input name="reason" placeholder="Example: cashier typed ₦50,000 for ₦5,000" required minLength={4} />
        </FormField>
      </ActionForm>
    </>
  )
}
