"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Pencil } from "lucide-react"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"

type Result = { error?: string; success?: boolean; message?: string; redirectTo?: string } | void

export type DetailField = {
  name: string
  label: string
  value: string
  type?: "text" | "tel" | "email" | "number"
  hint?: string
  required?: boolean
  /** Shown but not editable, with the hint saying who may change it. */
  locked?: boolean
  options?: Array<{ value: string; label: string }>
  wide?: boolean
}

/**
 * Edit a customer's or supplier's details in place, and remove one added by
 * mistake when it has nothing on record. The server decides what is allowed;
 * this only lays the form out.
 */
export function EditDetailsButton({
  id,
  title,
  description,
  fields,
  save,
  remove,
}: {
  id: string
  title: string
  description: string
  fields: DetailField[]
  save: (formData: FormData) => Promise<Result>
  /** Only passed when this record may be removed. */
  remove?: { action: (formData: FormData) => Promise<Result>; what: string }
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  return (
    <div className="flex shrink-0 gap-2">
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit details
      </Button>
      {remove ? (
        <ActionForm
          action={remove.action}
          submit="Remove"
          variant="outline"
          size="sm"
          buttonClassName=""
          resetOnSuccess={false}
          confirmModal={{
            title: `Remove ${remove.what}?`,
            description: "They have nothing on record, so no figure changes. This cannot be undone.",
            tone: "danger",
            confirmLabel: "Yes, remove",
          }}
        >
          <input type="hidden" name="id" value={id} />
        </ActionForm>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader className="pr-8">
            <DialogTitle className="text-lg font-bold">{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <ActionForm
            action={async (formData) => {
              const result = await save(formData)
              if (result && "success" in result && result.success) {
                setOpen(false)
                router.refresh()
              }
              return result
            }}
            submit="Save details"
            pendingLabel="Saving the details"
            successMessage="Details saved"
            resetOnSuccess={false}
            onCancel={() => setOpen(false)}
            className="grid gap-4 pt-2 sm:grid-cols-2"
          >
            <input type="hidden" name="id" value={id} />
            {fields.map((field) => (
              <FormField key={field.name} label={field.label} hint={field.hint} className={field.wide ? "sm:col-span-2" : undefined}>
                {field.options ? (
                  <Select name={field.name} defaultValue={field.value} disabled={field.locked}>
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    name={field.locked ? undefined : field.name}
                    type={field.type ?? "text"}
                    inputMode={field.type === "number" ? "decimal" : undefined}
                    step={field.type === "number" ? "0.01" : undefined}
                    defaultValue={field.value}
                    required={field.required}
                    disabled={field.locked}
                  />
                )}
              </FormField>
            ))}
          </ActionForm>
        </DialogContent>
      </Dialog>
    </div>
  )
}
