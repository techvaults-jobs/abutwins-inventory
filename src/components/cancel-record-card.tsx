"use client"

import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { Input } from "@/components/ui/input"

type Result = { error?: string; success?: boolean; message?: string; redirectTo?: string } | void

/**
 * The CEO's and the main admin's cancel for a whole record entered by mistake.
 * A reason is required for Who did what, and the confirm box spells out what
 * moves before anything does. The server decides whether it is allowed.
 */
export function CancelRecordCard({
  action,
  idName,
  id,
  title,
  description,
  submit,
  confirmTitle,
  impact,
  bare = false,
}: {
  action: (formData: FormData) => Promise<Result>
  /** The form field the action reads the record's id from. */
  idName: string
  id: string
  title: string
  description: string
  submit: string
  confirmTitle: string
  impact: string[]
  /** Leave off the card frame, for a form that sits inside a panel. */
  bare?: boolean
}) {
  return (
    <div className={bare ? "space-y-2 rounded-xl border border-danger/30 p-4" : "surface-card border-danger/30 p-5 print:hidden"}>
      <h3 className="mb-1 font-semibold">{title}</h3>
      <p className="mb-3 text-sm text-muted-foreground">{description}</p>
      <ActionForm
        action={action}
        submit={submit}
        variant="outline"
        resetOnSuccess={false}
        className="grid gap-3"
        buttonClassName="mt-1 justify-self-start"
        confirmModal={{
          title: confirmTitle,
          description: "This cannot be undone. Who did what keeps the record as it was and your reason.",
          tone: "danger",
          impactItems: impact,
          confirmLabel: submit,
          cancelLabel: "Keep it",
        }}
      >
        <input type="hidden" name={idName} value={id} />
        <FormField label="Why it is being cancelled">
          <Input name="reason" placeholder="Example: typed on the wrong customer, sold again correctly" required minLength={4} />
        </FormField>
      </ActionForm>
    </div>
  )
}
