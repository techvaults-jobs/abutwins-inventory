import Dexie, { type Table } from "dexie"

export type QueuedSale = {
  id: string
  createdAt: string
  /** Why the shop system last refused this sale. Empty until it has been refused. */
  lastError?: string
  payload: {
    customerId?: string
    branchId: string
    paymentMethod: "CASH" | "TRANSFER" | "POS" | "CREDIT" | "SPLIT_PAYMENT"
    paidAmount: number
    bankAccountId?: string
    depositMethod?: "CASH" | "TRANSFER"
    splitTenders?: Array<{ method: "CASH" | "TRANSFER" | "POS"; amount: number }>
    notes?: string
    wholesale?: boolean
    /** Money off the whole order, carried so a parked bulk deal replays as struck. */
    orderDiscount?: number
    discountReason?: string
    /** The CEO's sign-off for a price under the floor, given while online. */
    priceApproval?: string
    items: Array<{
      productId: string
      imeiId?: string
      quantity: number
      unitPrice: number
      warrantyDays?: number
      priceReason?: string
    }>
  }
}

export type OfflineEvent = {
  id: string
  at: string
  kind: "LINE_DOWN" | "SALE_PARKED" | "LINE_BACK" | "SYNC_OK" | "SYNC_FAILED"
  detail?: Record<string, unknown>
}

const SALE_KEY = "abutwins.offline-sales"
const EVENT_KEY = "abutwins.offline-events"
const DEVICE_KEY = "abutwins.device-id"

class ShopDatabase extends Dexie {
  parkedSales!: Table<QueuedSale, string>
  offlineEvents!: Table<OfflineEvent, string>
  meta!: Table<{ key: string; value: string }, string>
  tillSnapshots!: Table<{ key: string; savedAt: string; json: string }, string>
  pageSnapshots!: Table<{ key: string; savedAt: string; title: string; json: string }, string>

  constructor() {
    super("abutwins-shop")
    this.version(1).stores({
      parkedSales: "id, createdAt",
      offlineEvents: "id, at, kind",
      meta: "key",
    })
    this.version(2).stores({
      parkedSales: "id, createdAt",
      offlineEvents: "id, at, kind",
      meta: "key",
      tillSnapshots: "key, savedAt",
    })
    this.version(3).stores({
      parkedSales: "id, createdAt",
      offlineEvents: "id, at, kind",
      meta: "key",
      tillSnapshots: "key, savedAt",
      pageSnapshots: "key, savedAt",
    })
  }
}

let db: ShopDatabase | null = null
let ready: Promise<void> | null = null

function browserDb() {
  if (typeof window === "undefined") return null
  if (!db) db = new ShopDatabase()
  return db
}

export function getShopDb() {
  return browserDb()
}

function notify() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event("abutwins-queue"))
}

function readLegacyJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

async function migrateFromLocalStorage(store: ShopDatabase) {
  const sales = readLegacyJson<QueuedSale[]>(SALE_KEY, [])
  const events = readLegacyJson<OfflineEvent[]>(EVENT_KEY, [])
  const device = typeof window !== "undefined" ? window.localStorage.getItem(DEVICE_KEY) : null
  if (sales.length) await store.parkedSales.bulkPut(sales)
  if (events.length) await store.offlineEvents.bulkPut(events)
  if (device) await store.meta.put({ key: "deviceId", value: device })
  if (typeof window !== "undefined") {
    if (sales.length) window.localStorage.removeItem(SALE_KEY)
    if (events.length) window.localStorage.removeItem(EVENT_KEY)
  }
}

export async function ensureOfflineStore() {
  if (typeof window === "undefined") return
  if (!ready) {
    ready = (async () => {
      const store = browserDb()
      if (!store) return
      await store.open()
      await migrateFromLocalStorage(store)
    })()
  }
  await ready
}

export async function getDeviceId() {
  if (typeof window === "undefined") return ""
  await ensureOfflineStore()
  const store = browserDb()
  const existing = await store?.meta.get("deviceId")
  if (existing?.value) {
    window.localStorage.setItem(DEVICE_KEY, existing.value)
    return existing.value
  }
  const fromLegacy = window.localStorage.getItem(DEVICE_KEY)
  const id =
    fromLegacy ||
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `dev-${crypto.randomUUID()}`
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
  await store?.meta.put({ key: "deviceId", value: id })
  window.localStorage.setItem(DEVICE_KEY, id)
  return id
}

export async function parkedHeartbeatRows() {
  const rows = await readSaleQueue()
  return rows.map((row) => ({
    id: row.id,
    queuedAt: row.createdAt,
    branchId: row.payload.branchId,
    itemCount: row.payload.items.length,
    paidAmount: row.payload.paidAmount,
  }))
}

export async function readSaleQueue(): Promise<QueuedSale[]> {
  if (typeof window === "undefined") return []
  await ensureOfflineStore()
  const rows = (await browserDb()?.parkedSales.orderBy("createdAt").toArray()) ?? []
  return rows
}

export async function readOfflineEvents(): Promise<OfflineEvent[]> {
  if (typeof window === "undefined") return []
  await ensureOfflineStore()
  return (await browserDb()?.offlineEvents.orderBy("at").toArray()) ?? []
}

export async function recordOfflineEvent(kind: OfflineEvent["kind"], detail?: Record<string, unknown>) {
  if (typeof window === "undefined") return []
  await ensureOfflineStore()
  const store = browserDb()
  if (!store) return []
  const events = await store.offlineEvents.orderBy("at").toArray()
  const last = events[events.length - 1]
  if (last && last.kind === kind && Date.now() - new Date(last.at).getTime() < 15_000) return events
  await store.offlineEvents.add({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    kind,
    detail,
  })
  notify()
  return store.offlineEvents.orderBy("at").toArray()
}

export async function clearOfflineEvents() {
  if (typeof window === "undefined") return
  await ensureOfflineStore()
  await browserDb()?.offlineEvents.clear()
  notify()
}

/** Made before a sale's first send, and kept for every send after it. */
export function newSaleId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function pushSaleQueue(payload: QueuedSale["payload"], id = newSaleId()) {
  if (typeof window === "undefined") return []
  await ensureOfflineStore()
  const store = browserDb()
  if (!store) return []
  const row: QueuedSale = {
    id,
    createdAt: new Date().toISOString(),
    payload,
  }
  await store.parkedSales.put(row)
  await recordOfflineEvent("SALE_PARKED", {
    queueId: row.id,
    branchId: payload.branchId,
    items: payload.items.length,
    paidAmount: payload.paidAmount,
    method: payload.paymentMethod,
  })
  notify()
  return store.parkedSales.orderBy("createdAt").toArray()
}

export async function markSaleRefused(id: string, lastError: string) {
  if (typeof window === "undefined") return
  await ensureOfflineStore()
  await browserDb()?.parkedSales.update(id, { lastError })
  notify()
}

export async function removeSaleQueue(id: string) {
  if (typeof window === "undefined") return []
  await ensureOfflineStore()
  await browserDb()?.parkedSales.delete(id)
  notify()
  return readSaleQueue()
}
