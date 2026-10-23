"use client"

import { useState, type ReactNode } from "react"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { formatCurrency } from "@/lib/utils"

type Choice = "" | "now" | "part" | "later"

/**
 * How the difference on a replacement or a Swap Deal is settled.
 *
 * The amount box used to start at the whole difference, so a customer who
 * walked off without paying was booked as having paid, and money we owed a
 * customer who left it with the shop was booked as paid out. Nothing reached
 * their account either way. Staff now say which it is, and whatever does not
 * change hands now goes on the customer's account: as what they owe us, or
 * as credit they spend on a later purchase.
 *
 * `balance` is seen from our side: above zero the customer owes us, below
 * zero we owe them. Sends `paidAmount`, the part that changes hands now.
 * `moneyFields` (how and which bank) shows only when money changes hands now.
 */
export function DifferenceSettle({ balance, moneyFields }: { balance: number; moneyFields?: ReactNode }) {
  const [choice, setChoice] = useState<Choice>("")
  const [part, setPart] = useState("")
  const theyPay = balance > 0
  const whole = Math.abs(balance)
  if (whole < 0.005) return null

  const partValue = Math.min(Math.max(0, Number(part) || 0), whole)
  const now = choice === "now" ? whole : choice === "part" ? partValue : 0
  const onAccount = choice ? whole - now : 0

  return (
    <div className="space-y-3">
      <label className="block space-y-1.5 text-sm">
        <span className="font-medium">
          {theyPay ? `The customer owes ${formatCurrency(whole)}. Did they pay it?` : `We owe the customer ${formatCurrency(whole)}. Is it paid back now?`}
        </span>
        <Select value={choice} onChange={(event) => setChoice(event.target.value as Choice)} required>
          <option value="">Pick one</option>
          {theyPay ? (
            <>
              <option value="now">Paid in full now</option>
              <option value="part">Paid part now, the rest goes on their account</option>
              <option value="later">Not paid now, it all goes on their account</option>
            </>
          ) : (
            <>
              <option value="now">Paid back in full now</option>
              <option value="part">Part paid back now, the rest stays on their account</option>
              <option value="later">Not paid back, it stays on their account to spend later</option>
            </>
          )}
        </Select>
      </label>

      {choice === "part" ? (
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">{theyPay ? "Amount they paid now (₦)" : "Amount paid back now (₦)"}</span>
          <Input
            type="number"
            min={1}
            max={Math.max(1, Math.floor(whole) - 1)}
            step="1"
            value={part}
            onChange={(event) => setPart(event.target.value)}
            required
          />
        </label>
      ) : null}
      {choice ? <input type="hidden" name="paidAmount" value={String(now)} /> : null}

      {choice && onAccount > 0.005 ? (
        <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {theyPay
            ? `${formatCurrency(onAccount)} goes on the customer's account as money they owe us. Collect it later on their customer page.`
            : `${formatCurrency(onAccount)} stays on the customer's account as their money. The till offers it on their next purchase.`}
        </p>
      ) : null}

      {now > 0 ? moneyFields : null}
    </div>
  )
}
