"use server"

import { prisma } from "@/lib/prisma"
import { can } from "@/lib/permissions"
import { canSeeCost, scopedBranchId } from "@/lib/rbac"
import { viewBranchFilter } from "@/lib/branch-scope"
import { requireUser } from "@/lib/session"
import { isWatDayKey, watBounds, watDayKey } from "@/lib/lagos-day"
import { money } from "@/lib/utils"

export type StockAsAtRow = {
  id: string
  quantity: number
  product: { name: string; costPrice: number; sellingPrice: number }
  branch: { name: string; code: string }
}

export type StockAsAt = {
  /** The day asked for, as a WAT day key. Today means the shelf as it is now. */
  date: string
  /** The first day the stock ledger can answer for. Earlier days are refused. */
  earliest: string
  rows: StockAsAtRow[]
  byShop: Array<{ code: string; name: string; units: number; value: number }>
  total: number
  basis: "cost" | "sell"
}

/**
 * What each shop held at the close of a past day, and what it was worth then.
 *
 * Every change to a shelf writes a StockMovement line in the same transaction
 * (see recordMovement), so the shelf at the end of day D is today's figure less
 * every move made after D. Prices are put back the same way: the first price
 * change logged after D carries the price that stood on D in its oldPrice.
 *
 * The ledger only began on the day of its first line, so a day before that
 * cannot be worked back and is refused rather than guessed.
 */
export async function getStockAsAt(input: { branchId?: string; date: string }): Promise<StockAsAt | { error: string }> {
  const user = await requireUser()
  if (!(await can(user.role, "view.reports"))) return { error: "You are not allowed to see stock value." }
  const scoped = await scopedBranchId(user.role, user.branchId, input.branchId)
  const branchId = scoped || input.branchId || (await viewBranchFilter(user))
  const showCost = canSeeCost(user.role)

  const today = watDayKey()
  const first = await prisma.stockMovement.findFirst({ orderBy: { businessDate: "asc" }, select: { businessDate: true } })
  const earliest = first?.businessDate ?? today
  if (!isWatDayKey(input.date)) return { error: "Pick a day." }
  const date = input.date > today ? today : input.date
  if (date < earliest) {
    return { error: `Stock history starts on ${earliest}. Pick that day or later.` }
  }

  const shopWhere = branchId ? { branchId } : {}
  const isToday = date === today
  const [shelves, laterMoves, laterPrices] = await Promise.all([
    prisma.inventory.findMany({
      where: shopWhere,
      select: {
        id: true,
        productId: true,
        branchId: true,
        quantity: true,
        product: { select: { name: true, costPrice: true, sellingPrice: true } },
        branch: { select: { name: true, code: true } },
      },
    }),
    isToday
      ? Promise.resolve([])
      : prisma.stockMovement.groupBy({
          by: ["productId", "branchId"],
          where: { ...shopWhere, businessDate: { gt: date } },
          _sum: { quantity: true },
        }),
    isToday
      ? Promise.resolve([])
      : prisma.priceHistory.findMany({
          where: {
            changedAt: { gte: watBounds(date).end },
            priceType: { in: showCost ? ["COST_PRICE", "SELLING_PRICE"] : ["SELLING_PRICE"] },
          },
          orderBy: { changedAt: "asc" },
          select: { productId: true, priceType: true, oldPrice: true },
        }),
  ])

  const movedSince = new Map(laterMoves.map((row) => [`${row.productId}:${row.branchId}`, row._sum.quantity ?? 0]))
  // The earliest change after the day holds that day's price; later ones are ignored.
  const priceThen = new Map<string, number>()
  for (const row of laterPrices) {
    const key = `${row.productId}:${row.priceType}`
    if (!priceThen.has(key)) priceThen.set(key, money(row.oldPrice))
  }

  const rows: StockAsAtRow[] = shelves.map((shelf) => {
    const quantity = Math.max(0, shelf.quantity - (movedSince.get(`${shelf.productId}:${shelf.branchId}`) ?? 0))
    const costPrice = priceThen.get(`${shelf.productId}:COST_PRICE`) ?? money(shelf.product.costPrice)
    const sellingPrice = priceThen.get(`${shelf.productId}:SELLING_PRICE`) ?? money(shelf.product.sellingPrice)
    return {
      id: shelf.id,
      quantity,
      product: { name: shelf.product.name, costPrice: showCost ? costPrice : 0, sellingPrice },
      branch: { name: shelf.branch.name, code: shelf.branch.code },
    }
  })
  // What was on the shelf first, biggest value first, so the answer reads at the top.
  const valueOf = (row: StockAsAtRow) => row.quantity * (showCost ? row.product.costPrice : row.product.sellingPrice)
  rows.sort((a, b) => valueOf(b) - valueOf(a) || a.branch.code.localeCompare(b.branch.code) || a.product.name.localeCompare(b.product.name))

  const shops = new Map<string, { code: string; name: string; units: number; value: number }>()
  for (const row of rows) {
    const shop = shops.get(row.branch.code) ?? { code: row.branch.code, name: row.branch.name, units: 0, value: 0 }
    shop.units += row.quantity
    shop.value += valueOf(row)
    shops.set(row.branch.code, shop)
  }
  const byShop = [...shops.values()].sort((a, b) => b.value - a.value)

  return {
    date,
    earliest,
    rows,
    byShop,
    total: byShop.reduce((sum, shop) => sum + shop.value, 0),
    basis: showCost ? "cost" : "sell",
  }
}
