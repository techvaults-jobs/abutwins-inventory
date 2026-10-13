"use client"

import { useState } from "react"
import { payPurchase } from "@/app/actions/ops"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"

type Bank = { id: string; label: string }

/**
 * Pay a supplier bill. Two ways only: a transfer, which must say which of
 * our bank accounts it left from, or cash from the till. The client asked
 * for POS to go, and for every transfer to show against its bank on Money
 * in and out.
 */
export function PaySupplierForm({ purchaseId, due, banks }: { purchaseId: string; due: number; banks: Bank[] }) {
  const [method, setMethod] = useState<"TRANSFER" | "CASH">("TRANSFER")

  return (
    <ActionForm
      action={payPurchase}
      submit="Send payment"
      successMessage="Payment recorded. It shows on Money in and out."
      className="grid gap-3 md:grid-cols-[1fr_180px_1fr_auto] md:items-end"
    >
      <input type="hidden" name="id" value={purchaseId} />
      <FormField label="Amount (₦)">
        <Input name="amount" type="number" min={0} step="0.01" defaultValue={due} required />
      </FormField>
      <FormField label="Paid by">
        <Select name="method" value={method} onChange={(event) => setMethod(event.target.value === "CASH" ? "CASH" : "TRANSFER")}>
          <option value="TRANSFER">Transfer</option>
          <option value="CASH">Cash</option>
        </Select>
      </FormField>
      {method === "TRANSFER" ? (
        <FormField label="From which bank account">
          <Select name="bankAccountId" required defaultValue="" emptyLabel="No bank account is set up. Add one on Money in and out first.">
            {banks.length ? (
              <option value="" disabled>
                Pick the bank the transfer left from
              </option>
            ) : null}
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.label}
              </option>
            ))}
          </Select>
        </FormField>
      ) : (
        <p className="pb-2 text-sm text-muted-foreground">Cash leaves the till of this bill&apos;s shop.</p>
      )}
    </ActionForm>
  )
}
