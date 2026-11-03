"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { useRouter } from "next/navigation"
import {
  WifiOff,
  RefreshCw,
  Database,
  CheckCircle2,
  Send,
} from "lucide-react"
import { toast } from "sonner"
import { useNetworkStatus, getNetworkMonitor } from "@/lib/network-status"
import { RefusedSale } from "@/components/refused-sale"
import { flushParkedSales, requestParkedFlush } from "@/lib/flush-parked"
import {
  getDeviceId,
  readOfflineEvents,
  readSaleQueue,
  recordOfflineEvent,
  type OfflineEvent,
  type QueuedSale,
} from "@/lib/offline-sales"
import { formatCurrency } from "@/lib/utils"
import { formatShopWhen } from "@/lib/lagos-day"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export function NetworkStatusIndicator() {
  const router = useRouter()
  const network = useNetworkStatus()
  const [queue, setQueue] = React.useState<QueuedSale[]>([])
  const [events, setEvents] = React.useState<OfflineEvent[]>([])
  const [deviceId, setDeviceId] = React.useState<string>("")
  const [syncing, setSyncing] = React.useState(false)
  // The top bar's slot for the green dot. Found after mount, since the header
  // renders beside this component rather than around it.
  const [slot, setSlot] = React.useState<HTMLElement | null>(null)
  React.useEffect(() => {
    setSlot(document.getElementById("network-slot"))
  }, [])
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const isFlushing = React.useRef(false)

  const reloadData = React.useCallback(async () => {
    try {
      const [q, evts, dev] = await Promise.all([
        readSaleQueue(),
        readOfflineEvents(),
        getDeviceId(),
      ])
      setQueue(q)
      setEvents(evts)
      setDeviceId(dev)
    } catch (e) {
      console.error("Error reading offline queue:", e)
    }
  }, [])

  const handleSync = React.useCallback(async (reason: "auto" | "manual") => {
    if (isFlushing.current) return
    isFlushing.current = true
    setSyncing(true)
    getNetworkMonitor().setSyncing(true)

    try {
      const result = await flushParkedSales(reason)
      if (result.error) {
        toast.error(result.error)
      } else if (result.posted.length > 0) {
        toast.success(
          `${result.posted.length} waiting sale${result.posted.length === 1 ? "" : "s"} sent to the shop system.`
        )
        router.refresh()
      } else if (reason === "manual") {
        toast.info("There are no waiting sales on this phone.")
      }
    } catch (err) {
      console.error("Offline sync error:", err)
      toast.error("The waiting sales stayed on this phone. Try Send waiting work now.")
    } finally {
      isFlushing.current = false
      setSyncing(false)
      getNetworkMonitor().setSyncing(false)
      await reloadData()
    }
  }, [reloadData, router])

  React.useEffect(() => {
    void reloadData()
    const onQueueUpdate = () => void reloadData()
    window.addEventListener("abutwins-queue", onQueueUpdate)
    window.addEventListener("storage", onQueueUpdate)
    return () => {
      window.removeEventListener("abutwins-queue", onQueueUpdate)
      window.removeEventListener("storage", onQueueUpdate)
    }
  }, [reloadData])

  // Only sales not yet refused go on their own. This used to fire again each time
  // a send finished, so one refused sale was sent, refused and shown over and over.
  const sendable = queue.filter((row) => !row.lastError).length
  const refused = queue.length - sendable
  React.useEffect(() => {
    if (network.state === "online" && sendable > 0 && !syncing && !isFlushing.current) {
      void handleSync("auto")
    }
  }, [network.state, sendable, syncing, handleSync])

  React.useEffect(() => {
    const onOffline = () => {
      void recordOfflineEvent("LINE_DOWN", {})
    }
    const onOnline = () => {
      void recordOfflineEvent("LINE_BACK", {})
      void requestParkedFlush()
    }
    window.addEventListener("offline", onOffline)
    window.addEventListener("online", onOnline)
    return () => {
      window.removeEventListener("offline", onOffline)
      window.removeEventListener("online", onOnline)
    }
  }, [])

  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "ABUTWINS_FLUSH") void handleSync("auto")
    }
    navigator.serviceWorker.addEventListener("message", onMessage)
    return () => navigator.serviceWorker.removeEventListener("message", onMessage)
  }, [handleSync])

  const isOffline = network.state === "offline"
  const isReconnecting = network.state === "reconnecting" || syncing
  const hasQueue = queue.length > 0

  if (!isOffline && !isReconnecting && !hasQueue) {
    // All is well, so it takes no room on the page: a small green dot in the
    // top bar, which opens the sync centre. It used to be a pill on a row of
    // its own above every screen.
    const dot = (
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg hover:bg-muted"
        title={`Online${network.latencyMs ? ` · ${network.latencyMs}ms` : ""}. Open the sync centre.`}
        aria-label="Online. Open the sync centre"
      >
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 [animation-duration:2.5s]" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        </span>
      </button>
    )
    return (
      <>
        {slot ? createPortal(dot, slot) : null}

        <OfflineSyncCenterDialog
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          deviceId={deviceId}
          queue={queue}
          events={events}
          syncing={syncing}
          onSyncNow={() => handleSync("manual")}
          onTestConnection={() => network.checkNow()}
        />
      </>
    )
  }

  return (
    <div className="space-y-2 pb-2">
      {isOffline ? (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-900 shadow-sm dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-600 dark:text-amber-300">
              <WifiOff className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">Offline Mode Active</span>
                <span className="rounded-md bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                  Local Registry
                </span>
              </div>
              <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-300/90 leading-relaxed">
                Operating from local device cache. Transactions and stock records will be stored safely
                in on-device memory and synced automatically once internet connectivity is restored.
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 pt-1 sm:pt-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => network.checkNow()}
              className="border-amber-500/30 bg-background/80 text-xs hover:bg-background"
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Check Line
            </Button>
            {hasQueue ? (
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => setDrawerOpen(true)}
                className="bg-amber-600 text-xs text-white hover:bg-amber-700"
              >
                <Database className="mr-1.5 h-3.5 w-3.5" />
                Queue ({queue.length})
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {isReconnecting ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 text-blue-900 shadow-sm dark:text-blue-200">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/20 text-blue-600 dark:text-blue-300">
              <RefreshCw className="h-5 w-5 animate-spin" />
            </div>
            <div>
              <p className="text-sm font-semibold">The line is back. Sending parked sales</p>
              <p className="text-xs text-blue-800/90 dark:text-blue-300/90">
                Sending {queue.length} waiting sale{queue.length === 1 ? "" : "s"} to the shop system. If one sale needs a fix, the others still send.
              </p>
            </div>
          </div>
          <span className="text-xs font-semibold text-blue-700 dark:text-blue-300">Still sending parked sales</span>
        </div>
      ) : null}

      {!isOffline && !isReconnecting && hasQueue ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 p-3.5 text-foreground shadow-sm">
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm font-semibold">
                {queue.length} waiting sale{queue.length === 1 ? "" : "s"} on this phone
              </p>
              <p className="text-xs text-muted-foreground">
                {refused > 0
                  ? `The shop system refused ${refused === queue.length ? (refused === 1 ? "it" : "them") : refused}. Open the sync centre to see why, then send again or remove.`
                  : "The line is up. Send them when you are ready."}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDrawerOpen(true)}
              className="text-xs"
            >
              See waiting sales
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => handleSync("manual")}
              disabled={syncing}
              className="text-xs"
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Send waiting work now
            </Button>
          </div>
        </div>
      ) : null}

      <OfflineSyncCenterDialog
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        deviceId={deviceId}
        queue={queue}
        events={events}
        syncing={syncing}
        onSyncNow={() => handleSync("manual")}
        onTestConnection={() => network.checkNow()}
      />
    </div>
  )
}

function OfflineSyncCenterDialog({
  open,
  onOpenChange,
  deviceId,
  queue,
  events,
  syncing,
  onSyncNow,
  onTestConnection,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  deviceId: string
  queue: QueuedSale[]
  events: OfflineEvent[]
  syncing: boolean
  onSyncNow: () => void
  onTestConnection: () => Promise<boolean>
}) {
  const [testing, setTesting] = React.useState(false)
  const isOnline = typeof navigator !== "undefined" && navigator.onLine

  const totalQueuedAmount = queue.reduce((sum, item) => sum + item.payload.paidAmount, 0)
  const totalQueuedItems = queue.reduce((sum, item) => sum + item.payload.items.length, 0)

  const handleTest = async () => {
    setTesting(true)
    const reachable = await onTestConnection()
    setTesting(false)
    if (reachable) {
      toast.success("Server connectivity confirmed. Ready to sync.")
    } else {
      toast.error("Cannot reach server. Terminal remains in offline mode.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <DialogTitle>Offline Operations & Sync Center</DialogTitle>
          </div>
          <DialogDescription>
            Inspect transactions parked in local browser storage, device synchronization metrics, and network event audit trails.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Hardware & Terminal Status */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-border bg-muted/40 p-3">
              <span className="eyebrow block text-[10px]">Terminal Status</span>
              <div className="mt-1 flex items-center gap-1.5 font-semibold text-xs">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    isOnline ? "bg-emerald-500" : "bg-amber-500"
                  )}
                />
                {isOnline ? "Connected" : "Offline Mode"}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-muted/40 p-3">
              <span className="eyebrow block text-[10px]">Parked Sales</span>
              <p className="mt-1 font-bold text-sm">{queue.length}</p>
            </div>

            <div className="rounded-xl border border-border bg-muted/40 p-3">
              <span className="eyebrow block text-[10px]">Queued Units</span>
              <p className="mt-1 font-bold text-sm">{totalQueuedItems}</p>
            </div>

            <div className="rounded-xl border border-border bg-muted/40 p-3">
              <span className="eyebrow block text-[10px]">Queued Value</span>
              <p className="mt-1 font-bold text-xs tabular-nums text-primary">
                {formatCurrency(totalQueuedAmount)}
              </p>
            </div>
          </div>

          {/* Device ID */}
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs">
            <span className="text-muted-foreground font-mono">Terminal Device UUID:</span>
            <span className="font-mono font-semibold text-foreground">{deviceId || "Finding this phone"}</span>
          </div>

          {/* Queue Listing */}
          <div>
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Queued Transactions Pending Cloud Upload
              </h4>
              <span className="text-xs text-muted-foreground">{queue.length} pending</span>
            </div>

            {queue.length === 0 ? (
              <div className="mt-2 rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                <CheckCircle2 className="mx-auto mb-1.5 h-6 w-6 text-emerald-500" />
                All local transactions are completely synchronized with the server.
              </div>
            ) : (
              <div className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1">
                {queue.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-xl border border-border bg-background p-3 text-xs shadow-xs"
                  >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">
                          {row.payload.items.length} item{row.payload.items.length === 1 ? "" : "s"}
                        </span>
                        <span className="badge badge-outline text-[10px]">
                          {row.payload.paymentMethod}
                        </span>
                      </div>
                      <p className="mt-0.5 text-muted-foreground text-[11px]">
                        Queued: {formatShopWhen(new Date(row.createdAt))}
                      </p>
                    </div>
                    <div className="text-right">
                      <strong className="font-bold text-foreground">
                        {formatCurrency(row.payload.paidAmount)}
                      </strong>
                    </div>
                  </div>
                  <RefusedSale row={row} onRemoved={() => undefined} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Diagnostic Log */}
          {events.length > 0 ? (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent line and sync notes
              </h4>
              <div className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-lg border border-border bg-muted/20 p-2 font-mono text-[11px]">
                {events.slice(-6).reverse().map((ev) => (
                  <div key={ev.id} className="flex items-center justify-between text-muted-foreground">
                    <span>
                      [{formatShopWhen(new Date(ev.at))}] {ev.kind}
                    </span>
                    {ev.detail ? (
                      <span className="max-w-[200px] whitespace-normal break-words text-[10px] text-foreground/80">
                        {JSON.stringify(ev.detail)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleTest}
            disabled={testing}
            className="text-xs"
          >
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", testing && "animate-spin")} />
            Test Health Ping
          </Button>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="text-xs"
            >
              Close
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={syncing || queue.length === 0}
              onClick={onSyncNow}
              className="text-xs"
            >
              {syncing ? (
                <>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  Sending parked sales
                </>
              ) : (
                <>
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                  Publish {queue.length} Record{queue.length === 1 ? "" : "s"}
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
