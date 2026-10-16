"use client"

import { useState } from "react"
import { correctPaymentMethod } from "@/app/actions/access"
import { ActionForm } from "@/components/action-form"
import type { ShopBankOption } from "@/components/collect-money-fields"
import { FormField } from "@/components/form-field"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/utils"

type PaymentLine = { id: string; label: string; amount: number; method: string; bankAccountId: string | null }

/**
 * The CEO's and the main admin's fix for a payment taken the wrong way: Cash
 * pressed for a transfer, or the wrong bank picked. The amount stays.
 */
export function FixPaymentMethod({ payments, banks }: { payments: PaymentLine[]; banks: ShopBankOption[] }) {
  const [paymentId, setPaymentId] = useState(payments[0]?.id ?? "")
  const picked = payments.find((row) => row.id === paymentId)
  const [method, setMethod] = useState(picked?.method === "CASH" ? "TRANSFER" : "CASH")

  return (
    <ActionForm
      action={correctPaymentMethod}
      submit="Fix this payment"
      successMessage="Payment fixed. The till and the bank follow it. If that day was already balanced, count it again."
      variant="outline"
      className="grid gap-3 md:grid-cols-2"
    >
      <FormField label="Which payment">
        <Select name="paymentId" value={paymentId} onChange={(event) => setPaymentId(event.target.value)} required>
          {payments.map((row) => (
            <option key={row.id} value={row.id}>
              {formatCurrency(row.amount)} · {row.label}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="How it was really taken">
        <Select name="method" value={method} onChange={(event) => setMethod(event.target.value)} required>
          <option value="CASH">Cash (into the till)</option>
          <option value="TRANSFER">Transfer (into a bank)</option>
          <option value="POS">POS (card, into a bank)</option>
        </Select>
      </FormField>
      {method !== "CASH" ? (
        <FormField label="Bank it went into" className="md:col-span-2">
          <Select name="bankAccountId" defaultValue={picked?.bankAccountId ?? ""} key={paymentId} required>
            <option value="" disabled>
              Pick the bank
            </option>
            {banks.map((bank) => (
              <option key={bank.id} value={bank.id}>
                {bank.bankName} {bank.accountNumber}
                {bank.accountName ? ` · ${bank.accountName}` : ""}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}
      <FormField label="Why it is being fixed" className="md:col-span-2">
        <Input name="reason" placeholder="Example: customer paid by transfer, cashier pressed Cash" required minLength={4} />
      </FormField>
    </ActionForm>
  )
}
