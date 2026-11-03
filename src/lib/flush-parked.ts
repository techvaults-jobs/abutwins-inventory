import { syncOfflineTrail } from "@/app/actions/audit"
import { heartbeatParkedSales } from "@/app/actions/parked"
import { checkoutSale } from "@/app/actions/sales"
import {
  clearOfflineEvents,
  getDeviceId,
  markSaleRefused,
  parkedHeartbeatRows,
  readOfflineEvents,
  readSaleQueue,
  recordOfflineEvent,
  removeSaleQueue,
} from "@/lib/offline-sales"

const FLUSH_TAG = "abutwins-flush"

/** Ask the service worker to retry parked sales when the line comes back. */
export async function requestParkedFlush() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  try {
    const registration = await navigator.serviceWorker.ready
    const sync = (registration as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }).sync
    if (sync) await sync.register(FLUSH_TAG)
  } catch {
    // Background Sync is optional. The online banner still sends parked sales.
  }
}

export async function flushParkedSales(reason: "auto" | "manual") {
  if (typeof navigator === "undefined" || !navigator.onLine) {
    return { posted: [] as string[], leftover: (await readSaleQueue()).length }
  }

  try {
    await heartbeatParkedSales({ deviceId: await getDeviceId(), rows: await parkedHeartbeatRows() })
  } catch {
    // Line may have dropped again. Flush still tries to post waiting sales.
  }

  // A sale the shop system refused is not sent again on its own: it would be
  // refused again, on every page, forever. Staff send it again or remove it.
  const pendingSales = (await readSaleQueue()).filter((row) => reason === "manual" || !row.lastError)
  const pendingEvents = await readOfflineEvents()
  if (!pendingSales.length && !pendingEvents.length) {
    return { posted: [] as string[], leftover: 0 }
  }

  const posted: string[] = []
  const failed: string[] = []
  let lastError = ""

  for (const row of pendingSales) {
    try {
      const result = await checkoutSale({
        ...row.payload,
        queuedAt: row.createdAt,
        offlineId: row.id,
      })
      if (result.error) {
        await recordOfflineEvent("SYNC_FAILED", { queueId: row.id, error: result.error })
        await markSaleRefused(row.id, result.error)
        failed.push(row.id)
        lastError = result.error
        continue
      }
      posted.push(result.saleId ?? row.id)
      await removeSaleQueue(row.id)
    } catch {
      await recordOfflineEvent("SYNC_FAILED", { queueId: row.id, error: "network" })
      failed.push(row.id)
      lastError = "The network went off again. The waiting sales stay on this phone."
      break
    }
  }

  const leftover = await readSaleQueue()
  if (posted.length && leftover.length === 0) {
    const events = [...pendingEvents, ...(await readOfflineEvents()).filter((event) => event.kind === "SYNC_FAILED")]
    await recordOfflineEvent("SYNC_OK", { posted: posted.length })
    await syncOfflineTrail({
      events: [...events, { id: `ok-${Date.now()}`, at: new Date().toISOString(), kind: "SYNC_OK", detail: { posted } }],
      postedInvoices: posted,
    })
    await clearOfflineEvents()
  } else if (posted.length) {
    await recordOfflineEvent("SYNC_OK", { posted: posted.length, leftover: leftover.length })
  }

  if (leftover.length) await requestParkedFlush()

  return {
    posted,
    leftover: leftover.length,
    error: leftover.length
      ? lastError || `${failed.length} waiting sale${failed.length === 1 ? "" : "s"} still on this phone. The rest were sent.`
      : undefined,
  }
}
