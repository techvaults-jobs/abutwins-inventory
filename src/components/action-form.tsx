"use client"

import type { ReactNode } from "react"
import { useRef, useState, useTransition } from "react"
import { useFormStatus } from "react-dom"
import { useRouter } from "next/navigation"
import { AlertCircle, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DecisionModal, type DecisionTone } from "@/components/ui/decision-modal"
import { preventEnterFromSubmitting } from "@/components/scan-field"
import { cn } from "@/lib/utils"

/**
 * The submit button for a server action.
 *
 * It has to be its own component because useFormStatus only reports on the form
 * above it. While the shop is waiting it says so and refuses further presses,
 * preventing accidental duplicate submissions.
 */
export function SubmitButton({
  children = "Save",
  pendingLabel,
  variant = "default",
  size = "default",
  className,
  disabled,
}: {
  children?: ReactNode
  pendingLabel?: string
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost"
  size?: "default" | "sm" | "lg" | "icon"
  className?: string
  disabled?: boolean
}) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className={className}
      disabled={pending || disabled}
      aria-busy={pending}
    >
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {pendingLabel ?? "Saving this record"}
        </>
      ) : (
        children
      )}
    </Button>
  )
}

export interface ActionFormConfirmConfig {
  title: string
  description?: string
  tone?: DecisionTone
  impactItems?: string[]
  confirmLabel?: string
  cancelLabel?: string
}

export function ActionForm({
  action,
  children,
  submit = "Save",
  pendingLabel,
  successMessage = "Saved",
  resetOnSuccess = true,
  className,
  buttonClassName = "mt-4",
  variant = "default",
  size = "default",
  confirmModal,
  enterDoesNotSubmit = false,
  onSuccess,
  successHref,
  onCancel,
  cancelLabel = "Cancel",
}: {
  action: (formData: FormData) => Promise<{ error?: string; success?: boolean; message?: string; redirectTo?: string } | void>
  children: ReactNode
  submit?: string
  /** What the button says while the shop waits, e.g. "Completing this sale". */
  pendingLabel?: string
  /** What the toast says on success. Say what happened, not just "Saved". */
  successMessage?: string
  resetOnSuccess?: boolean
  className?: string
  buttonClassName?: string
  variant?: "default" | "outline" | "destructive" | "secondary" | "ghost"
  size?: "default" | "sm" | "lg" | "icon"
  /** Optional confirmation decision modal before submitting */
  confirmModal?: ActionFormConfirmConfig
  /**
   * Stop Enter from saving. Use this on scan screens so a USB scanner cannot
   * book a phone before staff fill the rest of the fields.
   */
  enterDoesNotSubmit?: boolean
  onSuccess?: () => void
  /** Where to go after a save, e.g. back to the list from its "new" screen. */
  successHref?: string
  /** Shows a Cancel button beside save, for forms that sit in a modal. */
  onCancel?: () => void
  cancelLabel?: string
}) {
  const router = useRouter()
  const ref = useRef<HTMLFormElement>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [pendingFormData, setPendingFormData] = useState<FormData | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  const executeAction = async (formData: FormData) => {
    setFormError(null)
    let result
    try {
      result = await action(formData)
    } catch (err) {
      console.error("ActionForm submission failed:", err)
      const msg = "Network request failed to reach the server. Check your connection and try again."
      setFormError(msg)
      toast.error(msg)
      return
    }

    if (result && "error" in result && result.error) {
      setFormError(result.error)
      toast.error(result.error)
      return
    }

    // What the action says it did wins over the form's stock wording. A delete
    // that only hid an item with history, or money taken with change to hand
    // back, used to show plain "Saved".
    toast.success(result && "message" in result && result.message ? result.message : successMessage)
    onSuccess?.()
    if (result && "redirectTo" in result && result.redirectTo) {
      router.push(result.redirectTo)
      return
    }
    if (successHref) {
      router.push(successHref)
      router.refresh()
      return
    }
    if (resetOnSuccess) ref.current?.reset()
    router.refresh()
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (confirmModal) {
      e.preventDefault()
      const formData = new FormData(e.currentTarget)
      setPendingFormData(formData)
      setConfirmOpen(true)
    }
  }

  const handleModalConfirm = () => {
    if (!pendingFormData) return
    const fd = pendingFormData
    setPendingFormData(null)
    setConfirmOpen(false)
    startTransition(() => {
      void executeAction(fd)
    })
  }

  return (
    <>
      <form
        ref={ref}
        className={className}
        onSubmit={handleSubmit}
        onKeyDown={enterDoesNotSubmit ? preventEnterFromSubmitting : undefined}
        action={confirmModal ? undefined : executeAction}
      >
        {formError ? (
          <div className="mb-4 flex items-start justify-between gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3.5 text-sm text-destructive">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{formError}</span>
            </div>
            <button
              type="button"
              onClick={() => setFormError(null)}
              className="text-destructive/70 hover:text-destructive"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}

        {children}

        {onCancel ? (
          <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", buttonClassName)}>
            <Button type="button" variant="outline" size={size} onClick={onCancel} disabled={isPending}>
              {cancelLabel}
            </Button>
            <SubmitButton variant={variant} size={size} pendingLabel={pendingLabel} disabled={isPending}>
              {submit}
            </SubmitButton>
          </div>
        ) : (
          <SubmitButton
            variant={variant}
            size={size}
            className={cn(buttonClassName)}
            pendingLabel={pendingLabel}
            disabled={isPending}
          >
            {submit}
          </SubmitButton>
        )}
      </form>

      {confirmModal ? (
        <DecisionModal
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          tone={confirmModal.tone ?? "warning"}
          title={confirmModal.title}
          description={confirmModal.description}
          impactItems={confirmModal.impactItems}
          confirmLabel={confirmModal.confirmLabel ?? "Yes, Proceed"}
          cancelLabel={confirmModal.cancelLabel ?? "Cancel"}
          busy={isPending}
          onConfirm={handleModalConfirm}
          onCancel={() => {
            setConfirmOpen(false)
            setPendingFormData(null)
          }}
        />
      ) : null}
    </>
  )
}
