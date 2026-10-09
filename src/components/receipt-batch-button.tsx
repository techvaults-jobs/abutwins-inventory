"use client"

import { useState } from "react"
import { jsPDF } from "jspdf"
import { Download, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { getReceiptsForRange } from "@/app/actions/sales"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { drawReceipt, loadMark } from "@/lib/receipt-pdf"
import { formatDateTime } from "@/lib/utils"
import { watDayKey } from "@/lib/lagos-day"

/**
 * Every receipt for a chosen stretch of days, in one file, one receipt to a
 * page. For filing, or for handing the day's takings to accounts.
 */
export function ReceiptBatchButton() {
  const today = watDayKey()
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState(false)

  async function download() {
    setBusy(true)
    try {
      const result = await getReceiptsForRange(from, to)
      if ("error" in result) {
        toast.error(result.error)
        return
      }
      if (!result.receipts.length) {
        toast.message("There was no sale on those days, so there is nothing to print.")
        return
      }
      const mark = await loadMark(result.receipts[0]?.logoSrc)
      const doc = new jsPDF({ unit: "mm", format: "a4" })
      result.receipts.forEach((receipt, index) => {
        if (index > 0) doc.addPage()
        drawReceipt(doc, { ...receipt, soldAt: formatDateTime(receipt.soldAt) }, mark)
      })
      doc.save(`Receipts-${from}-to-${to}.pdf`)
      toast.success(`${result.receipts.length} receipt(s) saved.`)
    } catch {
      toast.error("We could not get the receipts ready. Try fewer days.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="surface-card p-5 print:hidden">
      <h3 className="font-semibold">Print receipts for many days</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Every finished sale between two days, one receipt to a page. This only reprints what the
        sales already say. It changes nothing.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs font-medium">
          <span className="mb-1 block text-muted-foreground">First day</span>
          <Input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="text-xs font-medium">
          <span className="mb-1 block text-muted-foreground">Last day</span>
          <Input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
        </label>
        <Button type="button" onClick={download} disabled={busy} aria-busy={busy}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Preparing the receipts
            </>
          ) : (
            <>
              <Download className="h-4 w-4" aria-hidden />
              Download receipts
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
