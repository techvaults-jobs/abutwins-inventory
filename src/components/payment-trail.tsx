import type { PaymentStep } from "@/lib/payment-trail"
import { formatShopWhen } from "@/lib/lagos-day"
import { cn, formatCurrency } from "@/lib/utils"

/**
 * How an invoice was paid, step by step: when, how much, cash or which bank,
 * the reference, who took it, and what was left after. The same on the Sales
 * list's quick look and on the invoice.
 */
export function PaymentTrail({
  steps,
  total,
  returned = 0,
  className,
}: {
  steps: PaymentStep[]
  total: number
  /** What refunds and credit notes cleared, shown under the last step. */
  returned?: number
  className?: string
}) {
  const paid = steps.reduce((sum, step) => sum + step.amount, 0)
  const left = Math.max(0, total - paid - returned)

  if (!steps.length) {
    return (
      <p className={cn("rounded-xl border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground", className)}>
        No money taken on this invoice yet. {formatCurrency(left)} still owed.
      </p>
    )
  }

  return (
    <div className={className}>
      <ol className="relative space-y-3 border-l-2 border-border pl-5">
        {steps.map((step) => (
          <li key={step.key} className="relative">
            <span
              aria-hidden
              className={cn(
                "absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-card",
                step.leftAfter <= 0.005 ? "bg-success" : "bg-primary"
              )}
            />
            <div className="rounded-xl border border-border bg-card px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{step.stage}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatShopWhen(step.when)}
                    {step.by ? ` · taken by ${step.by}` : ""}
                  </p>
                </div>
                <p className="shrink-0 text-right font-semibold tabular-nums text-success">+{formatCurrency(step.amount)}</p>
              </div>
              <ul className="mt-1.5 space-y-1">
                {step.tenders.map((tender, index) => (
                  <li key={index} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span className="font-medium text-foreground">{tender.method}</span>
                    {step.tenders.length > 1 ? <span className="tabular-nums">{formatCurrency(tender.amount)}</span> : null}
                    {tender.bank ? <span className="text-muted-foreground">{tender.bank}</span> : null}
                    {tender.reference ? (
                      <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-foreground">
                        Ref: {tender.reference}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className={cn("mt-1.5 text-xs font-medium", step.leftAfter <= 0.005 ? "text-success" : "text-warning")}>
                {step.leftAfter <= 0.005 ? "Fully paid after this" : `${formatCurrency(step.leftAfter)} left after this`}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap justify-between gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs">
        <span>
          {steps.length} payment{steps.length === 1 ? "" : "s"} · {formatCurrency(paid)} of {formatCurrency(total)}
          {returned > 0 ? ` · ${formatCurrency(returned)} cleared by a return` : ""}
        </span>
        <span className={cn("font-semibold", left > 0.005 ? "text-warning" : "text-success")}>
          {left > 0.005 ? `${formatCurrency(left)} still owed` : "Nothing owed"}
        </span>
      </div>
    </div>
  )
}
