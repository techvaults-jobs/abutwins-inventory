"use client"

import { useState } from "react"
import { correctBillLineCost } from "@/app/actions/ops"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/utils"

type Line = { id: string; label: string; quantity: number; unitCost: number }

/** Correct a cost typed wrong on one line of a supplier bill. */
export function CorrectLineCost({ lines }: { lines: Line[] }) {
  const [lineId, setLineId] = useState(lines[0]?.id ?? "")
  const [cost, setCost] = useState("")
  const line = lines.find((row) => row.id === lineId)
  const typed = Number(cost)
  const preview = line && cost !== "" && Number.isFinite(typed) && typed >= 0 ? typed * line.quantity : null

  return (
    <ActionForm
      action={correctBillLineCost}
      submit="Correct this cost"
      successMessage="Cost corrected. The bill, the item's cost and the profit on its sales now use it."
      variant="outline"
      className="grid gap-3 md:grid-cols-2"
    >
      <FormField label="Which line">
        <Select name="lineId" value={lineId} onChange={(event) => setLineId(event.target.value)} required>
          {lines.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label} · {row.quantity} × {formatCurrency(row.unitCost)}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Right cost of one unit (₦)">
        <Input name="unitCost" type="number" min={0} step="0.01" value={cost} onChange={(event) => setCost(event.target.value)} required />
      </FormField>
      <FormField label="Why it is being corrected" className="md:col-span-2">
        <Input name="reason" placeholder="Example: typed an extra digit; supplier invoice says ₦653,360" required minLength={4} />
      </FormField>
      {line && preview !== null ? (
        <p className="text-sm text-muted-foreground md:col-span-2">
          Line total goes from {formatCurrency(line.unitCost * line.quantity)} to{" "}
          <span className="font-semibold text-foreground">{formatCurrency(preview)}</span>.
        </p>
      ) : null}
    </ActionForm>
  )
}
