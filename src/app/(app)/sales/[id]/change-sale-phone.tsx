"use client"

import { changeSalePhone } from "@/app/actions/sales"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"

type PhoneLine = { id: string; label: string }

/** The CEO's and the main admin's fix for the wrong phone scanned on a finished sale. */
export function ChangeSalePhone({ lines }: { lines: PhoneLine[] }) {
  return (
    <ActionForm
      action={changeSalePhone}
      submit="Change the phone"
      successMessage="Phone changed. The wrong one is back In shop."
      variant="outline"
      className="grid gap-3 md:grid-cols-2"
      confirmModal={{
        title: "Change the phone on this sale?",
        description: "The phone on the line goes back In shop and the one you typed is sold in its place. The price stays as it is.",
        confirmLabel: "Change the phone",
        tone: "warning",
      }}
    >
      <FormField label="Line with the wrong phone">
        <Select name="saleItemId" defaultValue={lines[0]?.id} required>
          {lines.map((row) => (
            <option key={row.id} value={row.id}>
              {row.label}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="IMEI of the phone really sold">
        <Input name="imei" placeholder="Scan or type the IMEI" required inputMode="numeric" />
      </FormField>
      <FormField label="Why it is being changed" className="md:col-span-2">
        <Input name="reason" placeholder="Example: cashier scanned the box next to it" required minLength={4} />
      </FormField>
    </ActionForm>
  )
}
