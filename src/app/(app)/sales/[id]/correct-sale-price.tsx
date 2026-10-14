"use client"

import { useState } from "react"
import { correctSaleLinePrice } from "@/app/actions/sales"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/utils"

type Line = { id: string; label: string; quantity: number; unitPrice: number }

/** The CEO's and the main admin's correction for a price typed wrong on a finished sale. */
export function CorrectSalePrice({ lines, canFixMoney }: { lines: Line[]; canFixMoney: boolean }) {
  const [lineId, setLineId] = useState(lines[0]?.id ?? "")
  const [price, setPrice] = useState("")
  const line = lines.find((row) => row.id === lineId)

  return (
    <ActionForm
      action={correctSaleLinePrice}
      submit="Correct this price"
      successMessage="Price corrected. The invoice and the buyer's balance follow it."
      variant="outline"
      className="grid gap-3 md:grid-cols-2"
    >
      <FormField label="Which line">
        <Select name="saleItemId" value={lineId} onChange={(event) => setLineId(event.target.value)} required>
          {lines.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label} · {row.quantity} × {formatCurrency(row.unitPrice)}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Right price of one unit (₦)">
        <Input name="unitPrice" type="number" min={0} step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} required />
      </FormField>
      <FormField label="Why it is being corrected" className="md:col-span-2">
        <Input name="reason" placeholder="Example: cashier typed an extra digit" required minLength={4} />
      </FormField>
      {canFixMoney ? (
        <label className="flex items-start gap-2 text-sm md:col-span-2">
          <input type="checkbox" name="moneyTypedWrong" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" />
          <span>
            The money taken was typed with the same slip. Bring it to the corrected price too.
            <span className="block text-xs text-muted-foreground">
              Only while that day is not closed. Leave it unticked if the money recorded is what really came in.
            </span>
          </span>
        </label>
      ) : null}
      {line && price !== "" && Number(price) >= 0 ? (
        <p className="text-sm text-muted-foreground md:col-span-2">
          Line goes from {formatCurrency(line.unitPrice * line.quantity)} to{" "}
          <span className="font-semibold text-foreground">{formatCurrency(Number(price) * line.quantity)}</span>.
        </p>
      ) : null}
    </ActionForm>
  )
}
