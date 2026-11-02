"use client"

import { useState } from "react"
import { toast } from "sonner"
import { dismissParkedSale } from "@/app/actions/parked"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { removeSaleQueue, type QueuedSale } from "@/lib/offline-sales"

/**
 * A waiting sale the shop system refused. Sending it again would only be refused
 * again, so staff see why and can take it off the phone, with a reason on record.
 */
export function RefusedSale({ row, onRemoved }: { row: QueuedSale; onRemoved: () => void }) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  if (!row.lastError) return null

  async function remove() {
    setBusy(true)
    try {
      const result = await dismissParkedSale({
        id: row.id,
        reason,
        lastError: row.lastError,
        queuedAt: row.createdAt,
        branchId: row.payload.branchId,
        itemCount: row.payload.items.length,
        paidAmount: row.payload.paidAmount,
      })
      if (result.error) {
        toast.error(result.error)
        return
      }
      await removeSaleQueue(row.id)
      toast.success("Waiting sale removed. The CEO and the main admin have been told.")
      onRemoved()
    } catch {
      toast.error("The shop system did not answer. Try again when the network is good.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 space-y-2 border-t border-border pt-2">
      <p className="text-xs text-destructive">Refused: {row.lastError}</p>
      <div className="flex gap-2">
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why remove it? e.g. already sold on invoice"
          aria-label="Why this waiting sale is being removed"
          className="h-8 text-xs"
        />
        <Button type="button" variant="outline" size="sm" disabled={busy || reason.trim().length < 3} onClick={remove}>
          Remove
        </Button>
      </div>
    </div>
  )
}
