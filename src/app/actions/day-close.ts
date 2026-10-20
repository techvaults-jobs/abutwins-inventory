"use server"

import { revalidatePath } from "next/cache"
import { prisma } from "@/lib/prisma"
import { can, isShopOwner } from "@/lib/permissions"
import { scopedBranchId } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { recentWatDays, watBounds, watDayKey } from "@/lib/lagos-day"
import { money } from "@/lib/utils"
import { saleTenders } from "@/lib/sale-money"
import { offInvoiceMoneyInWhere } from "@/lib/shop-cash"
import { canReachBranch, viewBranchFilter } from "@/lib/branch-scope"
import { healDuplicateDayCloses } from "@/lib/day-close-heal"

async function resolveShop(user: { role: Parameters<typeof scopedBranchId>[0]; branchId: string | null }, requested?: string) {
  const scoped = await scopedBranchId(user.role, user.branchId, requested)
  let shopId = scoped || requested || user.branchId || ""
  if (!shopId) {
    const fromCookie = await viewBranchFilter(user)
    if (fromCookie) shopId = fromCookie
  }
  if (!shopId) {
    const shop = await prisma.branch.findFirst({ where: { isActive: true }, orderBy: [{ isHq: "desc" }, { name: "asc" }] })
    shopId = shop?.id ?? ""
  }
  return shopId
}

async function closedDates(branchId: string) {
  const rows = await prisma.dayClose.findMany({
    where: { branchId },
    select: { businessDate: true, closeDate: true },
  })
  return new Set(
    rows.map((row) => row.businessDate || watDayKey(row.closeDate)).filter((key) => key.length === 10)
  )
}

export async function getUnclosedBusinessDays(branchId: string) {
  // Exported from a "use server" file, so this is a reachable endpoint on its
  // own. Require a signed-in user and keep it to shops they may see, so a hand
  // -typed branch id cannot reveal another shop's trading days.
  const user = await requireUser()
  if (!(await canReachBranch(user, branchId))) return []
  const today = watDayKey()
  const window = recentWatDays(21).filter((day) => day !== today)
  if (!window.length) return []
  const oldest = watBounds(window[window.length - 1]).start
  const [sales, closed] = await Promise.all([
    prisma.sale.findMany({
      where: { branchId, status: "COMPLETED", saleDate: { gte: oldest } },
      select: { saleDate: true },
    }),
    closedDates(branchId),
  ])
  const sold = new Set(sales.map((sale) => watDayKey(sale.saleDate)))
  return window.filter((day) => sold.has(day) && !closed.has(day))
}

/**
 * Days this shop has trading on but has not balanced yet.
 *
 * This used to stop the till: no new sale until yesterday was counted. It does
 * not any more. Selling is what the shop is open to do, and counting the money
 * is a separate job the cashier does when they are ready — including for a day
 * that has already gone by. Only Balance the till reads this now, to show which
 * days are still waiting.
 */
export async function getUnbalancedDays(branchId?: string) {
  const user = await requireUser()
  const shopId = await resolveShop(user, branchId)
  if (!shopId) return { dates: [] as string[], branchId: "" }
  return { dates: await getUnclosedBusinessDays(shopId), branchId: shopId }
}

export async function getDayClosePreview(branchId?: string, businessDate?: string) {
  const user = await requireUser()
  if (!(await can(user.role, "view.finance")) && !(await can(user.role, "action.sell"))) {
    return {
      sales: [],
      totalSales: 0,
      totalPaid: 0,
      expectedCash: 0,
      transferTotal: 0,
      posTotal: 0,
      creditTotal: 0,
      saleCount: 0,
      onOlderSales: [] as Array<{
        invoice: string
        customer: string
        soldOn: string
        method: string
        amount: number
      }>,
      onOlderSalesTotal: 0,
      otherMoneyIn: [] as Array<{ reference: string; what: string; method: string; amount: number }>,
      otherMoneyInTotal: 0,
      alreadyClosed: false,
      closedRecord: null as null | {
        id: string
        closedBy: string
        closeDate: Date
        expectedCash: number
        countedCash: number
        variance: number
        transferTotal: number
        posTotal: number
        creditTotal: number
        notes: string | null
        cashDrift: number
        liveExpectedCash: number
      },
      branchId: "",
      branchName: "",
      businessDate: watDayKey(),
      unclosed: [] as string[],
    }
  }
  const shopId = await resolveShop(user, branchId)
  await healDuplicateDayCloses()
  const [unclosed, shop] = await Promise.all([
    shopId ? getUnclosedBusinessDays(shopId) : Promise.resolve([]),
    shopId ? prisma.branch.findUnique({ where: { id: shopId }, select: { name: true } }) : Promise.resolve(null),
  ])
  const day = businessDate && businessDate.length === 10 ? businessDate : watDayKey()
  const { start, end } = watBounds(day)
  const [sales, moneyIn, existing, offInvoice] = await Promise.all([
    prisma.sale.findMany({
      where: {
        status: "COMPLETED",
        ...(shopId ? { branchId: shopId } : {}),
        saleDate: { gte: start, lt: end },
      },
      include: {
        customer: true,
        user: { select: { id: true, name: true, email: true, role: true, branchId: true } },
        items: { include: { product: true, imei: true } },
        payments: true,
      },
      orderBy: { saleDate: "desc" },
    }),
    // Money that actually came in on this day, whichever day the sale was made.
    // Counting a debt collected today against the day the goods left meant the
    // cash was expected in a till that closed days ago — and never expected in
    // the one it was really dropped into.
    prisma.payment.findMany({
      where: {
        paidAt: { gte: start, lt: end },
        sale: { status: "COMPLETED", ...(shopId ? { branchId: shopId } : {}) },
      },
      select: {
        amount: true,
        method: true,
        paidAt: true,
        sale: { select: { invoiceNumber: true, saleDate: true, customer: { select: { name: true } } } },
      },
    }),
    shopId
      ? prisma.dayClose.findFirst({
          where: {
            branchId: shopId,
            OR: [{ businessDate: day }, { closeDate: { gte: start, lt: end } }],
          },
          include: { user: { select: { id: true, name: true, email: true, role: true, branchId: true } } },
        })
      : Promise.resolve(null),
    // Customer money handed over with no sale payment behind it: an opening
    // balance or repair charge paid on account, or the extra on a dearer
    // replacement. It is in the drawer, so the count must expect it.
    prisma.financeEntry.findMany({
      where: {
        ...(shopId ? { branchId: shopId } : {}),
        account: { in: ["CASH", "BANK"] },
        createdAt: { gte: start, lt: end },
        ...offInvoiceMoneyInWhere,
      },
      select: { amount: true, account: true, reference: true, description: true },
      orderBy: { createdAt: "asc" },
    }),
  ])

  const totalSales = sales.reduce((sum, sale) => sum + money(sale.totalAmount), 0)
  const totalPaid = sales.reduce((sum, sale) => sum + money(sale.paidAmount), 0)

  // What the shop is still owed on the goods that left today. This belongs to
  // the day of the sale, so it stays with the sales.
  const creditTotal = sales.reduce((sum, sale) => sum + saleTenders(sale).credit, 0)

  // Till money is counted by the day it arrived. Each payment row carries its
  // own date, so a deposit taken at the counter and a debt paid off weeks later
  // each land on the day the money was really handed over.
  const tillMix = moneyIn.reduce(
    (acc, row) => {
      const amount = money(row.amount)
      if (row.method === "CASH") acc.cash += amount
      else if (row.method === "TRANSFER") acc.transfer += amount
      else if (row.method === "POS") acc.pos += amount
      return acc
    },
    { cash: 0, transfer: 0, pos: 0 }
  )

  // Sales old enough to predate payment rows kept their money on the sale alone.
  // Without this they would drop out of the till figures entirely.
  const legacy = sales.reduce(
    (acc, sale) => {
      if (sale.payments.length > 0) return acc
      const row = saleTenders(sale)
      acc.cash += row.cash
      acc.transfer += row.transfer
      acc.pos += row.pos
      if (row.cash === 0 && row.transfer === 0 && row.pos === 0) acc.unknown += row.collected
      return acc
    },
    { cash: 0, transfer: 0, pos: 0, unknown: 0 }
  )

  const otherMoneyIn = offInvoice.map((row) => ({
    reference: row.reference ?? "",
    what: row.description ?? "",
    method: row.account === "CASH" ? "CASH" : "TRANSFER",
    amount: money(row.amount),
  }))
  const otherCash = otherMoneyIn.filter((row) => row.method === "CASH").reduce((sum, row) => sum + row.amount, 0)
  const otherBank = otherMoneyIn.filter((row) => row.method !== "CASH").reduce((sum, row) => sum + row.amount, 0)

  const expectedCash = tillMix.cash + legacy.cash + otherCash
  const transferTotal = tillMix.transfer + legacy.transfer + otherBank
  const posTotal = tillMix.pos + legacy.pos + legacy.unknown

  // Money taken today on goods that left on an earlier day. Shown on its own so
  // the till count is not mistaken for the day's trading.
  const onOlderSales = moneyIn
    .filter((row) => watDayKey(row.sale.saleDate) !== day)
    .map((row) => ({
      invoice: row.sale.invoiceNumber,
      customer: row.sale.customer?.name ?? "Walk-in",
      soldOn: watDayKey(row.sale.saleDate),
      method: row.method,
      amount: money(row.amount),
    }))
    .sort((a, b) => b.amount - a.amount)
  const onOlderSalesTotal = onOlderSales.reduce((sum, row) => sum + row.amount, 0)

  return {
    sales: sales.map((sale) => ({
      id: sale.id,
      invoiceNumber: sale.invoiceNumber,
      saleDate: sale.saleDate,
      customer: sale.customer?.name ?? "Walk-in customer",
      staff: sale.user?.name ?? "Staff",
      method: sale.paymentMethod,
      paid: money(sale.paidAmount),
      total: money(sale.totalAmount),
      itemCount: sale.items.reduce((sum, item) => sum + item.quantity, 0),
      itemsSummary: sale.items.map((it) => `${it.quantity}x ${it.product.name}`).join(", "),
      items: sale.items.map((it) => ({
        id: it.id,
        name: it.product.name,
        storage: it.product.storage,
        condition: it.product.condition,
        color: it.product.color,
        imei: it.imei?.imei1 ?? null,
        serialNumber: it.imei?.serialNumber ?? null,
        quantity: it.quantity,
        unitPrice: money(it.unitPrice),
        totalPrice: money(it.totalPrice),
        warrantyDays: it.warrantyDays ?? 0,
      })),
    })),
    totalSales,
    totalPaid,
    expectedCash,
    transferTotal,
    posTotal,
    creditTotal,
    saleCount: sales.length,
    /** Money taken today on goods that left on an earlier day. */
    onOlderSales,
    onOlderSalesTotal,
    /** Money taken today on no sale: collected on account, or paid on a replacement. */
    otherMoneyIn,
    otherMoneyInTotal: otherCash + otherBank,
    alreadyClosed: Boolean(existing),
    closedRecord: existing
      ? {
          id: existing.id,
          closedBy: existing.user?.name ?? "Staff",
          closeDate: existing.closeDate,
          expectedCash: money(existing.expectedCash),
          countedCash: money(existing.countedCash),
          variance: money(existing.variance),
          transferTotal: money(existing.transferTotal),
          posTotal: money(existing.posTotal),
          creditTotal: money(existing.creditTotal),
          notes: existing.notes,
          /**
           * The close keeps the figures as they stood when it was signed. When
           * the day's money has moved since, the old record still reads
           * "balanced" against a total that no longer exists — so the gap is
           * reported rather than left to be discovered in a shortfall.
           */
          cashDrift: money(money(existing.expectedCash) - expectedCash),
          liveExpectedCash: expectedCash,
        }
      : null,
    branchId: shopId,
    branchName: shop?.name ?? "",
    businessDate: day,
    unclosed,
  }
}

export async function closeDay(formData: FormData) {
  try {
    const user = await requireUser()
    if (!(await can(user.role, "action.finance")) && !(await can(user.role, "action.sell"))) {
      return { error: "You are not allowed to close the day. Ask the main admin." }
    }
    const businessDate = String(formData.get("businessDate") || watDayKey())
    const rawBranchId = String(formData.get("branchId") || "")
    const preview = await getDayClosePreview(rawBranchId || undefined, businessDate)
    if (!preview.branchId) return { error: "Choose a shop." }
    // A day already balanced can be balanced again, but not quietly. Counting a
    // day the first time is the cashier's own job; going back over one someone
    // has already signed is a correction, and a correction needs a superior.
    const recount = preview.alreadyClosed
    if (recount && !isShopOwner(user.role) && !(await can(user.role, "action.approve"))) {
      return {
        error:
          "This day has already been balanced. Only a manager, the CEO or the main admin can count it again.",
      }
    }
    // Cash remittance is only required when cash came into the till. Transfer
    // and POS days still close, so Sell now can open tomorrow, but with ₦0 remitted.
    let countedCash = 0
    if (preview.expectedCash > 0) {
      const raw = String(formData.get("countedCash") ?? "").trim()
      if (!raw) return { error: "Cash came in today. Count the till and type the cash remitted." }
      countedCash = Number(raw)
      if (Number.isNaN(countedCash)) return { error: "Enter the cash you counted." }
    }

    // Re-check inside the posting. Two clicks on Close the day used to write two
    // closes for the same date, which then confused the till lock and the books.
    // The lasting fix is the unique index noted in scripts/check-day-closes.ts;
    // this stops the double click that actually happens on the shop floor.
    const figures = {
      userId: user.id,
      closeDate: new Date(),
      expectedCash: preview.expectedCash.toFixed(2),
      countedCash: countedCash.toFixed(2),
      variance: (countedCash - preview.expectedCash).toFixed(2),
      transferTotal: preview.transferTotal.toFixed(2),
      posTotal: preview.posTotal.toFixed(2),
      creditTotal: preview.creditTotal.toFixed(2),
      saleCount: preview.saleCount,
      notes: String(formData.get("notes") || "") || null,
    }
    const closed = await prisma.$transaction(async (tx) => {
      const existing = await tx.dayClose.findFirst({
        where: { branchId: preview.branchId, businessDate },
        select: { id: true },
      })
      if (existing) {
        // Only reachable by a superior, checked above. The count is rewritten
        // against today's figures; the old one stays in Who did what.
        if (!recount) return null
        return tx.dayClose.update({ where: { id: existing.id }, data: figures })
      }
      return tx.dayClose.create({
        data: { branchId: preview.branchId, businessDate, ...figures },
      })
    })
    if (!closed) return { error: "This shop already balanced that day." }

    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: recount ? "UPDATE" : "CREATE",
        entityType: "DayClose",
        entityId: `${preview.branchId}:${businessDate}`,
        newValue: JSON.stringify({
          businessDate,
          expectedCash: preview.expectedCash,
          countedCash,
          ...(recount ? { countedAgain: true } : {}),
        }),
        branchId: preview.branchId,
      },
    })
    revalidatePath("/finance/close")
    revalidatePath("/finance")
    revalidatePath("/reports")
    revalidatePath("/audit/books")
    revalidatePath("/pos")
    revalidatePath("/dashboard")
    const leftover = await getUnclosedBusinessDays(preview.branchId)
    return {
      success: true,
      redirectTo: leftover[0]
        ? `/finance/close?date=${leftover[0]}&branchId=${preview.branchId}`
        : `/finance/close?branchId=${preview.branchId}&date=${businessDate}`,
    }
  } catch (error) {
    console.error("Failed to close day:", error)
    return { error: error instanceof Error ? error.message : "Failed to close the day. Please try again." }
  }
}

/**
 * What each shop sold on each day, the same figure as "Total sales for the
 * day" on Balance the till. Closed days used to show cash + bank + credit as
 * their total sales, which counts money taken that day on older sales and
 * leaves out credit notes, so the list disagreed with the day it opened.
 */
async function salesTotalsByShopDay(days: Array<{ branchId: string; day: string }>) {
  const out = new Map<string, number>()
  const valid = days.filter((row) => row.day.length === 10)
  if (!valid.length) return out
  const sorted = valid.map((row) => row.day).sort()
  const sales = await prisma.sale.findMany({
    where: {
      status: "COMPLETED",
      branchId: { in: [...new Set(valid.map((row) => row.branchId))] },
      saleDate: { gte: watBounds(sorted[0]).start, lt: watBounds(sorted[sorted.length - 1]).end },
    },
    select: { branchId: true, saleDate: true, totalAmount: true },
  })
  for (const sale of sales) {
    const key = `${sale.branchId}:${watDayKey(sale.saleDate)}`
    out.set(key, (out.get(key) ?? 0) + money(sale.totalAmount))
  }
  return out
}

export async function getDayCloses(requestedBranchId?: string) {
  const user = await requireUser()
  if (!(await can(user.role, "view.finance"))) return []
  const branchId = await resolveShop(user, requestedBranchId)
  const rows = await prisma.dayClose.findMany({
    where: branchId ? { branchId } : {},
    include: { branch: true, user: { select: { id: true, name: true, email: true, role: true, branchId: true } } },
    orderBy: { closeDate: "desc" },
    take: 40,
  })
  const salesByDay = await salesTotalsByShopDay(
    rows.map((row) => ({ branchId: row.branchId, day: row.businessDate || watDayKey(row.closeDate) }))
  )
  return rows.map((row) => {
    const expectedCash = money(row.expectedCash)
    const transferTotal = money(row.transferTotal)
    const posTotal = money(row.posTotal)
    const creditTotal = money(row.creditTotal)
    const totalSales = salesByDay.get(`${row.branchId}:${row.businessDate || watDayKey(row.closeDate)}`) ?? 0
    return {
      id: row.id,
      branch: row.branch.name,
      user: row.user.name,
      closeDate: row.closeDate,
      businessDate: row.businessDate || watDayKey(row.closeDate),
      totalSales,
      expectedCash,
      countedCash: money(row.countedCash),
      variance: money(row.variance),
      transferTotal,
      posTotal,
      creditTotal,
      saleCount: row.saleCount,
      notes: row.notes,
    }
  })
}
