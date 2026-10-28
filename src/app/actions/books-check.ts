"use server"

import { prisma } from "@/lib/prisma"
import { can } from "@/lib/permissions"
import { scopedBranchId } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { verifyAuditChain } from "@/lib/audit"
import { getParkedWatch } from "@/app/actions/parked"
import { recentWatDays, shopPeriodWindow, shopPreviousWindow, watBounds, watDayKey, type ShopRange } from "@/lib/lagos-day"
import { getAppSettings } from "@/lib/settings"
import { money } from "@/lib/utils"
import { sumSaleTenders } from "@/lib/sale-money"
import { healOpeningStockBills } from "@/lib/opening-stock-money"
import { payablePurchaseWhere, groupSupplierLedgers } from "@/lib/purchase-money"
import { receiptsInWindow } from "@/lib/receipts"
import { supplierPaidInWindow } from "@/lib/supplier-pay"
import { customersOwing } from "@/lib/owed"

export type BooksRange = ShopRange

function sumSales(
  rows: Array<{
    paymentMethod: string
    totalAmount: unknown
    paidAmount: unknown
    payments?: Array<{ method: string; amount: unknown }> | null
  }>
) {
  const mix = sumSaleTenders(rows)
  return {
    cash: mix.cash,
    transfer: mix.transfer,
    pos: mix.pos,
    credit: mix.credit,
    revenue: mix.revenue,
    collected: mix.collected,
    due: mix.revenue - mix.collected,
    methodSum: mix.received,
    count: mix.count,
  }
}


export async function getBooksCheck(branchId?: string, businessDate?: string, range: BooksRange = "day", compareDate?: string) {
  const user = await requireUser()
  // A money paper: Money in & out or Reports opens it. Who did what alone does not.
  const allowed = (await can(user.role, "view.finance")) || (await can(user.role, "view.reports"))
  if (!allowed) return null
  await healOpeningStockBills()

  const shops = await prisma.branch.findMany({
    where: { isActive: true },
    orderBy: [{ isHq: "desc" }, { name: "asc" }],
    select: { id: true, name: true, code: true },
  })
  const scoped = await scopedBranchId(user.role, user.branchId, branchId)
  const shopId = scoped || branchId || shops[0]?.id || ""
  const day = businessDate && /^\d{4}-\d{2}-\d{2}$/.test(businessDate) ? businessDate : watDayKey()
  const span = range === "week" || range === "month" ? range : "day"
  const window = shopPeriodWindow(day, span)
  const compareDay = compareDate && /^\d{4}-\d{2}-\d{2}$/.test(compareDate) ? compareDate : ""
  const prior = compareDay ? shopPeriodWindow(compareDay, span) : shopPreviousWindow(window.from, span)
  const shopWhere = shopId ? { branchId: shopId } : {}
  const recentDays = recentWatDays(14, day)
  const recentStart = watBounds(recentDays[recentDays.length - 1]).start

  const [sales, priorSales, expenses, priorExpenses, purchases, priorPurchases, debtors, creditors, stock, vaultCounts, products, parked, walkIns, integrity, highRisk, failedLogins, recentSaleDates, settings] =
    await Promise.all([
      prisma.sale.findMany({
        where: { status: "COMPLETED", ...shopWhere, saleDate: { gte: window.start, lt: window.end } },
        include: { customer: true, user: { select: { name: true } }, payments: true },
        orderBy: { saleDate: "desc" },
      }),
      prisma.sale.findMany({
        where: { status: "COMPLETED", ...shopWhere, saleDate: { gte: prior.start, lt: prior.end } },
        select: { paymentMethod: true, totalAmount: true, paidAmount: true, creditNoteUsed: true, payments: { select: { method: true, amount: true } } },
      }),
      prisma.expense.aggregate({
        where: { ...shopWhere, date: { gte: window.start, lt: window.end }, approvedAt: { not: null } },
        _sum: { amount: true },
      }),
      prisma.expense.aggregate({
        where: { ...shopWhere, date: { gte: prior.start, lt: prior.end }, approvedAt: { not: null } },
        _sum: { amount: true },
      }),
      // Sent to suppliers by the day the money left, less undone payments, as
      // on Home. This used to add up what was paid on bills *created* in the
      // window, so a payment on last month's bill never showed in this one.
      supplierPaidInWindow({ branchId: shopId || null, start: window.start, end: window.end }),
      supplierPaidInWindow({ branchId: shopId || null, start: prior.start, end: prior.end }),
      prisma.customer.aggregate({
        where: shopId ? { branchId: shopId } : {},
        _sum: { currentBalance: true },
      }),
      prisma.purchase.findMany({
        where: {
          ...(shopId ? { branchId: shopId } : {}),
          ...payablePurchaseWhere,
        },
        select: { totalAmount: true, paidAmount: true, returnedAmount: true, shippingFee: true, supplier: { select: { creditBalance: true, name: true, id: true } }, supplierId: true },
      }),
      prisma.inventory.findMany({
        where: shopId ? { branchId: shopId } : {},
        include: { product: true, branch: true },
      }),
      prisma.imeiRecord.groupBy({
        by: ["productId", "branchId"],
        where: { status: "IN_STOCK", ...(shopId ? { branchId: shopId } : {}) },
        _count: { _all: true },
      }),
      prisma.product.findMany({ select: { id: true, name: true, tracking: true } }),
      getParkedWatch(),
      prisma.sale.count({
        where: { status: "COMPLETED", ...shopWhere, customerId: null, saleDate: { gte: window.start, lt: window.end } },
      }),
      verifyAuditChain(),
      prisma.auditLog.count({
        where: { risk: "HIGH", createdAt: { gte: window.start, lt: window.end } },
      }),
      prisma.auditLog.count({
        where: { action: "LOGIN", success: false, createdAt: { gte: window.start, lt: window.end } },
      }),
      prisma.sale.findMany({
        where: { status: "COMPLETED", ...shopWhere, saleDate: { gte: recentStart, lt: window.end } },
        select: { saleDate: true },
      }),
      getAppSettings(),
    ])

  // "Total payments received" is money by the day it arrived, like the till:
  // debts collected in the period count; the per-sale mix stays for the rest.
  const [receiptsNow, receiptsThen] = await Promise.all([
    receiptsInWindow({ branchId: shopId || null, start: window.start, end: window.end }),
    receiptsInWindow({ branchId: shopId || null, start: prior.start, end: prior.end }),
  ])
  const now = { ...sumSales(sales), methodSum: receiptsNow.total, cash: receiptsNow.cash, transfer: receiptsNow.transfer, pos: receiptsNow.pos }
  const then = { ...sumSales(priorSales), methodSum: receiptsThen.total, cash: receiptsThen.cash, transfer: receiptsThen.transfer, pos: receiptsThen.pos }
  const expenseNow = money(expenses._sum.amount)
  const expenseThen = money(priorExpenses._sum.amount)
  const paidNow = purchases
  const paidThen = priorPurchases
  const change = (current: number, previous: number) => {
    if (!previous) return { value: current ? "New" : "0", amount: current - previous, up: current >= previous }
    const pct = ((current - previous) / previous) * 100
    return { value: `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`, amount: current - previous, up: pct >= 0 }
  }
  const soldOn = new Map<string, number>()
  for (const sale of recentSaleDates) {
    const key = watDayKey(sale.saleDate)
    soldOn.set(key, (soldOn.get(key) ?? 0) + 1)
  }

  const supplierLedgers = groupSupplierLedgers(
    creditors.map((row) => ({
      supplierId: row.supplierId,
      supplierName: row.supplier.name,
      creditBalance: row.supplier.creditBalance,
      totalAmount: row.totalAmount,
      paidAmount: row.paidAmount,
      returnedAmount: row.returnedAmount,
      shippingFee: row.shippingFee,
    }))
  )
  const supplierOwed = supplierLedgers.reduce((sum, row) => sum + row.owed, 0)
  const supplierCredit = supplierLedgers.reduce((sum, row) => sum + row.surplus, 0)
  const expectedCash = now.cash
  const shop = shops.find((row) => row.id === shopId)

  const imeiRows = stock
    .filter((row) => {
      const product = products.find((item) => item.id === row.productId)
      return product && product.tracking !== "NONE"
    })
    .map((row) => {
      const imeis = vaultCounts.find((item) => item.productId === row.productId && item.branchId === row.branchId)?._count._all ?? 0
      return {
        product: row.product.name,
        shop: row.branch.code,
        shopQty: row.quantity,
        imeis,
        delta: imeis - row.quantity,
      }
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  const imeiGaps = imeiRows.filter((row) => row.delta !== 0)

  const byStaff = Object.values(
    sales.reduce<Record<string, { name: string; count: number; collected: number }>>((acc, sale) => {
      const name = sale.user?.name ?? "Unknown"
      acc[name] = acc[name] ?? { name, count: 0, collected: 0 }
      acc[name].count += 1
      acc[name].collected += money(sale.paidAmount)
      return acc
    }, {})
  ).sort((a, b) => b.collected - a.collected)

  const papers = [
    {
      ok: integrity.ok,
      label: "Who did what stays locked",
      detail: integrity.ok
        ? `${integrity.checked} locked steps checked. Nothing changed after the fact.`
        : "A locked step was changed. Treat this as serious.",
      fix: integrity.ok
        ? null
        : "Open Who did what. Find the changed row. Restore from backup if needed.",
      href: "/audit",
    },
    {
      ok: imeiGaps.length === 0,
      label: "IMEI vs shop count",
      detail: imeiGaps.length
        ? `${imeiGaps.length} item${imeiGaps.length === 1 ? "" : "s"} do not match the IMEI list.`
        : "Shop count matches the IMEI list.",
      fix: imeiGaps.length
        ? "Open Home IMEI vs shop count. Count the shelf. Use Stock count if numbers must change."
        : null,
      href: "/dashboard#imei-check",
    },
    {
      ok: parked.sitting === 0 && parked.vanished === 0,
      label: "Waiting sales",
      detail:
        parked.sitting || parked.vanished
          ? `${parked.sitting} waiting on a till. ${parked.vanished} vanished without finishing.`
          : "No waiting sales.",
      fix:
        parked.sitting || parked.vanished
          ? "Open Sell now for waiting sales. Open Who did what for vanished ones."
          : null,
      href: parked.vanished ? "/audit?risk=HIGH" : "/pos",
    },
    {
      ok: walkIns === 0,
      label: "Named buyers",
      detail: walkIns
        ? `${walkIns} sale${walkIns === 1 ? "" : "s"} with no customer name.`
        : "Every sale names a buyer.",
      fix: walkIns
        ? "Open Sales. Attach a real name on each walk-in invoice."
        : null,
      href: "/sales",
    },
    {
      ok: failedLogins === 0,
      label: "Failed sign-ins",
      detail: failedLogins
        ? `${failedLogins} failed sign-in${failedLogins === 1 ? "" : "s"} in this stretch.`
        : "No failed sign-ins.",
      fix: failedLogins
        ? "Open Who did what for failed sign-ins. Reset a known staff password, or lock a strange login."
        : null,
      href: "/audit?result=failed&action=LOGIN",
    },
    {
      ok: highRisk === 0,
      label: "High risk steps",
      detail: highRisk
        ? `${highRisk} high risk step${highRisk === 1 ? "" : "s"} in this stretch.`
        : "No high risk steps.",
      fix: highRisk
        ? "Open Who did what, high risk. Confirm each step was allowed."
        : null,
      href: "/audit?risk=HIGH",
    },
  ]
  const openPapers = papers.filter((row) => !row.ok)

  return {
    shops,
    shopId,
    shopName: shop?.name ?? "Shop",
    shopCode: shop?.code ?? "SHOP",
    businessDate: day,
    range: span,
    from: window.from,
    to: window.to,
    priorFrom: prior.from,
    priorTo: prior.to,
    salesCount: now.count,
    cash: now.cash,
    transfer: now.transfer,
    pos: now.pos,
    credit: now.credit,
    collected: now.collected,
    revenue: now.revenue,
    due: now.due,
    methodSum: now.methodSum,
    debtsCollected: receiptsNow.debtsCollected,
    expenses: expenseNow,
    purchasesPaid: paidNow,
    moneyOut: expenseNow + paidNow,
    // Same rule as Home and Reports (customersOwing).
    customersOwe: (await customersOwing(shopId || null)).reduce((sum, row) => sum + row.owed, 0),
    supplierOwed,
    supplierCredit,
    expectedCash,
    parked,
    walkIns,
    highRisk,
    failedLogins,
    integrity,
    papers,
    openCount: openPapers.length,
    verdict: openPapers.length
      ? `${openPapers.length} still open. Finish them before this paper is signed.`
      : "These books match. Ready to sign.",
    compare: {
      revenue: change(now.revenue, then.revenue),
      collected: change(now.collected, then.collected),
      methodSum: change(now.methodSum, then.methodSum),
      count: change(now.count, then.count),
      cash: change(now.cash, then.cash),
      transfer: change(now.transfer, then.transfer),
      pos: change(now.pos, then.pos),
      credit: change(now.credit, then.credit),
      due: change(now.due, then.due),
      expenses: change(expenseNow, expenseThen),
      moneyOut: change(expenseNow + paidNow, expenseThen + paidThen),
      priorRevenue: then.revenue,
      priorCollected: then.collected,
      priorMethodSum: then.methodSum,
      priorCount: then.count,
      priorCash: then.cash,
      priorTransfer: then.transfer,
      priorPos: then.pos,
      priorCredit: then.credit,
      priorDue: then.due,
      priorExpenses: expenseThen,
      priorPurchasesPaid: paidThen,
      priorMoneyOut: expenseThen + paidThen,
    },
    comparePicked: Boolean(compareDay),
    recentDays: recentDays.map((key) => ({
      day: key,
      sales: soldOn.get(key) ?? 0,
    })),
    statementRef: `BK-${shop?.code ?? "SHOP"}-${window.from.replaceAll("-", "")}-${window.to.replaceAll("-", "")}`,
    preparedAt: new Date().toISOString(),
    preparedBy: user.name || user.email,
    company: {
      name: settings.companyName,
      product: settings.productName,
      phone: settings.companyPhone,
      address: settings.companyAddress,
      email: settings.companyEmail,
      logo: settings.companyLogo,
      footer: settings.companyFooter,
    },
    invoices: sales.slice(0, 40).map((sale) => ({
      id: sale.id,
      invoice: sale.invoiceNumber,
      when: sale.saleDate.toISOString(),
      customer: sale.customer?.name ?? "Walk-in",
      staff: sale.user?.name ?? "Unknown",
      method: sale.paymentMethod,
      total: money(sale.totalAmount),
      paid: money(sale.paidAmount),
    })),
    byStaff,
    imeiGaps: imeiGaps.length,
    imeiRows: imeiRows.slice(0, 20),
  }
}

export type BooksCheck = NonNullable<Awaited<ReturnType<typeof getBooksCheck>>>
