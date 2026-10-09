"use server"

import { prisma } from "@/lib/prisma"
import { viewBranchFilter } from "@/lib/branch-scope"
import { requireUser } from "@/lib/session"
import { canSeeCost, scopedBranchId } from "@/lib/rbac"
import { isShopOwner } from "@/lib/permissions"
import { money } from "@/lib/utils"
import { healOpeningStockBills } from "@/lib/opening-stock-money"
import { payablePurchaseWhere, groupSupplierLedgers, SUPPLIER_PAYMENT_NOTE } from "@/lib/purchase-money"
import { getUnclosedBusinessDays } from "@/app/actions/day-close"
import { getParkedWatch } from "@/app/actions/parked"
import { getAppSettings } from "@/lib/settings"
import { isLowStock, shelfKey } from "@/lib/stock-limits"
import { stockedPairs } from "@/lib/stocked-pairs"
import { shopPeriodWindow, shopPreviousWindow, watBounds, watDayKey } from "@/lib/lagos-day"
import { receiptsInWindow } from "@/lib/receipts"
import { customersOwing } from "@/lib/owed"

export async function getDashboardData() {
  const user = await requireUser()
  const branchId = await viewBranchFilter(user)
  await healOpeningStockBills()

  const saleWhere = {
    status: "COMPLETED" as const,
    ...(branchId ? { branchId } : {}),
  }
  const expenseWhere = branchId ? { branchId } : {}

  const now = new Date()
  // Months run on Lagos days, like Reports. The server clock is UTC, so a
  // month built from it started an hour late, and "last month" stopped at the
  // first minute of its final day, leaving that whole day out of the trends.
  const thisMonth = shopPeriodWindow(watDayKey(), "month")
  const lastMonth = shopPreviousWindow(thisMonth.from, "month")
  const inThisMonth = { gte: thisMonth.start, lt: thisMonth.end }
  const inLastMonth = { gte: lastMonth.start, lt: lastMonth.end }
  // Money sent to suppliers by the day it left, from the money ledger. The
  // amount paid on bills *created* this month missed payments on older bills
  // and counted later payments on this month's bills in the wrong month.
  const supplierPaidWhere = (createdAt: { gte: Date; lt: Date }) => ({
    ...(branchId ? { branchId } : {}),
    type: "EXPENSE" as const,
    description: { startsWith: SUPPLIER_PAYMENT_NOTE },
    createdAt,
  })

  const [
    sales,
    lastSales,
    expenses,
    lastExpenses,
    paymentsIn,
    lastPaymentsIn,
    purchasesPaid,
    debts,
    stock,
    recentSales,
    brandGroups,
    returns,
    swaps,
    unread,
    branches,
    pendingApprovals,
    walkIns,
    openPurchases,
    vaultCounts,
    overdueIncoming,
    revenueByBranch,
    inStockByProduct,
    pendingTransfers,
    receiveShortages,
  ] = await Promise.all([
    prisma.sale.aggregate({
      where: { ...saleWhere, saleDate: inThisMonth },
      _sum: { totalAmount: true, paidAmount: true },
      _count: true,
    }),
    prisma.sale.aggregate({
      where: { ...saleWhere, saleDate: inLastMonth },
      _sum: { totalAmount: true },
    }),
    prisma.expense.aggregate({
      where: { ...expenseWhere, date: inThisMonth, approvedAt: { not: null } },
      _sum: { amount: true },
    }),
    prisma.expense.aggregate({
      where: { ...expenseWhere, date: inLastMonth, approvedAt: { not: null } },
      _sum: { amount: true },
    }),
    // Money in by the day it arrived, the same rule as Reports and the till.
    receiptsInWindow({ branchId, start: thisMonth.start, end: thisMonth.end }),
    receiptsInWindow({ branchId, start: lastMonth.start, end: lastMonth.end }),
    prisma.financeEntry.aggregate({ where: supplierPaidWhere(inThisMonth), _sum: { amount: true } }),
    prisma.customer.aggregate({
      where: branchId ? { branchId } : {},
      _sum: { currentBalance: true },
    }),
    prisma.inventory.findMany({
      where: branchId ? { branchId } : {},
      select: { productId: true, branchId: true, quantity: true, minStock: true },
    }),
    prisma.sale.findMany({
      where: saleWhere,
      include: { customer: true, branch: true },
      orderBy: { saleDate: "desc" },
      take: 6,
    }),
    // Names, cost and brand only. This used to pull every IMEI record in the
    // business into memory on every dashboard load, just to count them.
    prisma.product.findMany({
      select: {
        id: true,
        name: true,
        tracking: true,
        costPrice: true,
        sellingPrice: true,
        brand: { select: { name: true } },
      },
    }),
    prisma.stockReturn.count({ where: branchId ? { branchId } : {} }),
    prisma.swap.count({ where: { ...(branchId ? { branchId } : {}), status: "COMPLETED" } }),
    prisma.notification.count({ where: { userId: user.id, status: "UNREAD" } }),
    prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
    }),
    prisma.approval.count({ where: { status: "PENDING" } }),
    prisma.sale.count({ where: { ...saleWhere, customerId: null } }),
    prisma.purchase.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        ...payablePurchaseWhere,
      },
      select: {
        totalAmount: true,
        paidAmount: true,
        returnedAmount: true,
        supplierId: true,
        supplier: { select: { name: true, creditBalance: true } },
      },
    }),
    prisma.imeiRecord.groupBy({
      by: ["productId", "branchId"],
      where: { status: "IN_STOCK", ...(branchId ? { branchId } : {}) },
      _count: { _all: true },
    }),
    prisma.incomingLot.count({
      where: {
        status: "COMING",
        expectedDate: { lt: watBounds(watDayKey()).start },
        ...(branchId ? { branchId } : {}),
      },
    }),
    // Revenue per shop, added up by the database. Reading every completed sale
    // to add them up in memory was the heaviest query on the busiest page.
    prisma.sale.groupBy({
      by: ["branchId"],
      where: { status: "COMPLETED" },
      _sum: { totalAmount: true },
    }),
    // In-shop units per item, for the device mix. Left unscoped so the chart
    // shows the same figures it always has.
    prisma.imeiRecord.groupBy({
      by: ["productId"],
      where: { status: "IN_STOCK" },
      _count: { _all: true },
    }),
    prisma.stockTransfer.count({
      where: {
        status: { in: ["PENDING", "IN_TRANSIT"] },
        ...(branchId ? { OR: [{ fromBranchId: branchId }, { toBranchId: branchId }] } : {}),
      },
    }),
    prisma.incomingItem.findMany({
      where: {
        receivedQuantity: { not: null },
        lot: {
          status: "ARRIVED",
          ...(branchId ? { branchId } : {}),
          updatedAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
        },
      },
      select: { expectedQuantity: true, receivedQuantity: true, quantity: true },
    }),
  ])

  const thisSales = money(sales._sum.totalAmount)
  const prevSales = money(lastSales._sum.totalAmount)
  const thisExp = money(expenses._sum.amount)
  const prevExp = money(lastExpenses._sum.amount)
  const received = paymentsIn.total
  const sent = money(purchasesPaid._sum.amount) + thisExp
  const lastSent = money(
    (await prisma.financeEntry.aggregate({ where: supplierPaidWhere(inLastMonth), _sum: { amount: true } }))._sum.amount
  ) + prevExp

  // One pass to index the catalogue, then every figure below is a map lookup
  // instead of a nested query result.
  const productById = new Map(brandGroups.map((row) => [row.id, row]))
  const branchById = new Map(branches.map((row) => [row.id, row]))

  // Stock at cost is the CEO's figure. Everyone else sees it at sell price.
  const stockAtCost = canSeeCost(user.role)
  const stockValue = stock.reduce((sum, row) => {
    const product = productById.get(row.productId)
    return sum + row.quantity * money(stockAtCost ? product?.costPrice : product?.sellingPrice)
  }, 0)

  // The last six Lagos months, oldest first, each a whole month.
  const months: Array<{ key: string; label: string; start: Date; end: Date }> = []
  for (let window = thisMonth, index = 0; index < 6; index += 1, window = shopPreviousWindow(window.from, "month")) {
    const [year, month] = window.from.split("-").map(Number)
    months.unshift({
      key: window.from.slice(0, 7),
      label: new Date(Date.UTC(year, month - 1, 15)).toLocaleString("en-NG", { month: "short", timeZone: "UTC" }),
      start: window.start,
      // This month's bar runs to the end of today, earlier months to their end.
      end: window.end,
    })
  }

  const chartSales = await Promise.all(
    months.map(async (month) => {
      const [monthSales, monthPurchases] = await Promise.all([
        prisma.sale.aggregate({
          where: { ...saleWhere, saleDate: { gte: month.start, lt: month.end } },
          _sum: { totalAmount: true },
        }),
        prisma.purchase.aggregate({
          where: {
            ...(branchId ? { branchId } : {}),
            createdAt: { gte: month.start, lt: month.end },
            ...payablePurchaseWhere,
          },
          _sum: { totalAmount: true },
        }),
      ])
      return {
        month: month.label,
        sales: money(monthSales._sum.totalAmount),
        purchases: money(monthPurchases._sum.totalAmount),
        target: 0,
      }
    })
  )

  const devices = Object.values(
    inStockByProduct.reduce<Record<string, { name: string; value: number }>>((acc, row) => {
      const name = productById.get(row.productId)?.brand.name
      if (!name) return acc
      acc[name] = acc[name] ?? { name, value: 0 }
      acc[name].value += row._count._all
      return acc
    }, {})
  )

  const revenueById = new Map(revenueByBranch.map((row) => [row.branchId, money(row._sum.totalAmount)]))
  const ranking = branches
    .map((branch) => ({
      name: branch.name,
      revenue: revenueById.get(branch.id) ?? 0,
    }))
    .sort((a, b) => b.revenue - a.revenue)

  const [parked, unclosedLists] = await Promise.all([
    getParkedWatch(),
    Promise.all((branchId ? branches.filter((branch) => branch.id === branchId) : branches).map((branch) => getUnclosedBusinessDays(branch.id))),
  ])
  const unclosedCount = unclosedLists.reduce((sum, days) => sum + days.length, 0)

  // ── CEO / owner: per-staff sales today + unclosed day detail ─────────────
  // Computed after `day` is declared below. Placeholder — filled after day.
  const isOwner = isShopOwner(user.role)

  // Only lines a shop actually carries: an item registered for every shop but
  // never stocked at one is not "low" there, just not sold there.
  const [stocked, settings] = await Promise.all([stockedPairs(branchId), getAppSettings()])
  const carried = stock
    .map((row) => ({ ...row, everStocked: row.quantity > 0 || stocked.has(shelfKey(row.productId, row.branchId)) }))
    .filter((row) => row.everStocked)

  // Approved but not finished. An approved Swap Deal has already handed the
  // phone over, yet its invoice and the balance the customer owes are only
  // written when someone presses Finish. Left alone, that sale never reaches
  // Sales, the till or what the customer owes. A return waits the same way
  // for its refund or replacement.
  const [unfinishedSwaps, unfinishedReturns] = await Promise.all([
    prisma.swap.count({ where: { ...(branchId ? { branchId } : {}), status: "APPROVED" } }),
    prisma.stockReturn.count({ where: { ...(branchId ? { branchId } : {}), status: "APPROVED" } }),
  ])

  // Indexed once. Matching these two lists with .find() inside a loop was
  // catalogue-size squared work on every load.
  const vaultByKey = new Map(
    vaultCounts.map((row) => [`${row.productId}:${row.branchId}`, row._count._all])
  )
  const seenImeiKeys = new Set<string>()
  const imeiCheck = stock
    .flatMap((row) => {
      const product = productById.get(row.productId)
      if (!product || product.tracking === "NONE") return []
      const key = `${row.productId}:${row.branchId}`
      seenImeiKeys.add(key)
      const imeis = vaultByKey.get(key) ?? 0
      return [
        {
          id: key,
          product: product.name,
          shop: branchById.get(row.branchId)?.code ?? "Shop",
          shopQty: row.quantity,
          imeis,
          delta: imeis - row.quantity,
        },
      ]
    })
    .concat(
      vaultCounts.flatMap((vault) => {
        const key = `${vault.productId}:${vault.branchId}`
        if (seenImeiKeys.has(key)) return []
        const product = productById.get(vault.productId)
        if (!product || product.tracking === "NONE") return []
        return [
          {
            id: key,
            product: product.name,
            shop: branchById.get(vault.branchId)?.code ?? "Shop",
            shopQty: 0,
            imeis: vault._count._all,
            delta: vault._count._all,
          },
        ]
      })
    )
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.product.localeCompare(b.product))

  // Today, in Lagos time: the whole view, and this person's own sales.
  const day = watBounds(watDayKey())
  // Money in today by the day it arrived, like Balance the till: includes
  // debts collected today on earlier sales.
  const takenToday = await receiptsInWindow({ branchId, start: day.start, end: day.end })
  // The last seven Lagos days, oldest first, for the trend line under today's
  // sales. One read of the week's sales, bucketed by the day they were made.
  const weekKeys = Array.from({ length: 7 }, (_, index) => watDayKey(new Date(Date.now() - (6 - index) * 86_400_000)))
  const weekRows = await prisma.sale.findMany({
    where: { ...saleWhere, saleDate: { gte: watBounds(weekKeys[0]).start, lt: day.end } },
    select: { saleDate: true, totalAmount: true },
  })
  const weekTotals = new Map(weekKeys.map((key) => [key, 0]))
  for (const row of weekRows) {
    const key = watDayKey(row.saleDate)
    if (weekTotals.has(key)) weekTotals.set(key, (weekTotals.get(key) ?? 0) + money(row.totalAmount))
  }
  // The same weekday last week, so today's figures carry a fair comparison
  // (a Saturday against a Saturday, not against a quiet Friday).
  const lastWeek = watBounds(watDayKey(new Date(Date.now() - 7 * 86_400_000)))
  const [lastWeekSales, lastWeekTaken, owing] = await Promise.all([
    prisma.sale.aggregate({
      where: { ...saleWhere, saleDate: { gte: lastWeek.start, lt: lastWeek.end } },
      _sum: { totalAmount: true },
    }),
    receiptsInWindow({ branchId, start: lastWeek.start, end: lastWeek.end }),
    customersOwing(branchId),
  ])
  const [todayAll, todayMine] = await Promise.all([
    prisma.sale.aggregate({
      where: { ...saleWhere, saleDate: { gte: day.start, lt: day.end } },
      _sum: { totalAmount: true, paidAmount: true },
      _count: true,
    }),
    prisma.sale.aggregate({
      where: { ...saleWhere, userId: user.id, saleDate: { gte: day.start, lt: day.end } },
      _sum: { totalAmount: true },
      _count: true,
    }),
  ])

  // ── CEO / owner: per-staff sales today + unclosed day breakdown ──────────
  // Fetched after `day` is available. Only for CEO and Super Admin.
  const todayKey = watDayKey()
  const [staffSalesToday, allSalesForUnclosed, closedDayKeys] = isOwner
    ? await Promise.all([
        prisma.sale.groupBy({
          by: ["userId"],
          where: { ...saleWhere, saleDate: { gte: day.start, lt: day.end } },
          _sum: { totalAmount: true },
          _count: true,
        }),
        prisma.sale.findMany({
          where: { status: "COMPLETED", ...(branchId ? { branchId } : {}) },
          select: {
            branchId: true,
            userId: true,
            saleDate: true,
            totalAmount: true,
            paidAmount: true,
            branch: { select: { name: true, code: true } },
            user: { select: { name: true, email: true, role: true } },
          },
        }),
        prisma.dayClose.findMany({
          where: branchId ? { branchId } : {},
          select: { branchId: true, businessDate: true },
        }),
      ])
    : [[], [], []] as [never[], never[], never[]]

  // Staff name lookup for the per-staff panel
  const staffUserIds = (staffSalesToday as Array<{ userId: string }>).map((r) => r.userId)
  const staffUsers = staffUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: staffUserIds } },
        select: { id: true, name: true, email: true, role: true, branch: { select: { name: true, code: true } } },
      })
    : []
  const staffUserMap = new Map(staffUsers.map((u) => [u.id, u]))

  const salesByStaff = (staffSalesToday as Array<{ userId: string; _sum: { totalAmount: unknown }; _count: number }>)
    .map((row) => {
      const staff = staffUserMap.get(row.userId)
      return {
        userId: row.userId,
        name: staff?.name ?? staff?.email ?? "Staff",
        role: staff?.role ?? "",
        shop: staff?.branch?.name ?? "",
        shopCode: staff?.branch?.code ?? "",
        salesCount: row._count,
        salesValue: money(row._sum.totalAmount),
      }
    })
    .sort((a, b) => b.salesValue - a.salesValue)

  // Unclosed days detail — group by shop + business day, cashier, value
  const closedKeySet = new Set(
    (closedDayKeys as Array<{ branchId: string; businessDate: string }>).map((dc) => `${dc.branchId}:${dc.businessDate}`)
  )
  type UnclosedDayRow = {
    shop: string; shopCode: string; branchId: string; businessDate: string
    cashier: string; cashierEmail: string; salesCount: number; salesValue: number; collected: number
  }
  const unclosedMap = new Map<string, UnclosedDayRow>()
  type SaleForUnclosed = {
    branchId: string; userId: string; saleDate: Date; totalAmount: unknown; paidAmount: unknown
    branch: { name: string; code: string }
    user: { name: string | null; email: string; role: string } | null
  }
  for (const sale of allSalesForUnclosed as SaleForUnclosed[]) {
    const dayK = watDayKey(sale.saleDate)
    if (dayK >= todayKey) continue
    const mk = `${sale.branchId}:${dayK}`
    if (closedKeySet.has(mk)) continue
    const existing = unclosedMap.get(mk)
    const v = money(sale.totalAmount), c = money(sale.paidAmount)
    if (!existing) {
      unclosedMap.set(mk, {
        shop: sale.branch.name, shopCode: sale.branch.code, branchId: sale.branchId,
        businessDate: dayK,
        cashier: sale.user?.name ?? sale.user?.email ?? "Staff",
        cashierEmail: sale.user?.email ?? "",
        salesCount: 1, salesValue: v, collected: c,
      })
    } else { existing.salesCount += 1; existing.salesValue += v; existing.collected += c }
  }
  const unclosedDaysDetail = [...unclosedMap.values()].sort((a, b) => b.businessDate.localeCompare(a.businessDate))

  return {
    user,
    unread,
    today: {
      sales: money(todayAll._sum.totalAmount),
      paid: takenToday.total,
      debtsCollected: takenToday.debtsCollected,
      count: todayAll._count,
      mine: money(todayMine._sum.totalAmount),
      mineCount: todayMine._count,
      week: weekKeys.map((key) => weekTotals.get(key) ?? 0),
      lastWeekSales: money(lastWeekSales._sum.totalAmount),
      lastWeekTaken: lastWeekTaken.total,
      owed: owing.reduce((sum, row) => sum + row.owed, 0),
      owedCustomers: owing.filter((row) => row.owed > 0.005).length,
    },
    kpis: {
      totalSales: thisSales,
      totalExpense: thisExp,
      paymentSent: sent,
      paymentReceived: received,
      paymentSentTrend: trend(sent, lastSent),
      paymentReceivedTrend: trend(received, lastPaymentsIn.total),
      stockValue,
      stockAtCost,
      // Same rule as Reports and Check the books (customersOwing).
      outstanding: owing.reduce((sum, row) => sum + row.owed, 0),
      returns,
      swaps,
      salesCount: sales._count,
      salesTrend: trend(thisSales, prevSales),
      expenseTrend: trend(thisExp, prevExp),
    },
    chartSales,
    devices,
    recentSales,
    // Only the six thinnest lines reach the screen, so only those six are
    // dressed with a product and shop name.
    stock: carried
      .slice()
      .sort((a, b) => a.quantity - b.quantity)
      .slice(0, 6)
      .map((row) => ({
        id: `${row.productId}:${row.branchId}`,
        quantity: row.quantity,
        minStock: row.minStock,
        product: { name: productById.get(row.productId)?.name ?? "Item" },
        branch: { code: branchById.get(row.branchId)?.code ?? "Shop" },
      })),
    ranking,
    imeiCheck,
    // CEO / owner: per-staff today and unclosed day detail
    salesByStaff,
    unclosedDaysDetail,
    exceptions: (() => {
      const ledgers = groupSupplierLedgers(
        openPurchases.map((row) => ({
          supplierId: row.supplierId,
          supplierName: row.supplier.name,
          creditBalance: row.supplier.creditBalance,
          totalAmount: row.totalAmount,
          paidAmount: row.paidAmount,
          returnedAmount: row.returnedAmount,
        }))
      )
      return {
        pendingApprovals,
        walkIns,
        creditorOwed: ledgers.reduce((sum, row) => sum + row.owed, 0),
        supplierCredit: ledgers.reduce((sum, row) => sum + row.surplus, 0),
        imeiGaps: imeiCheck.filter((row) => row.delta !== 0).length,
      }
    })(),
    // Each link opens its list on the tile that holds exactly these rows.
    tasks: [
      { href: "/finance/close", label: "Days not closed yet", count: unclosedCount },
      { href: "/swaps?status=APPROVED", label: "Swap Deals approved but not finished (phone gone, money not recorded)", count: unfinishedSwaps },
      { href: "/returns?status=APPROVED", label: "Returns approved but not finished", count: unfinishedReturns },
      { href: "/pos", label: "Parked sales sitting too long", count: parked.sitting },
      { href: "/audit?risk=HIGH", label: "Parked sales that vanished from a device", count: parked.vanished },
      { href: "/incoming?status=LATE", label: "Goods on the way that are late", count: overdueIncoming },
      {
        href: "/incoming",
        label: "Goods received short of what was expected (last 30 days)",
        count: receiveShortages.filter((row) => {
          const expected = row.expectedQuantity > 0 ? row.expectedQuantity : row.quantity
          return row.receivedQuantity != null && row.receivedQuantity !== expected
        }).length,
      },
      { href: "/transfers?status=PENDING", label: "Shop to shop waiting for the other shop to confirm", count: pendingTransfers },
      { href: "/sales", label: "Sales with no customer name", count: walkIns },
      {
        href: "/inventory",
        label: "Items below the low-stock warning",
        count: carried.filter((row) => isLowStock(row, settings.lowStockThreshold)).length,
      },
      { href: "/approvals", label: "Needs approval", count: pendingApprovals },
    ].filter((task) => task.count > 0),
  }
}

function trend(current: number, previous: number) {
  // Nothing last month means there is nothing to compare with. "+0%" read as
  // "no change", which was not true.
  if (!previous) return undefined
  const change = ((current - previous) / previous) * 100
  return {
    value: `${change >= 0 ? "+" : ""}${change.toFixed(0)}%`,
    up: change >= 0,
  }
}
