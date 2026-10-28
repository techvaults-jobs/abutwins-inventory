"use server"

import type { StockMoveKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { viewBranchFilter } from "@/lib/branch-scope"
import { requireUser } from "@/lib/session"
import { can } from "@/lib/permissions"
import { canSeeBusinessTotals, canSeeProfit } from "@/lib/roles"
import { money } from "@/lib/utils"
import { lineValueAfterOrderDiscount } from "@/lib/sale-money"
import { recentWatDays, shiftWatDay, watBounds, watDayKey } from "@/lib/lagos-day"

/**
 * The owner's board. It answers what the CEO actually asks — how many goods are
 * in the shop, what went out today, and what is about to run out — instead of
 * the work in progress the other screens are built around.
 *
 * Every figure is counted from the record that created it: units in shop from
 * the shelf, units sold from the sale lines, and every other shelf change from
 * the stock ledger. Nothing here is an estimate except the sell rate, which
 * says so on the screen.
 */

/** How far back the sell rate is measured. Four weeks smooths a slow week. */
const RATE_DAYS = 28
/** How much history the trend shows. */
const TREND_DAYS = 30

export type OwnerShopDay = {
  branchId: string
  shop: string
  /**
   * What the shop had when it opened, worked back from the shelf and the day's
   * papers. null when those two disagree — see `reconciles`.
   */
  openedWith: number | null
  cameIn: number
  sold: number
  movedOut: number
  inShopNow: number
  soldValue: number
  soldCost: number
  /** Today's shelf changes broken out by why, straight from the stock ledger. */
  byKind: Array<{ kind: StockMoveKind; quantity: number }>
  /**
   * False when working the day backwards gives an impossible opening, which
   * means something moved stock without leaving a dated paper behind — a hand
   * correction on Shop stock, or a stock count adjustment. The board says so
   * rather than printing a figure it cannot stand behind.
   */
  reconciles: boolean
}

export type OwnerSoldLine = {
  id: string
  invoice: string
  item: string
  shop: string
  quantity: number
  value: number
  profit: number
  customer: string
  imei: string | null
}

export type OwnerReorderLine = {
  productId: string
  item: string
  category: string
  inShop: number
  soldPerDay: number
  daysLeft: number | null
  soldInPeriod: number
  costPrice: number
}

/** Inclusive day window as the shops count a day (West Africa Time). */
function dayWindow(dayKey: string) {
  const { start, end } = watBounds(dayKey)
  return { gte: start, lt: end }
}

function spanWindow(fromDay: string, toDay: string) {
  return { gte: watBounds(fromDay).start, lt: watBounds(toDay).end }
}

export async function getOwnerBoard(dayKey?: string) {
  const user = await requireUser()
  // The board is the business's totals: the CEO, the Accountant and the main
  // admin only (see canSeeBusinessTotals). Seeing Reports is not enough; a
  // branch manager used to open it that way.
  const allowed = canSeeBusinessTotals(user.role) && ((await can(user.role, "view.profits")) || (await can(user.role, "view.reports")))
  if (!allowed) return null

  const day = dayKey && /^\d{4}-\d{2}-\d{2}$/.test(dayKey) ? dayKey : watDayKey()
  const branchId = await viewBranchFilter(user)
  const shopWhere = branchId ? { branchId } : {}
  const today = dayWindow(day)
  const trendFrom = shiftWatDay(day, -(TREND_DAYS - 1))
  const rateFrom = shiftWatDay(day, -(RATE_DAYS - 1))

  const [
    branches,
    stockRows,
    soldToday,
    movesToday,
    soldOverTrend,
    soldOverRate,
  ] = await Promise.all([
    prisma.branch.findMany({
      where: { isActive: true, ...(branchId ? { id: branchId } : {}) },
      select: { id: true, name: true },
      orderBy: [{ isHq: "desc" }, { name: "asc" }],
    }),
    // What is on the shelf right now. This is the one figure that is not a
    // reconstruction — it is the shelf itself.
    prisma.inventory.findMany({
      where: { ...shopWhere, quantity: { gt: 0 } },
      select: {
        branchId: true,
        quantity: true,
        product: {
          select: {
            id: true,
            name: true,
            costPrice: true,
            storage: true,
            color: true,
            category: { select: { name: true } },
          },
        },
      },
    }),
    prisma.saleItem.findMany({
      where: {
        sale: {
          status: "COMPLETED",
          saleDate: today,
          ...shopWhere,
        },
      },
      select: {
        id: true,
        quantity: true,
        totalPrice: true,
        costPrice: true,
        unitPrice: true,
        product: { select: { name: true, costPrice: true, storage: true, color: true } },
        imei: { select: { imei1: true } },
        sale: {
          select: {
            branchId: true,
            invoiceNumber: true,
            subtotal: true,
            discount: true,
            branch: { select: { name: true } },
            customer: { select: { name: true } },
          },
        },
      },
    }),
    // Every change to a shelf today, from the stock ledger. This used to be
    // pieced together from whichever papers happened to carry a date, which
    // could not see a correction made by hand and sometimes worked out an
    // opening figure below zero.
    prisma.stockMovement.groupBy({
      by: ["branchId", "kind"],
      where: { businessDate: day, ...shopWhere },
      _sum: { quantity: true },
    }),
    prisma.saleItem.findMany({
      where: {
        sale: {
          status: "COMPLETED",
          saleDate: spanWindow(trendFrom, day),
          ...shopWhere,
        },
      },
      select: {
        quantity: true,
        totalPrice: true,
        costPrice: true,
        product: { select: { costPrice: true } },
        sale: { select: { saleDate: true, subtotal: true, discount: true } },
      },
    }),
    prisma.saleItem.groupBy({
      by: ["productId"],
      where: {
        sale: {
          status: "COMPLETED",
          saleDate: spanWindow(rateFrom, day),
          ...shopWhere,
        },
      },
      _sum: { quantity: true },
    }),
  ])

  // ---- Today, shop by shop -------------------------------------------------
  const byShop = new Map<string, OwnerShopDay>()
  for (const branch of branches) {
    byShop.set(branch.id, {
      branchId: branch.id,
      shop: branch.name,
      openedWith: 0,
      cameIn: 0,
      sold: 0,
      movedOut: 0,
      inShopNow: 0,
      soldValue: 0,
      soldCost: 0,
      byKind: [],
      reconciles: true,
    })
  }
  function shopRow(id: string) {
    return byShop.get(id)
  }

  for (const row of stockRows) {
    const shop = shopRow(row.branchId)
    if (shop) shop.inShopNow += row.quantity
  }
  for (const line of soldToday) {
    const shop = shopRow(line.sale.branchId)
    if (!shop) continue
    shop.sold += line.quantity
    shop.soldValue += lineValueAfterOrderDiscount(line.totalPrice, line.sale)
    shop.soldCost += (money(line.costPrice) || money(line.product.costPrice)) * line.quantity
  }
  // Every shelf change today, grouped by why it happened. Selling is counted
  // from the sale lines above so the pieces and the money come from one place;
  // the ledger supplies everything else.
  for (const row of movesToday) {
    const shop = shopRow(row.branchId)
    if (!shop) continue
    const qty = row._sum.quantity ?? 0
    if (row.kind === "SALE" || row.kind === "SALE_REVERSED") continue
    if (qty > 0) shop.cameIn += qty
    else shop.movedOut += -qty
    shop.byKind.push({ kind: row.kind, quantity: qty })
  }
  // With the ledger in place this is no longer a reconstruction. What the shop
  // opened with is what is on the shelf now, less everything that landed on it
  // today and plus everything that left. Read forwards it says: opened with 70,
  // came in 0, sold 5, 65 in the shop now.
  for (const shop of byShop.values()) {
    const opened = shop.inShopNow + shop.sold + shop.movedOut - shop.cameIn
    // A shelf cannot have started the day below zero. Every path that moves
    // stock now writes a ledger line, so this should not happen; if it ever
    // does the figure is withheld rather than shown wrong.
    shop.reconciles = opened >= 0
    shop.openedWith = shop.reconciles ? opened : null
    shop.byKind.sort((a, b) => Math.abs(b.quantity) - Math.abs(a.quantity))
  }

  const shops = [...byShop.values()].sort((a, b) => b.inShopNow - a.inShopNow)
  const totals = shops.reduce(
    (sum, row) => ({
      openedWith: sum.openedWith + (row.openedWith ?? 0),
      cameIn: sum.cameIn + row.cameIn,
      sold: sum.sold + row.sold,
      movedOut: sum.movedOut + row.movedOut,
      inShopNow: sum.inShopNow + row.inShopNow,
      soldValue: sum.soldValue + row.soldValue,
      soldCost: sum.soldCost + row.soldCost,
      // One shop that will not reconcile makes the whole opening figure unsafe.
      reconciles: sum.reconciles && row.reconciles,
    }),
    {
      openedWith: 0,
      cameIn: 0,
      sold: 0,
      movedOut: 0,
      inShopNow: 0,
      soldValue: 0,
      soldCost: 0,
      reconciles: true,
    }
  )

  // ---- The goods that actually left today ----------------------------------
  const soldLines: OwnerSoldLine[] = soldToday
    .map((line) => {
      const unitCost = money(line.costPrice) || money(line.product.costPrice)
      const value = lineValueAfterOrderDiscount(line.totalPrice, line.sale)
      return {
        id: line.id,
        invoice: line.sale.invoiceNumber,
        item: [line.product.name, line.product.storage, line.product.color].filter(Boolean).join(" · "),
        shop: line.sale.branch.name,
        quantity: line.quantity,
        value,
        profit: value - unitCost * line.quantity,
        customer: line.sale.customer?.name ?? "Walk-in",
        imei: line.imei?.imei1 ?? null,
      }
    })
    .sort((a, b) => b.value - a.value)

  // ---- The last 30 days ----------------------------------------------------
  const trendByDay = new Map<string, { units: number; value: number; profit: number }>()
  for (const dayName of recentWatDays(TREND_DAYS, day)) {
    trendByDay.set(dayName, { units: 0, value: 0, profit: 0 })
  }
  for (const line of soldOverTrend) {
    const key = watDayKey(line.sale.saleDate)
    const bucket = trendByDay.get(key)
    if (!bucket) continue
    const unitCost = money(line.costPrice) || money(line.product.costPrice)
    const value = lineValueAfterOrderDiscount(line.totalPrice, line.sale)
    bucket.units += line.quantity
    bucket.value += value
    bucket.profit += value - unitCost * line.quantity
  }
  const trend = [...trendByDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([dayName, row]) => ({ day: dayName, ...row }))

  // ---- What is running out -------------------------------------------------
  const soldRate = new Map<string, number>()
  for (const row of soldOverRate) soldRate.set(row.productId, row._sum.quantity ?? 0)

  const stockByProduct = new Map<
    string,
    { item: string; category: string; inShop: number; costPrice: number }
  >()
  for (const row of stockRows) {
    const key = row.product.id
    const current = stockByProduct.get(key) ?? {
      item: [row.product.name, row.product.storage, row.product.color].filter(Boolean).join(" · "),
      category: row.product.category.name,
      inShop: 0,
      costPrice: money(row.product.costPrice),
    }
    current.inShop += row.quantity
    stockByProduct.set(key, current)
  }

  const reorder: OwnerReorderLine[] = []
  for (const [productId, row] of stockByProduct) {
    const soldInPeriod = soldRate.get(productId) ?? 0
    if (soldInPeriod <= 0) continue
    const soldPerDay = soldInPeriod / RATE_DAYS
    reorder.push({
      productId,
      item: row.item,
      category: row.category,
      inShop: row.inShop,
      soldPerDay: Math.round(soldPerDay * 100) / 100,
      daysLeft: soldPerDay > 0 ? Math.round((row.inShop / soldPerDay) * 10) / 10 : null,
      soldInPeriod,
      costPrice: row.costPrice,
    })
  }
  // Items that have sold and that sell out soonest come first — that is the
  // order the next purchase list is written in.
  reorder.sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity))

  // Items that moved in the period but are already finished. These are the ones
  // a shop quietly stops selling because nobody notices they are gone.
  const soldOutProductIds = [...soldRate.entries()]
    .filter(([productId, qty]) => qty > 0 && !stockByProduct.has(productId))
    .map(([productId]) => productId)
  const soldOut = soldOutProductIds.length
    ? await prisma.product.findMany({
        where: { id: { in: soldOutProductIds.slice(0, 40) } },
        select: { id: true, name: true, storage: true, color: true, category: { select: { name: true } } },
      })
    : []

  // ---- Where the money is sitting -----------------------------------------
  const valueByCategory = new Map<string, { units: number; value: number }>()
  for (const row of stockRows) {
    const key = row.product.category.name
    const current = valueByCategory.get(key) ?? { units: 0, value: 0 }
    current.units += row.quantity
    current.value += row.quantity * money(row.product.costPrice)
    valueByCategory.set(key, current)
  }
  const stockValue = [...valueByCategory.entries()]
    .map(([category, row]) => ({ category, ...row }))
    .sort((a, b) => b.value - a.value)

  // ---- Best sellers over the period ---------------------------------------
  const topSellers = reorder
    .map((row) => ({ item: row.item, units: row.soldInPeriod }))
    .sort((a, b) => b.units - a.units)
    .slice(0, 8)

  // Managers and the books desk share this board, but what things cost and
  // what we kept are for the profit roles. Zeroed here so they never reach the phone.
  const showMoney = canSeeProfit(user.role)
  if (!showMoney) {
    for (const shop of shops) shop.soldCost = 0
    totals.soldCost = 0
    for (const line of soldLines) line.profit = 0
    for (const bucket of trend) bucket.profit = 0
    for (const row of reorder) row.costPrice = 0
    for (const row of stockValue) row.value = 0
  }

  return {
    day,
    canSeeProfit: showMoney,
    rateDays: RATE_DAYS,
    trendDays: TREND_DAYS,
    allShops: !branchId,
    shops,
    totals,
    soldLines,
    trend,
    reorder,
    soldOut: soldOut.map((row) => ({
      id: row.id,
      item: [row.name, row.storage, row.color].filter(Boolean).join(" · "),
      category: row.category.name,
      soldInPeriod: soldRate.get(row.id) ?? 0,
    })),
    stockValue,
    topSellers,
    stockValueTotal: stockValue.reduce((sum, row) => sum + row.value, 0),
  }
}
