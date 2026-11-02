"use client"

import { useEffect, useState } from "react"
import { PosClient } from "@/app/(app)/pos/pos-client"
import { RefusedSale } from "@/components/refused-sale"
import { flushParkedSales } from "@/lib/flush-parked"
import { formatLagosStamp } from "@/lib/lagos-day"
import { readSaleQueue, type QueuedSale } from "@/lib/offline-sales"
import { readTillSnapshot, type TillSnapshot } from "@/lib/till-catalog"
import { listPageSnapshots } from "@/lib/page-cache"
import { formatCurrency } from "@/lib/utils"
import { statusLabel } from "@/lib/status"
import { Button } from "@/components/ui/button"
import { DecisionProvider } from "@/hooks/use-decision"

export function OfflineTill() {
  const [online, setOnline] = useState(true)
  const [queue, setQueue] = useState<QueuedSale[]>([])
  const [snapshot, setSnapshot] = useState<TillSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [lists, setLists] = useState<Array<{ key: string; title: string; savedAt: string }>>([])

  useEffect(() => {
    const refresh = async () => {
      setOnline(navigator.onLine)
      setQueue(await readSaleQueue())
      setSnapshot(await readTillSnapshot())
      setLists(await listPageSnapshots())
    }
    void refresh()
    const onChange = () => void refresh()
    window.addEventListener("online", onChange)
    window.addEventListener("offline", onChange)
    window.addEventListener("abutwins-queue", onChange)
    return () => {
      window.removeEventListener("online", onChange)
      window.removeEventListener("offline", onChange)
      window.removeEventListener("abutwins-queue", onChange)
    }
  }, [])

  async function sendParked() {
    setBusy(true)
    setMessage("")
    const result = await flushParkedSales("manual")
    setBusy(false)
    setQueue(await readSaleQueue())
    setSnapshot(await readTillSnapshot())
    setLists(await listPageSnapshots())
    if (result.error) {
      setMessage(result.error)
      return
    }
    if (result.posted.length) {
      setMessage(`${result.posted.length} waiting sale${result.posted.length === 1 ? "" : "s"} are now on the shop system. Who did what has the record.`)
      return
    }
    setMessage("No waiting sale is on this phone.")
  }

  return (
    <DecisionProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="bg-[#001BCE] px-6 py-6 text-white">
        <div className={`mx-auto flex items-center gap-3 ${snapshot ? "max-w-6xl" : "max-w-xl"}`}>
          <img src="/brand/ab-mark.jpg" alt="" width={48} height={48} className="rounded-full bg-white ring-2 ring-[#7CFF86]" />
          <div>
            <p className="text-lg font-semibold">Abu Twins Softskills</p>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7CFF86]">You can still sell</p>
          </div>
        </div>
      </header>

      <main className={`mx-auto space-y-5 px-6 py-8 ${snapshot ? "max-w-6xl" : "max-w-xl"}`}>
        <div className="rounded-lg bg-card p-5 shadow-sm">
          <h1 className="text-xl font-semibold">This phone cannot reach the shop system</h1>
          <p className="mt-2 text-sm text-foreground/80">
            {online
              ? "The network is back. Open Sell now to keep selling, or send the waiting work from here."
              : snapshot
                ? "You can sell from the last shop list saved on this phone. Waiting sales stay here. The real bill is only made when the network comes back."
                : "Waiting sales stay on this phone. Open Sell now once while the network is good, so this phone can keep a copy of the shop list."}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href="/pos"
              className="inline-flex min-h-11 items-center rounded-xl bg-[#001BCE] px-4 text-sm font-medium text-white"
            >
              Open Sell now
            </a>
            {online && queue.length ? (
              <Button type="button" disabled={busy} onClick={() => void sendParked()}>
                {busy ? "Sending waiting work" : "Send waiting work now"}
              </Button>
            ) : null}
          </div>
          {snapshot ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Last shop list saved {formatLagosStamp(new Date(snapshot.savedAt))}. {snapshot.imeis.length} In shop IMEIs. {snapshot.customers.length} named customers.
            </p>
          ) : null}
          {lists.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Also saved on this phone: {lists.map((row) => row.title).join(", ")}.
            </p>
          ) : null}
          {message ? <p className="mt-3 text-sm text-foreground/80">{message}</p> : null}
        </div>

        <div className="rounded-lg bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold">Waiting sales on this phone</h2>
          {queue.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No waiting sale is here.</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {queue.map((row) => (
                <li key={row.id} className="rounded-xl border border-border px-4 py-3 text-sm">
                  <p className="font-medium">
                    {row.payload.items.length} item{row.payload.items.length === 1 ? "" : "s"} · {formatCurrency(row.payload.paidAmount)} · {statusLabel(row.payload.paymentMethod)}
                  </p>
                  <p className="mt-1 text-muted-foreground">Waiting since {formatLagosStamp(new Date(row.createdAt))}</p>
                  <RefusedSale row={row} onRemoved={() => void readSaleQueue().then(setQueue)} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {snapshot ? (
          <div className="rounded-lg bg-card p-5 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold">Sell from the list saved on this phone</h2>
            <PosClient
              products={snapshot.products}
              customers={snapshot.customers}
              imeis={snapshot.imeis}
              branches={snapshot.branches}
              bankAccounts={snapshot.bankAccounts ?? []}
              defaultBranchId={snapshot.defaultBranchId}
              canOverrideFloor={snapshot.canOverrideFloor}
            />
          </div>
        ) : null}
        </main>
      </div>
    </DecisionProvider>
  )
}
