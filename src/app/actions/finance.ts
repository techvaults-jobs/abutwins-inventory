"use server"

import { revalidatePath } from "next/cache"
import { ExpenseCategory, Prisma, UserRole } from "@prisma/client"
import * as bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { setStock } from "@/lib/concurrency"
import { branchFilter, canReachBranch, OTHER_SHOP, resolveWritableShopId, viewBranchFilter } from "@/lib/branch-scope"
import { requireUser } from "@/lib/session"
import { canApprove, canHardDelete, canManageFinance, canManageStaff, canEditLetterhead, canSeeAllBranches, canSetOpeningMoney, canSeeProfit, isSuperAdmin, scopedBranchId } from "@/lib/rbac"
import { can } from "@/lib/permissions"
import { isLetterheadKey } from "@/lib/letterhead"
import { generateDocNumber, money } from "@/lib/utils"
import { lineValueAfterOrderDiscount, saleTenders, sumSaleTenders } from "@/lib/sale-money"
import { healOpeningStockBills } from "@/lib/opening-stock-money"
import { openingStockSupplierWhere, payablePurchaseWhere, groupSupplierLedgers, purchaseBalance, SUPPLIER_PAYMENT_NOTE } from "@/lib/purchase-money"
import { shopPeriodWindow, shopPreviousWindow, watDayKey, type ShopRange } from "@/lib/lagos-day"
import { writeAudit } from "@/lib/audit"
import {
  displayAccountNumber,
  displayBankName,
  listedBankClash,
} from "@/lib/opening-money"
import { assertCashAvailable, isUndoneCollection } from "@/lib/shop-cash"
import { dueAfterReturns, returnedSaleLineIds, returnedValueBySale } from "@/lib/returned-value"
import { receiptsInWindow } from "@/lib/receipts"
import { customersOwing } from "@/lib/owed"

function emptyFinance() {
  return {
    revenue: 0,
    expenditure: 0,
    supplierPayments: 0,
    netCashFlow: 0,
    cashRevenue: 0,
    bankRevenue: 0,
    openingCash: 0,
    openingBank: 0,
    cashAccount: { balance: 0, entries: [] as FinanceLedgerEntry[] },
    bankAccount: { balance: 0, entries: [] as FinanceLedgerEntry[] },
    entries: [],
    expenses: [],
    debtors: [] as Array<{ id: string; name: string; currentBalance: number; branch: { code: string } }>,
    creditors: [] as Array<{ id: string; name: string; owed: number }>,
    supplierCredits: [] as Array<{ id: string; name: string; owed: number }>,
    canSetOpening: false,
    canRemoveBank: false,
    canDeposit: false,
    cashToBank: 0,
    shops: [] as OpeningCashShop[],
    bankAccounts: [] as NamedBankRow[],
  }
}

type FinanceLedgerEntry = {
  id: string
  date: Date
  branch: string
  type: "IN" | "OUT"
  category: string
  description: string
  amount: number
}

export type OpeningCashShop = {
  id: string
  name: string
  code: string
  openingCash: number
  openingCashAt: string | null
}

export type NamedBankRow = {
  id: string
  bankName: string
  accountNumber: string
  accountName: string | null
  openingBalance: number
  salesReceived: number
  /** Cash moved from a till into this account (Move cash to bank). */
  depositsReceived: number
  /** Refunds on returns paid out of this account. */
  refundsPaid: number
  branchId: string
  branchName: string
  branchCode: string
  createdAt: string
}

function revalidateMoneyViews() {
  revalidatePath("/finance")
  revalidatePath("/audit")
}

/**
 * Everything on Money in & out and Shop expenses.
 *
 * The balances need every sale ever, so the sales are read in full, but only
 * the handful of fields the sums use. The day-by-day ledger lines are only
 * built when `withLedger` is set: they run to one line per payment, so the
 * page leaves them out and the ledger pop-up asks for them through
 * getFinanceLedger when it opens.
 */
export async function getFinance({ withLedger = false }: { withLedger?: boolean } = {}) {
  const user = await requireUser()
  if (!(await can(user.role, "view.finance")) && !(await can(user.role, "view.expenses"))) {
    return emptyFinance()
  }
  await healOpeningStockBills()
  const branchId = await viewBranchFilter(user)
  const where = branchId ? { branchId } : {}

  const [sales, expenses, purchases, entries, debtors, shops, bankAccounts, creditHouses] = await Promise.all([
    prisma.sale.findMany({
      where: { ...where, status: "COMPLETED" },
      select: {
        id: true,
        invoiceNumber: true,
        saleDate: true,
        totalAmount: true,
        paidAmount: true,
        paymentMethod: true,
        branch: { select: { name: true } },
        customer: { select: { name: true } },
        payments: { select: { id: true, method: true, amount: true, bankAccountId: true } },
      },
      orderBy: { saleDate: "desc" },
    }),
    prisma.expense.findMany({
      where,
      include: { branch: true, user: { select: { id: true, name: true, email: true, role: true, branchId: true } } },
      orderBy: { date: "desc" },
    }),
    prisma.purchase.findMany({
      where: {
        ...where,
        ...payablePurchaseWhere,
      },
      include: { supplier: true, branch: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.financeEntry.findMany({
      where,
      include: { branch: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.customer.findMany({
      where: { ...(branchId ? { branchId } : {}), currentBalance: { gt: 0 } },
      include: { branch: true },
      orderBy: { currentBalance: "desc" },
    }),
    prisma.branch.findMany({
      where: { isActive: true, ...(branchId ? { id: branchId } : {}) },
      select: { id: true, name: true, code: true, openingCash: true, openingCashAt: true },
      orderBy: [{ isHq: "desc" }, { name: "asc" }],
    }),
    prisma.bankAccount.findMany({
      where: { isActive: true, ...(branchId ? { branchId } : {}) },
      include: { branch: { select: { name: true, code: true } } },
      orderBy: [{ bankName: "asc" }, { accountNumber: "asc" }],
    }),
    prisma.supplier.findMany({
      // Opening stock names are never a real house: no credit from them either.
      where: { creditBalance: { gt: 0 }, NOT: openingStockSupplierWhere },
      select: { id: true, name: true, creditBalance: true },
    }),
  ])

  // 1. Core Accounting Totals
  const mix = sumSaleTenders(sales)
  const revenue = mix.received
  const cashRevenue = mix.cash
  const bankRevenue = mix.transfer + mix.pos

  const expenditure = expenses
    .filter((e) => e.approvedAt)
    .reduce((sum, e) => sum + money(e.amount), 0)
  const supplierPayments = purchases.reduce((sum, p) => sum + money(p.paidAmount), 0)
  // Supplier payments made in cash already leave the till as a cash pay-out
  // (see otherCashOuts below). Taking every supplier payment off the bank as
  // well counted a cash payment twice: once from the till, once from the bank.
  const cashToSupplierRows = await prisma.financeEntry.findMany({
    where: { ...where, account: "CASH", type: "EXPENSE", description: { startsWith: SUPPLIER_PAYMENT_NOTE } },
    select: { amount: true, description: true },
  })
  const cashToSupplierByBill = new Map<string, number>()
  for (const row of cashToSupplierRows) {
    const invoice = (row.description ?? "").slice(SUPPLIER_PAYMENT_NOTE.length).split(" ")[0]
    cashToSupplierByBill.set(invoice, (cashToSupplierByBill.get(invoice) ?? 0) + money(row.amount))
  }
  const bankToSupplier = (po: { invoiceNumber: string; paidAmount: unknown }) =>
    Math.max(0, money(po.paidAmount) - (cashToSupplierByBill.get(po.invoiceNumber) ?? 0))
  const supplierPaymentsByBank = purchases.reduce((sum, p) => sum + bankToSupplier(p), 0)
  const netCashFlow = revenue - expenditure - supplierPayments

  // 2. Account Ledgers
  const cashEntries: Array<{
    id: string
    date: Date
    branch: string
    type: "IN" | "OUT"
    category: string
    description: string
    amount: number
  }> = []

  const bankEntries: Array<{
    id: string
    date: Date
    branch: string
    type: "IN" | "OUT"
    category: string
    description: string
    amount: number
  }> = []

  const namedBankLabelById = new Map(
    bankAccounts.map((row) => [row.id, `${row.bankName} ${row.accountNumber}`] as const)
  )
  const salesByBank = new Map<string, number>()
  for (const sale of sales) {
    for (const payment of sale.payments ?? []) {
      if (!payment.bankAccountId) continue
      if (payment.method === "CASH") continue
      salesByBank.set(
        payment.bankAccountId,
        (salesByBank.get(payment.bankAccountId) ?? 0) + money(payment.amount)
      )
    }
  }

  for (const sale of sales) {
    const payments = sale.payments?.length ? sale.payments : null
    if (payments) {
      for (const payment of payments) {
        const amount = money(payment.amount)
        if (amount <= 0) continue
        if (payment.method === "CASH") {
          cashEntries.push({
            id: `${sale.id}-${payment.id}`,
            date: sale.saleDate,
            branch: sale.branch.name,
            type: "IN",
            category: "Sales Revenue (Cash)",
            description: `Sale ${sale.invoiceNumber} - ${sale.customer?.name || "Walk-in"}`,
            amount,
          })
        } else {
          const bankLabel = payment.bankAccountId
            ? namedBankLabelById.get(payment.bankAccountId)
            : null
          bankEntries.push({
            id: `${sale.id}-${payment.id}`,
            date: sale.saleDate,
            branch: sale.branch.name,
            type: "IN",
            category: "Sales Revenue (Bank)",
            description: bankLabel
              ? `Sale ${sale.invoiceNumber} into ${bankLabel} - ${sale.customer?.name || "Walk-in"}`
              : `Sale ${sale.invoiceNumber} - ${sale.customer?.name || "Walk-in"}`,
            amount,
          })
        }
      }
    } else {
      const tenders = saleTenders(sale)
      const channels: Array<{ method: string; amount: number }> = [
        { method: "CASH", amount: tenders.cash },
        { method: "BANK", amount: tenders.bank },
      ]
      for (const channel of channels) {
        if (channel.amount <= 0) continue
        const entry = {
          id: `${sale.id}-${channel.method}`,
          date: sale.saleDate,
          branch: sale.branch.name,
          type: "IN" as const,
          category: `Sales Revenue (${channel.method === "CASH" ? "Cash" : "Bank"})`,
          description: `Sale ${sale.invoiceNumber} - ${sale.customer?.name || "Walk-in"}`,
          amount: channel.amount,
        }
        if (channel.method === "CASH") cashEntries.push(entry)
        else bankEntries.push(entry)
      }
    }
  }

  for (const exp of expenses) {
    if (!exp.approvedAt) continue
    cashEntries.push({
      id: exp.id,
      date: exp.date,
      branch: exp.branch.name,
      type: "OUT" as const,
      category: `Expense: ${exp.category}`,
      description: `${exp.expenseNumber} - ${exp.description}`,
      amount: money(exp.amount),
    })
  }

  // Move cash to bank: out of the till's shop, into the named account's shop.
  // Either side can be the shop in view, so each side is counted on its own.
  const deposits = await prisma.cashDeposit.findMany({
    where: {
      undoneAt: null,
      ...(branchId ? { OR: [{ branchId }, { bankAccount: { branchId } }] } : {}),
    },
    include: {
      branch: { select: { name: true } },
      bankAccount: { select: { bankName: true, accountNumber: true, branchId: true, branch: { select: { name: true } } } },
    },
    orderBy: { depositedAt: "desc" },
  })
  let cashToBank = 0
  let depositsIn = 0
  const depositsByBank = new Map<string, number>()
  for (const deposit of deposits) {
    const amount = money(deposit.amount)
    const bankLabel = `${deposit.bankAccount.bankName} ${deposit.bankAccount.accountNumber}`
    const note = deposit.slipNumber ? ` (slip ${deposit.slipNumber})` : ""
    if (!branchId || deposit.branchId === branchId) {
      cashToBank += amount
      cashEntries.push({
        id: `deposit-out-${deposit.id}`,
        date: deposit.depositedAt,
        branch: deposit.branch.name,
        type: "OUT",
        category: "Cash to bank",
        description: `${deposit.depositNumber} paid into ${bankLabel}${note}`,
        amount,
      })
    }
    if (!branchId || deposit.bankAccount.branchId === branchId) {
      depositsIn += amount
      depositsByBank.set(deposit.bankAccountId, (depositsByBank.get(deposit.bankAccountId) ?? 0) + amount)
      bankEntries.push({
        id: `deposit-in-${deposit.id}`,
        date: deposit.depositedAt,
        branch: deposit.bankAccount.branch.name,
        type: "IN",
        category: "Cash from the till",
        description: `${deposit.depositNumber} cash from ${deposit.branch.name} into ${bankLabel}${note}`,
        amount,
      })
    }
  }

  // Refunds on returns paid by bank. They used to come off no balance at all:
  // Money in & out showed the bank higher than it was. Only return refunds
  // (RTN- numbers) are read here; supplier payments by bank are already in
  // supplierPayments and must not come off twice.
  const bankRefunds = await prisma.financeEntry.findMany({
    where: {
      ...where,
      account: "BANK",
      type: "EXPENSE",
      // Return refunds and Swap Deal pay-outs. Supplier payments are left out:
      // they are already in supplierPayments.
      OR: [{ reference: { startsWith: "RTN-" } }, { description: { startsWith: "Swap payable" } }],
    },
    include: { branch: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  })
  let refundsOut = 0
  const refundsByBank = new Map<string, number>()
  for (const entry of bankRefunds) {
    const amount = money(entry.amount)
    refundsOut += amount
    if (entry.bankAccountId) refundsByBank.set(entry.bankAccountId, (refundsByBank.get(entry.bankAccountId) ?? 0) + amount)
    bankEntries.push({
      id: `refund-${entry.id}`,
      date: entry.createdAt,
      branch: entry.branch.name,
      type: "OUT",
      category: entry.description?.startsWith("Swap payable") ? "Swap Deal pay-out" : "Refund on a return",
      description: entry.description || entry.reference || "Refund",
      amount,
    })
  }

  const approvedExpenseRefs = expenses.filter((e) => e.approvedAt).map((e) => e.expenseNumber)
  const otherCashOuts = await prisma.financeEntry.findMany({
    where: {
      ...where,
      account: "CASH",
      type: "EXPENSE",
      ...(approvedExpenseRefs.length
        ? { OR: [{ reference: null }, { reference: { notIn: approvedExpenseRefs } }] }
        : {}),
    },
    include: { branch: true },
    orderBy: { createdAt: "desc" },
  })
  let otherCashOut = 0
  for (const entry of otherCashOuts) {
    // The payment an undo removed is already out of the cash sales above.
    if (isUndoneCollection(entry)) continue
    const amount = money(entry.amount)
    otherCashOut += amount
    cashEntries.push({
      id: entry.id,
      date: entry.createdAt,
      branch: entry.branch.name,
      type: "OUT",
      category: "Cash pay-out",
      description: entry.description || entry.reference || "Cash pay-out",
      amount,
    })
  }

  for (const po of purchases) {
    if (bankToSupplier(po) > 0) {
      bankEntries.push({
        id: po.id,
        date: po.receivedDate || po.createdAt,
        branch: po.branch.name,
        type: "OUT" as const,
        category: "Suppliers payment",
        description: `PO ${po.invoiceNumber} payment to ${po.supplier.name}`,
        amount: bankToSupplier(po),
      })
    }
  }

  const openingCashShops: OpeningCashShop[] = shops.map((shop) => ({
    id: shop.id,
    name: shop.name,
    code: shop.code,
    openingCash: money(shop.openingCash),
    openingCashAt: shop.openingCashAt?.toISOString() ?? null,
  }))
  const namedBanks: NamedBankRow[] = bankAccounts.map((row) => ({
    id: row.id,
    bankName: row.bankName,
    accountNumber: row.accountNumber,
    accountName: row.accountName,
    openingBalance: money(row.openingBalance),
    salesReceived: salesByBank.get(row.id) ?? 0,
    depositsReceived: depositsByBank.get(row.id) ?? 0,
    refundsPaid: refundsByBank.get(row.id) ?? 0,
    branchId: row.branchId,
    branchName: row.branch.name,
    branchCode: row.branch.code,
    createdAt: row.createdAt.toISOString(),
  }))
  const openingCash = openingCashShops.reduce((sum, shop) => sum + shop.openingCash, 0)
  const openingBank = namedBanks.reduce((sum, row) => sum + row.openingBalance, 0)

  for (const shop of openingCashShops) {
    if (shop.openingCash <= 0) continue
    cashEntries.push({
      id: `opening-cash-${shop.id}`,
      date: shop.openingCashAt ? new Date(shop.openingCashAt) : new Date(),
      branch: shop.name,
      type: "IN",
      category: "Opening cash",
      description: `Opening cash at ${shop.name} when this software started`,
      amount: shop.openingCash,
    })
  }
  for (const row of namedBanks) {
    if (row.openingBalance <= 0) continue
    bankEntries.push({
      id: `opening-bank-${row.id}`,
      date: new Date(row.createdAt),
      branch: row.branchName,
      type: "IN",
      category: "Opening bank",
      description: `Opening ${row.bankName} ${row.accountNumber} when this software started`,
      amount: row.openingBalance,
    })
  }

  cashEntries.sort((a, b) => b.date.getTime() - a.date.getTime())
  bankEntries.sort((a, b) => b.date.getTime() - a.date.getTime())

  const cashBalance = openingCash + cashRevenue - expenditure - otherCashOut - cashToBank
  const bankBalance = openingBank + bankRevenue - supplierPaymentsByBank + depositsIn - refundsOut

  const seenHouses = new Set(purchases.map((row) => row.supplierId))
  const ledgers = groupSupplierLedgers([
    ...purchases.map((row) => ({
      supplierId: row.supplierId,
      supplierName: row.supplier.name,
      creditBalance: row.supplier.creditBalance,
      totalAmount: row.totalAmount,
      paidAmount: row.paidAmount,
      returnedAmount: row.returnedAmount,
    })),
    ...creditHouses
      .filter((row) => !seenHouses.has(row.id))
      .map((row) => ({
        supplierId: row.id,
        supplierName: row.name,
        creditBalance: row.creditBalance,
        totalAmount: 0,
        paidAmount: 0,
        returnedAmount: 0,
      })),
  ])
  const creditors = ledgers
    .filter((row) => row.owed > 0)
    .map((row) => ({ id: row.id, name: row.name, owed: row.owed }))
  const supplierCredits = ledgers
    .filter((row) => row.surplus > 0)
    .map((row) => ({ id: row.id, name: row.name, owed: row.surplus }))

  return {
    revenue,
    expenditure,
    supplierPayments,
    netCashFlow,
    cashRevenue,
    bankRevenue,
    openingCash,
    openingBank,
    cashAccount: { balance: cashBalance, entries: withLedger ? cashEntries : [] },
    bankAccount: { balance: bankBalance, entries: withLedger ? bankEntries : [] },
    entries,
    expenses,
    debtors: debtors.map((row) => ({
      id: row.id,
      name: row.name,
      currentBalance: money(row.currentBalance),
      branch: { code: row.branch.code },
    })),
    creditors,
    supplierCredits,
    canSetOpening: canSetOpeningMoney(user.role),
    canRemoveBank: canHardDelete(user.role),
    canDeposit: await can(user.role, "action.deposit"),
    cashToBank,
    shops: openingCashShops,
    bankAccounts: namedBanks,
  }
}

/**
 * The bills list on Shop expenses, with the same door and shop rules as
 * getFinance, without reading every sale ever to work out balances the list
 * never shows.
 */
export async function getExpenses() {
  const user = await requireUser()
  if (!(await can(user.role, "view.finance")) && !(await can(user.role, "view.expenses"))) return []
  const branchId = await viewBranchFilter(user)
  return prisma.expense.findMany({
    where: branchId ? { branchId } : {},
    include: { branch: { select: { name: true, code: true } } },
    orderBy: { date: "desc" },
  })
}

/** The day-by-day lines behind one balance, fetched when its ledger opens. */
export async function getFinanceLedger(account: "CASH" | "BANK") {
  const data = await getFinance({ withLedger: true })
  return account === "CASH" ? data.cashAccount.entries : data.bankAccount.entries
}

/**
 * All transactions into and out of one named bank account, newest first.
 * Used by the per-account drilldown on the bank accounts table so the admin
 * can see every sale, deposit, refund and the running balance without opening
 * the combined bank ledger.
 */
export async function getBankAccountLedger(bankAccountId: string) {
  const user = await requireUser()
  if (!(await can(user.role, "view.finance")) && !(await can(user.role, "view.expenses"))) return []

  const account = await prisma.bankAccount.findUnique({
    where: { id: bankAccountId },
    include: { branch: { select: { name: true, code: true } } },
  })
  if (!account) return []
  if (!(await canReachBranch(user, account.branchId))) return []

  type Entry = {
    id: string
    date: Date
    type: "IN" | "OUT"
    category: string
    description: string
    amount: number
    reference: string | null
  }

  const entries: Entry[] = []

  // Opening balance
  if (money(account.openingBalance) > 0) {
    entries.push({
      id: `opening-${account.id}`,
      date: account.createdAt,
      type: "IN",
      category: "Opening balance",
      description: `${account.bankName} ${account.accountNumber} when this software started`,
      amount: money(account.openingBalance),
      reference: null,
    })
  }

  // Bank sales: all Payment rows for this account
  const payments = await prisma.payment.findMany({
    where: { bankAccountId, method: { not: "CASH" } },
    include: {
      sale: {
        select: {
          invoiceNumber: true,
          saleDate: true,
          customer: { select: { name: true } },
        },
      },
    },
    orderBy: { paidAt: "desc" },
  })
  for (const payment of payments) {
    entries.push({
      id: `payment-${payment.id}`,
      date: payment.sale.saleDate,
      type: "IN",
      category: "Sale received",
      description: `${payment.sale.invoiceNumber} · ${payment.sale.customer?.name ?? "Walk-in"}`,
      amount: money(payment.amount),
      reference: payment.reference,
    })
  }

  // Cash deposits into this account
  const deposits = await prisma.cashDeposit.findMany({
    where: { bankAccountId, undoneAt: null },
    include: { branch: { select: { name: true } } },
    orderBy: { depositedAt: "desc" },
  })
  for (const deposit of deposits) {
    entries.push({
      id: `deposit-${deposit.id}`,
      date: deposit.depositedAt,
      type: "IN",
      category: "Cash from the till",
      description: `${deposit.depositNumber} · cash from ${deposit.branch.name}${deposit.slipNumber ? ` · slip ${deposit.slipNumber}` : ""}`,
      amount: money(deposit.amount),
      reference: deposit.slipNumber,
    })
  }

  // Refunds and swap pay-outs out of this account
  const outflows = await prisma.financeEntry.findMany({
    where: {
      bankAccountId,
      account: "BANK",
      type: "EXPENSE",
      OR: [{ reference: { startsWith: "RTN-" } }, { description: { startsWith: "Swap payable" } }],
    },
    include: { branch: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  })
  for (const entry of outflows) {
    entries.push({
      id: `out-${entry.id}`,
      date: entry.createdAt,
      type: "OUT",
      category: entry.description?.startsWith("Swap payable") ? "Swap Deal pay-out" : "Refund on a return",
      description: entry.description || entry.reference || "Payment out",
      amount: money(entry.amount),
      reference: entry.reference,
    })
  }

  // Sort newest first
  entries.sort((a, b) => b.date.getTime() - a.date.getTime())

  // Build running balance (running backwards: newest first, so we compute from
  // the known current total downward)
  const totalIn = entries.filter((e) => e.type === "IN").reduce((s, e) => s + e.amount, 0)
  const totalOut = entries.filter((e) => e.type === "OUT").reduce((s, e) => s + e.amount, 0)
  const currentBalance = totalIn - totalOut

  let running = currentBalance
  return entries.map((entry) => {
    const balance = running
    if (entry.type === "IN") running -= entry.amount
    else running += entry.amount
    return { ...entry, date: entry.date.toISOString(), runningBalance: balance }
  })
}

async function assertOpeningMoneyAccess(user: { id: string; role: UserRole; branchId: string | null }, branchId: string) {
  if (!canSetOpeningMoney(user.role)) {
    return { error: "Only the main admin, the CEO, the accountant, or the records checker can set opening money." }
  }
  if (!(await canReachBranch(user, branchId))) return { error: OTHER_SHOP }
  const shop = await prisma.branch.findFirst({ where: { id: branchId, isActive: true }, select: { id: true, name: true } })
  if (!shop) return { error: "Pick a shop that is open." }
  return { shop }
}

export async function saveOpeningCash(formData: FormData) {
  const user = await requireUser()
  const branchId = String(formData.get("branchId") || "")
  const amount = Number(formData.get("amount") ?? "")
  if (!branchId) return { error: "Pick the shop." }
  if (!Number.isFinite(amount) || amount < 0) return { error: "Type the cash in the till as a number, zero or more." }
  const gate = await assertOpeningMoneyAccess(user, branchId)
  if ("error" in gate) return gate

  const before = await prisma.branch.findUnique({ where: { id: branchId }, select: { openingCash: true } })
  await prisma.branch.update({
    where: { id: branchId },
    data: {
      openingCash: amount.toFixed(2),
      openingCashAt: new Date(),
      openingCashBy: user.id,
    },
  })
  await writeAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OpeningCash",
    entityId: gate.shop.name,
    oldValue: JSON.stringify({ openingCash: money(before?.openingCash) }),
    newValue: JSON.stringify({ openingCash: amount }),
    branchId,
  })
  revalidateMoneyViews()
  return { success: true }
}

export async function createBankAccount(formData: FormData) {
  const user = await requireUser()
  const branchId = String(formData.get("branchId") || "")
  const bankName = displayBankName(String(formData.get("bankName") || ""))
  const accountNumber = displayAccountNumber(String(formData.get("accountNumber") || ""))
  const accountName = displayBankName(String(formData.get("accountName") || "")) || null
  const openingBalance = Number(formData.get("openingBalance") ?? "")
  if (!branchId) return { error: "Pick the shop this bank belongs to." }
  if (!bankName) return { error: "Type the bank name." }
  if (accountNumber.length < 8) return { error: "Type the full account number." }
  if (!Number.isFinite(openingBalance) || openingBalance < 0) {
    return { error: "Type the opening bank balance as a number, zero or more." }
  }
  const gate = await assertOpeningMoneyAccess(user, branchId)
  if ("error" in gate) return gate

  const existing = await prisma.bankAccount.findMany({
    where: { isActive: true },
    select: { id: true, accountNumber: true },
  })
  const clash = listedBankClash(existing, accountNumber)
  if (clash) return { error: clash }

  const row = await prisma.bankAccount.create({
    data: {
      branchId,
      bankName,
      accountNumber,
      accountName,
      openingBalance: openingBalance.toFixed(2),
      createdById: user.id,
    },
  })
  await writeAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "BankAccount",
    entityId: `${bankName} ${accountNumber}`,
    newValue: JSON.stringify({ bankName, accountNumber, openingBalance, shop: gate.shop.name }),
    branchId,
  })
  revalidateMoneyViews()
  return { success: true, id: row.id }
}

export async function saveBankOpening(formData: FormData) {
  const user = await requireUser()
  const id = String(formData.get("id") || "")
  const openingBalance = Number(formData.get("openingBalance") ?? "")
  if (!id) return { error: "We could not find that bank account." }
  if (!Number.isFinite(openingBalance) || openingBalance < 0) {
    return { error: "Type the opening bank balance as a number, zero or more." }
  }
  const row = await prisma.bankAccount.findUnique({ where: { id } })
  if (!row || !row.isActive) return { error: "We could not find that bank account." }
  const gate = await assertOpeningMoneyAccess(user, row.branchId)
  if ("error" in gate) return gate

  await prisma.bankAccount.update({
    where: { id },
    data: { openingBalance: openingBalance.toFixed(2) },
  })
  await writeAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "BankAccount",
    entityId: `${row.bankName} ${row.accountNumber}`,
    oldValue: JSON.stringify({ openingBalance: money(row.openingBalance) }),
    newValue: JSON.stringify({ openingBalance }),
    branchId: row.branchId,
  })
  revalidateMoneyViews()
  return { success: true }
}

export async function takeBankOffTheBooks(formData: FormData) {
  const user = await requireUser()
  if (!canHardDelete(user.role)) {
    return { error: "Only the CEO or the main admin can take a bank account off the books." }
  }
  const id = String(formData.get("id") || "")
  if (!id) return { error: "We could not find that bank account." }
  const row = await prisma.bankAccount.findUnique({ where: { id } })
  if (!row || !row.isActive) return { error: "We could not find that bank account." }
  const gate = await assertOpeningMoneyAccess(user, row.branchId)
  if ("error" in gate) return gate

  await prisma.bankAccount.update({ where: { id }, data: { isActive: false } })
  await writeAudit({
    userId: user.id,
    // A removal from the books, recorded as one so the CEO sees it.
    action: "DELETE",
    entityType: "BankAccount",
    entityId: `${row.bankName} ${row.accountNumber}`,
    oldValue: JSON.stringify({ isActive: true }),
    newValue: JSON.stringify({ isActive: false }),
    branchId: row.branchId,
  })
  revalidateMoneyViews()
  return { success: true }
}

export async function createExpense(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageFinance(user.role))) {
    return { error: "You are not allowed to record an expense. Ask the main admin." }
  }
  const amount = Number(formData.get("amount") || 0)
  const shopGate = await resolveWritableShopId(user, String(formData.get("branchId") || user.branchId || ""))
  if ("error" in shopGate) return { error: shopGate.error }
  const branchId = shopGate.shopId
  if (amount <= 0) return { error: "Type the amount and pick the shop." }

  const cashGate = await assertCashAvailable(branchId, amount)
  if (!cashGate.ok) return { error: cashGate.error }

  const expense = await prisma.expense.create({
    data: {
      expenseNumber: generateDocNumber("EXP"),
      branchId,
      userId: user.id,
      category: String(formData.get("category")) as ExpenseCategory,
      amount: amount.toFixed(2),
      description: String(formData.get("description") || "Expense"),
      notes: String(formData.get("notes") || "") || null,
    },
  })
  await prisma.approval.create({
    data: {
      type: "EXPENSE",
      entityId: expense.expenseNumber,
      entityType: "Expense",
      requestedBy: user.id,
      reason: expense.description,
    },
  })
  revalidatePath("/expenses")
  revalidatePath("/finance")
  revalidatePath("/approvals")
  return { success: true }
}

/**
 * The shop each approval belongs to, read from the record it is about. An
 * approval row itself carries no shop, so a shop manager used to see, and could
 * decide, every shop's expenses, returns, swaps, counts and deliveries.
 */
async function approvalShops(rows: Array<{ id: string; entityType: string; entityId: string }>) {
  const ids = (type: string) => rows.filter((row) => row.entityType === type).map((row) => row.entityId)
  const [expenses, returns, swaps, counts, lots] = await Promise.all([
    prisma.expense.findMany({ where: { expenseNumber: { in: ids("Expense") } }, select: { expenseNumber: true, branchId: true } }),
    prisma.stockReturn.findMany({ where: { id: { in: ids("Return") } }, select: { id: true, branchId: true } }),
    prisma.swap.findMany({ where: { id: { in: ids("Swap") } }, select: { id: true, branchId: true } }),
    prisma.reconciliation.findMany({ where: { id: { in: ids("Reconciliation") } }, select: { id: true, branchId: true } }),
    prisma.incomingLot.findMany({ where: { lotNumber: { in: ids("IncomingLot") } }, select: { lotNumber: true, branchId: true } }),
  ])
  const byKey = new Map<string, string>([
    ...expenses.map((row) => [`Expense:${row.expenseNumber}`, row.branchId] as const),
    ...returns.map((row) => [`Return:${row.id}`, row.branchId] as const),
    ...swaps.map((row) => [`Swap:${row.id}`, row.branchId] as const),
    ...counts.map((row) => [`Reconciliation:${row.id}`, row.branchId] as const),
    ...lots.map((row) => [`IncomingLot:${row.lotNumber}`, row.branchId] as const),
  ])
  return new Map(rows.map((row) => [row.id, byKey.get(`${row.entityType}:${row.entityId}`) ?? null]))
}

export async function getApprovals() {
  const user = await requireUser()
  if (!(await can(user.role, "view.approvals"))) return []
  const rows = await prisma.approval.findMany({
    include: { requester: { select: { id: true, name: true, email: true, role: true, branchId: true } }, decider: { select: { id: true, name: true, email: true, role: true, branchId: true } } },
    orderBy: { requestedAt: "desc" },
  })
  if (await canSeeAllBranches(user.role)) return rows
  // Everyone else sees their own shop's approvals only.
  const shops = await approvalShops(rows)
  return rows.filter((row) => {
    const shop = shops.get(row.id)
    return shop == null || shop === user.branchId
  })
}

export async function decideApproval(id: string, status: "APPROVED" | "REJECTED") {
  const user = await requireUser()
  if (!(await canApprove(user.role))) {
    return { error: "You are not allowed to say yes or no to this. Ask your manager." }
  }
  const approval = await prisma.approval.findUnique({ where: { id } })
  if (!approval || approval.status !== "PENDING") return { error: "Somebody has already decided on this one." }
  // Only for a shop this person can reach (a shop manager: their own shop).
  const approvalShop = (await approvalShops([approval])).get(approval.id) ?? null
  if (!(await canReachBranch(user, approvalShop))) return { error: OTHER_SHOP }

  if (approval.type === "INCOMING_RECEIVE" && approval.requestedBy === user.id) {
    return { error: "Someone else must say yes. You already checked this carton." }
  }

  if (approval.type === "INCOMING_RECEIVE" || approval.entityType === "IncomingLot") {
    const { completeIncomingReceiveApproval, rejectIncomingReceiveApproval } = await import("@/app/actions/incoming")
    const result =
      status === "APPROVED"
        ? await completeIncomingReceiveApproval(approval.entityId, user.id)
        : await rejectIncomingReceiveApproval(approval.entityId, user.id)
    if (result && "error" in result && result.error) return result
  }

  if (approval.entityType === "Swap" || approval.type === "SWAP") {
    const swap = await prisma.swap.findFirst({
      where: { OR: [{ id: approval.entityId }, { swapNumber: approval.entityId }] },
    })
    if (swap) {
      const { applySwapApprovalDecision } = await import("@/app/actions/ops")
      const result = await applySwapApprovalDecision(swap.id, status, user.id)
      if (result && "error" in result && result.error) return result
    }
  }

  // Cash expenses: check the till before marking yes, so a short till cannot be approved.
  if ((approval.entityType === "Expense" || approval.type === "EXPENSE") && status === "APPROVED") {
    const expense = await prisma.expense.findFirst({
      where: { OR: [{ id: approval.entityId }, { expenseNumber: approval.entityId }] },
    })
    if (expense && !expense.approvedAt) {
      const cashGate = await assertCashAvailable(expense.branchId, money(expense.amount), {
        ignoreExpenseId: expense.id,
      })
      if (!cashGate.ok) return { error: cashGate.error }
    }
  }

  await prisma.approval.update({
    where: { id },
    data: { status, approvedBy: user.id, approvedAt: new Date() },
  })

  if (approval.entityType === "Return" || approval.type === "RETURN") {
    const record = await prisma.stockReturn.findFirst({
      where: { OR: [{ id: approval.entityId }, { returnNumber: approval.entityId }] },
    })
    if (record) {
      await prisma.stockReturn.update({
        where: { id: record.id },
        data: { status: status === "APPROVED" ? "APPROVED" : "REJECTED", approvedBy: user.id, approvedAt: new Date() },
      })
      if (status === "REJECTED" && record.imeiId) {
        await prisma.imeiRecord.update({
          where: { id: record.imeiId },
          data: { status: "SOLD" },
        })
      }
    }
  }

  if (approval.entityType === "Expense" || approval.type === "EXPENSE") {
    const expense = await prisma.expense.findFirst({
      where: { OR: [{ id: approval.entityId }, { expenseNumber: approval.entityId }] },
    })
    if (expense && status === "APPROVED") {
      await prisma.expense.update({
        where: { id: expense.id },
        data: { approvedBy: user.id, approvedAt: new Date() },
      })
      const alreadyPosted = await prisma.financeEntry.findFirst({
        where: { reference: expense.expenseNumber },
      })
      if (!alreadyPosted) {
        await prisma.financeEntry.create({
          data: {
            branchId: expense.branchId,
            account: "CASH",
            type: "EXPENSE",
            amount: expense.amount,
            reference: expense.expenseNumber,
            description: expense.description,
          },
        })
      }
    }
  }

  if (approval.type === "RECONCILIATION") {
    const recon = await prisma.reconciliation.findFirst({
      where: { OR: [{ id: approval.entityId }] },
      include: { items: true },
    })
    if (recon) {
      if (status === "APPROVED") {
        for (const item of recon.items) {
          // A count says what the shelf is, so the ledger line is the difference
          // against the shelf as it stands now, not the variance worked out on
          // the day of the count — the shelf may have moved since.
          await setStock(prisma, {
            productId: item.productId,
            branchId: recon.branchId,
            quantity: item.countedQty,
            lastStockCheck: true,
            move: {
              kind: "COUNT_ADJUST",
              reference: `Stock count ${recon.id.slice(-6)}`,
              userId: user.id,
            },
          })
        }
      }
      await prisma.reconciliation.update({
        where: { id: recon.id },
        data: {
          status: status === "APPROVED" ? "APPROVED" : "REJECTED",
          approvedBy: user.id,
          approvedAt: new Date(),
          completedAt: new Date(),
        },
      })
    }
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: status === "APPROVED" ? "APPROVE" : "REJECT",
      entityType: approval.entityType,
      entityId: approval.entityId,
      newValue: status,
      branchId: user.branchId,
    },
  })
  await prisma.notification.create({
    data: {
      userId: approval.requestedBy,
      type: "SYSTEM",
      title: `${approval.type} ${status.toLowerCase()}`,
      message: approval.reason || approval.entityId,
      actionUrl: "/approvals",
    },
  })
  revalidatePath("/approvals")
  revalidatePath("/swaps")
  revalidatePath("/returns")
  revalidatePath("/expenses")
  revalidatePath("/reconciliation")
  revalidatePath("/inventory")
  revalidatePath("/finance")
  revalidatePath("/imei")
  revalidatePath("/incoming")
  revalidatePath("/purchases")
  revalidatePath("/dashboard")
  return { success: true }
}

export async function approveRequest(formData: FormData) {
  return decideApproval(String(formData.get("id") || ""), "APPROVED")
}

export async function rejectRequest(formData: FormData) {
  return decideApproval(String(formData.get("id") || ""), "REJECTED")
}

export async function getReconciliations() {
  const user = await requireUser()
  if (!(await can(user.role, "view.reconciliation"))) return []
  const branchId = await viewBranchFilter(user)
  return prisma.reconciliation.findMany({
    where: branchId ? { branchId } : undefined,
    include: { branch: true, user: { select: { id: true, name: true, email: true, role: true, branchId: true } }, items: { include: { product: true } } },
    orderBy: { createdAt: "desc" },
  })
}

export async function startReconciliation(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.recon"))) return { error: "You are not allowed to send a stock count. Ask the main admin." }
  const branchId = String(formData.get("branchId") || user.branchId || "")
  if (!branchId) return { error: "Pick a shop." }
  const scoped = await scopedBranchId(user.role, user.branchId)
  if (scoped && branchId !== scoped) return { error: "You can only count your own branch." }
  const stock = await prisma.inventory.findMany({
    where: { branchId },
    include: { product: true },
  })
  const expected = stock.reduce((sum, row) => sum + row.quantity * money(row.product.costPrice), 0)
  const counted = stock.reduce((sum, row) => {
    const countedQty = Number(formData.get(`count_${row.productId}`) || row.quantity)
    return sum + countedQty * money(row.product.costPrice)
  }, 0)

  const recon = await prisma.reconciliation.create({
    data: {
      branchId,
      userId: user.id,
      startDate: new Date(),
      endDate: new Date(),
      status: "PENDING_APPROVAL",
      totalExpected: expected.toFixed(2),
      totalCounted: counted.toFixed(2),
      variance: (counted - expected).toFixed(2),
      notes: String(formData.get("notes") || "") || null,
      items: {
        create: stock.map((row) => {
          const countedQty = Number(formData.get(`count_${row.productId}`) || row.quantity)
          return {
            productId: row.productId,
            expectedQty: row.quantity,
            countedQty,
            variance: countedQty - row.quantity,
            varianceValue: ((countedQty - row.quantity) * money(row.product.costPrice)).toFixed(2),
          }
        }),
      },
    },
  })
  await prisma.approval.create({
    data: {
      type: "RECONCILIATION",
      entityId: recon.id,
      entityType: "Reconciliation",
      requestedBy: user.id,
      reason: `Stock count variance ${recon.variance}`,
    },
  })
  revalidatePath("/reconciliation")
  revalidatePath("/approvals")
  return { success: true }
}

export async function getAuditLogs() {
  const user = await requireUser()
  if (!(await can(user.role, "view.audit"))) return []
  return prisma.auditLog.findMany({
    include: { user: { select: { id: true, name: true, email: true, role: true, branchId: true } } },
    orderBy: { createdAt: "desc" },
    take: 150,
  })
}

export async function getNotifications() {
  const user = await requireUser()
  return prisma.notification.findMany({
    where: { userId: user.id, status: { not: "ARCHIVED" } },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
}

export async function markNotificationsRead() {
  const user = await requireUser()
  await prisma.notification.updateMany({
    where: { userId: user.id, status: "UNREAD" },
    data: { status: "READ", readAt: new Date() },
  })
  revalidatePath("/notifications")
  return { success: true }
}

export async function getStaff() {
  const user = await requireUser()
  if (!(await can(user.role, "view.staff"))) return []
  // A shop manager runs their own shop's people. Head office sees everyone,
  // including the head office roles that are not tied to any shop.
  const scope = await branchFilter(user)
  return prisma.user.findMany({
    where: scope ? { branchId: scope } : undefined,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      branchId: true,
      isActive: true,
      mustChangePassword: true,
      lastLoginAt: true,
      createdAt: true,
      branch: { select: { id: true, name: true, code: true } },
    },
    orderBy: { createdAt: "asc" },
  })
}

export async function createStaff(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageStaff(user.role))) return { error: "You are not allowed to add staff. Ask the main admin." }

  const name = String(formData.get("name") || "").trim()
  const email = String(formData.get("email") || "").trim().toLowerCase()
  const password = String(formData.get("password") || "")
  const role = String(formData.get("role") || "SALES_EXECUTIVE") as UserRole
  const branchId = String(formData.get("branchId") || "") || null

  if (role === "SUPER_ADMIN" && !isSuperAdmin(user.role)) {
    return { error: "Only the main admin can create another main admin." }
  }
  if (!name || !email || password.length < 8) {
    return { error: "Type the name, the email, and a password of at least 8 letters or numbers." }
  }
  const exists = await prisma.user.findUnique({ where: { email } })
  if (exists) return { error: "Somebody on staff already uses that email." }

  // A shop manager may only add people to their own shop. The shop came from
  // the form, so without this a manager could attach a login to another shop.
  const allowedBranch = await branchFilter(user, branchId)
  if (branchId && allowedBranch && branchId !== allowedBranch) {
    return { error: "You can only add staff to your own shop." }
  }

  await prisma.user.create({
    data: {
      name,
      email,
      password: await bcrypt.hash(password, 10),
      role,
      branchId: ["SUPER_ADMIN", "CEO", "AUDITOR", "ACCOUNTANT"].includes(role) ? null : branchId,
      isActive: true,
      mustChangePassword: true,
    },
  })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "CREATE",
      entityType: "User",
      entityId: email,
      newValue: JSON.stringify({ name, role, branchId }),
      branchId: user.branchId,
    },
  })
  revalidatePath("/staff")
  revalidatePath("/audit")
  return { success: true }
}

const HEAD_OFFICE_ROLES: UserRole[] = ["SUPER_ADMIN", "CEO", "AUDITOR", "ACCOUNTANT"]

/**
 * Give a staff member a new temporary password when they cannot sign in: a
 * forgotten password, or a login handed over wrongly. They must choose their
 * own at the next sign-in. Same rules as editing staff: the main admin and the
 * CEO reset anyone below the main admin, a shop manager only their own shop,
 * and only the main admin resets another main admin. Always in Who did what.
 */
export async function resetStaffPassword(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageStaff(user.role))) return { error: "You are not allowed to reset staff passwords. Ask the main admin." }
  const id = String(formData.get("id") || "")
  const password = String(formData.get("newPassword") || "").trim()
  if (password.length < 8) return { error: "The temporary password must be at least 8 letters or numbers." }

  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) return { error: "We could not find that staff." }
  if (target.id === user.id) return { error: "Change your own password on Your login." }
  // The main admin runs the system under the CEO's watch, so the CEO's own
  // login stays the CEO's: nobody else resets it, edits it, or locks it.
  if (target.role === "CEO" && user.role !== "CEO") {
    return { error: "Only the CEO can change the CEO's password." }
  }
  if (target.role === "SUPER_ADMIN" && !isSuperAdmin(user.role)) {
    return { error: "Only the main admin can reset another main admin's password." }
  }
  const managerScope = await branchFilter(user)
  if (managerScope && target.branchId !== managerScope) {
    return { error: "You can only reset passwords for staff in your own shop." }
  }

  await prisma.user.update({
    where: { id: target.id },
    // The person's open sessions end: a reset after a lost or stolen password
    // must not leave the old session working.
    data: { password: await bcrypt.hash(password, 10), mustChangePassword: true, sessionsValidAfter: new Date() },
  })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "User",
      entityId: target.email,
      newValue: JSON.stringify({ note: `Password reset for ${target.name ?? target.email}. They must choose a new one at sign-in.` }),
      branchId: target.branchId,
      risk: "HIGH",
    },
  })
  await prisma.notification.create({
    data: {
      userId: target.id,
      type: "SYSTEM",
      title: "Your password was reset",
      message: `${user.name ?? "The main admin"} set a temporary password for you. Choose your own now on Your login.`,
      actionUrl: "/account",
    },
  })
  revalidatePath("/staff")
  return { success: true, message: `Temporary password set for ${target.name ?? target.email}. Tell them it in person.` }
}

export async function updateStaff(formData: FormData) {
  const user = await requireUser()
  if (!(await canManageStaff(user.role))) return { error: "You are not allowed to edit staff. Ask the main admin." }

  const id = String(formData.get("id") || "")
  const name = String(formData.get("name") || "").trim()
  const role = String(formData.get("role") || "") as UserRole
  const branchRaw = String(formData.get("branchId") || "")
  const branchId = branchRaw || null

  if (!id) return { error: "We could not find that staff." }
  if (!name) return { error: "Type the person's name." }
  if (!Object.values(UserRole).includes(role)) return { error: "Pick a valid job." }

  const target = await prisma.user.findUnique({ where: { id } })
  if (!target) return { error: "We could not find that staff." }

  if (role === "SUPER_ADMIN" && !isSuperAdmin(user.role)) {
    return { error: "Only the main admin can make someone a main admin." }
  }
  if ((target.role === "CEO" || role === "CEO") && user.role !== "CEO") {
    return { error: "Only the CEO can edit the CEO's login or make someone CEO." }
  }
  if (target.role === "SUPER_ADMIN" && !isSuperAdmin(user.role)) {
    return { error: "Only the main admin can edit another main admin." }
  }
  if (target.id === user.id && role !== target.role) {
    return { error: "You cannot change your own job. Ask another main admin." }
  }

  // Shop managers may edit people in their shop only, and may not move them away.
  const managerScope = await branchFilter(user)
  if (managerScope) {
    if (target.branchId !== managerScope) {
      return { error: "You can only edit staff in your own shop." }
    }
    if (branchId && branchId !== managerScope) {
      return { error: "You can only keep staff in your own shop. Ask the main admin to move them." }
    }
    if (HEAD_OFFICE_ROLES.includes(role)) {
      return { error: "Only the main admin can give head-office jobs." }
    }
  }

  const nextBranchId = HEAD_OFFICE_ROLES.includes(role) ? null : branchId
  if (!HEAD_OFFICE_ROLES.includes(role) && !nextBranchId) {
    return { error: "Pick the shop this person works in." }
  }
  if (nextBranchId) {
    const shop = await prisma.branch.findUnique({ where: { id: nextBranchId } })
    if (!shop) return { error: "We could not find that shop." }
    if (!shop.isActive) return { error: "That shop is closed. Open it again before you put staff there." }
  }

  await prisma.user.update({
    where: { id },
    data: { name, role, branchId: nextBranchId },
  })
  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "User",
      entityId: target.email,
      oldValue: JSON.stringify({ name: target.name, role: target.role, branchId: target.branchId }),
      newValue: JSON.stringify({ name, role, branchId: nextBranchId }),
      branchId: nextBranchId ?? user.branchId,
    },
  })
  revalidatePath("/staff")
  revalidatePath("/audit")
  return { success: true }
}

export async function getSettings() {
  await requireUser()
  await prisma.setting.upsert({
    where: { key: "sales.warranty_days" },
    update: {},
    create: {
      key: "sales.warranty_days",
      value: "0",
      description: "Warranty days start at zero. The cashier sets the days on the sale.",
    },
  })
  await prisma.setting.updateMany({
    where: { key: "sales.warranty_days", value: "365" },
    data: {
      value: "0",
      description: "Warranty days start at zero. The cashier sets the days on the sale.",
    },
  })
  await prisma.setting.upsert({
    where: { key: "incoming.dual_control" },
    update: {},
    create: {
      key: "incoming.dual_control",
      value: "true",
      description: "Second person must say yes before received goods become sellable",
    },
  })
  // Older installs stopped the till whenever a day was left uncounted, with no
  // way to change it. The row is created switched off, so the shop keeps selling
  // and is reminded instead, and the CEO can put the hard stop back.
  await prisma.setting.upsert({
    where: { key: "sales.block_until_day_closed" },
    update: {},
    create: {
      key: "sales.block_until_day_closed",
      value: "false",
      description: "An uncounted day reminds the shop but does not stop the till",
    },
  })
  await prisma.setting.upsert({
    where: { key: "company.logo" },
    update: {},
    create: {
      key: "company.logo",
      value: "",
      description: "Logo printed on invoices",
    },
  })
  await prisma.setting.upsert({
    where: { key: "company.footer" },
    update: {},
    create: {
      key: "company.footer",
      value: "Thank you for buying from Abu Twins",
      description: "Thank-you line at the bottom of invoices",
    },
  })
  return prisma.setting.findMany({ orderBy: { key: "asc" } })
}

export async function saveSetting(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "action.settings"))) return { error: "Only the main admin or the CEO can change settings." }
  const key = String(formData.get("key"))
  const value = String(formData.get("value"))
  if (isLetterheadKey(key)) {
    return { error: "Change the invoice header on Shop details, not here." }
  }
  await prisma.setting.update({ where: { key }, data: { value } })
  revalidatePath("/settings")
  revalidatePath("/settings/rules")
  revalidatePath("/pos")
  revalidatePath("/inventory")
  revalidatePath("/sales")
  revalidatePath("/incoming")
  return { success: true }
}

const LETTERHEAD_FIELDS = [
  { key: "company.name", description: "Legal trading name printed on invoices" },
  { key: "company.product", description: "Line under the name on invoices" },
  { key: "company.phone", description: "Phone on invoices" },
  { key: "company.address", description: "Address on invoices" },
  { key: "company.email", description: "Email on invoices" },
  { key: "company.logo", description: "Logo printed on invoices" },
  { key: "company.footer", description: "Thank-you line at the bottom of invoices" },
] as const

function validLogo(value: string) {
  if (!value) return true
  if (!value.startsWith("data:image/")) return false
  if (value.length > 220_000) return false
  return /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value)
}

/**
 * Name, logo, address and thank-you line on every printed paper.
 *
 * Main admin, CEO, accountant and auditor may change this. Selling rules stay
 * with the main admin.
 */
export async function saveLetterhead(formData: FormData) {
  const user = await requireUser()
  if (!(await can(user.role, "view.settings"))) {
    return { error: "You cannot open shop settings." }
  }
  if (!canEditLetterhead(user.role)) {
    return { error: "Only the main admin, the CEO, the accountant or the auditor can change the invoice header." }
  }

  const next: Array<{ key: string; value: string; description: string }> = [
    { key: "company.name", value: String(formData.get("name") || "").trim(), description: LETTERHEAD_FIELDS[0].description },
    { key: "company.product", value: String(formData.get("tagline") || "").trim(), description: LETTERHEAD_FIELDS[1].description },
    { key: "company.phone", value: String(formData.get("phone") || "").trim(), description: LETTERHEAD_FIELDS[2].description },
    { key: "company.address", value: String(formData.get("address") || "").trim(), description: LETTERHEAD_FIELDS[3].description },
    { key: "company.email", value: String(formData.get("email") || "").trim(), description: LETTERHEAD_FIELDS[4].description },
    { key: "company.footer", value: String(formData.get("footer") || "").trim(), description: LETTERHEAD_FIELDS[6].description },
  ]
  if (!next[0].value) return { error: "Type the company name that should print on invoices." }
  if (!next[3].value) return { error: "Type the address that should print on invoices." }

  const logo = String(formData.get("logo") || "")
  const clearLogo = String(formData.get("clearLogo") || "") === "1"
  if (clearLogo) {
    next.push({ key: "company.logo", value: "", description: LETTERHEAD_FIELDS[5].description })
  } else if (logo) {
    if (!validLogo(logo)) return { error: "Use a JPEG, PNG or WebP logo under 150 KB." }
    next.push({ key: "company.logo", value: logo, description: LETTERHEAD_FIELDS[5].description })
  }

  for (const row of next) {
    await prisma.setting.upsert({
      where: { key: row.key },
      update: { value: row.value, description: row.description },
      create: row,
    })
  }

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "UPDATE",
      entityType: "Setting",
      entityId: "company.letterhead",
      newValue: JSON.stringify({
        name: next[0].value,
        tagline: next[1].value,
        phone: next[2].value,
        address: next[3].value,
        email: next[4].value,
        footer: next[5].value,
        logo: clearLogo ? "default" : logo ? "updated" : "unchanged",
      }),
      branchId: user.branchId,
    },
  })

  revalidatePath("/settings")
  revalidatePath("/sales")
  revalidatePath("/reports")
  revalidatePath("/audit/books")
  revalidatePath("/help")
  revalidatePath("/pos")
  return { success: true }
}

export async function getReportData(
  requestedBranchId?: string,
  range: ShopRange = "month",
  businessDate?: string
) {
  const user = await requireUser()
  if (!(await can(user.role, "view.reports"))) {
    const empty = shopPeriodWindow(watDayKey(), "month")
    const emptyPrior = shopPreviousWindow(empty.from, "month")
    return {
      sales: [],
      expenses: [],
      swaps: [],
      returns: [],
      loggedReturns: 0,
      salesReturns: 0,
      receipts: { total: 0, onPeriodSales: 0, debtsCollected: 0, cash: 0, transfer: 0, pos: 0, bank: 0 },
      waiting: { swaps: 0, swapBalance: 0, returns: 0, returnValue: 0, periodDue: 0 },
      inventory: [],
      debtors: [],
      creditors: [],
      supplierCredits: [],
      period: empty,
      prior: { from: emptyPrior.from, to: emptyPrior.to, revenue: 0, collected: 0, expenses: 0 },
    }
  }
  const scoped = await scopedBranchId(user.role, user.branchId, requestedBranchId)
  const branchId = scoped || requestedBranchId || (await viewBranchFilter(user))
  const day = businessDate && /^\d{4}-\d{2}-\d{2}$/.test(businessDate) ? businessDate : watDayKey()
  const span: ShopRange = range === "week" || range === "day" ? range : "month"
  const period = shopPeriodWindow(day, span)
  const prior = shopPreviousWindow(period.from, span)
  const shopWhere = branchId ? { branchId } : {}
  await healOpeningStockBills()
  const [sales, expenses, swaps, returns, inventory, debtors, purchases, priorSales, priorExpenses, creditHouses] = await Promise.all([
    prisma.sale.findMany({
      where: { status: "COMPLETED", ...shopWhere, saleDate: { gte: period.start, lt: period.end } },
      include: { branch: true, items: true, customer: true, payments: true },
    }),
    prisma.expense.findMany({
      where: { ...shopWhere, approvedAt: { not: null }, date: { gte: period.start, lt: period.end } },
      include: { branch: true },
    }),
    // The list: swaps finished in the period (dated by when they finished, when
    // their invoice and money are written, so each lands in one period), plus
    // every swap still waiting, marked as such. Totals use the finished ones.
    prisma.swap.findMany({
      where: {
        ...shopWhere,
        OR: [
          { status: "COMPLETED", completedAt: { gte: period.start, lt: period.end } },
          { status: { in: ["PENDING", "APPROVED"] } },
        ],
      },
      include: { branch: true, customer: true, newProduct: true },
      orderBy: { createdAt: "desc" },
    }),
    // The list: returns logged or finished in the period, so the items behind
    // Sales returns appear even when they were logged earlier. Declined ones out.
    prisma.stockReturn.findMany({
      where: {
        ...shopWhere,
        status: { not: "REJECTED" },
        OR: [
          { createdAt: { gte: period.start, lt: period.end } },
          { completedAt: { gte: period.start, lt: period.end } },
        ],
      },
      include: { branch: true, customer: true, imei: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.inventory.findMany({
      where: branchId ? { branchId } : undefined,
      include: { product: true, branch: true },
    }),
    prisma.customer.findMany({
      where: { currentBalance: { gt: 0 }, ...(branchId ? { branchId } : {}) },
      include: { branch: true },
      orderBy: { currentBalance: "desc" },
    }),
    prisma.purchase.findMany({
      where: {
        ...shopWhere,
        ...payablePurchaseWhere,
      },
      include: { supplier: true, branch: true },
    }),
    prisma.sale.findMany({
      where: { status: "COMPLETED", ...shopWhere, saleDate: { gte: prior.start, lt: prior.end } },
      select: { totalAmount: true, paidAmount: true, paymentMethod: true, payments: { select: { method: true, amount: true } } },
    }),
    prisma.expense.findMany({
      where: { ...shopWhere, approvedAt: { not: null }, date: { gte: prior.start, lt: prior.end } },
      select: { amount: true },
    }),
    prisma.supplier.findMany({
      // Opening stock names are never a real house: no credit from them either.
      where: { creditBalance: { gt: 0 }, NOT: openingStockSupplierWhere },
      select: { id: true, name: true, creditBalance: true },
    }),
  ])
  const creditors = purchases
    .map((row) => {
      const bal = purchaseBalance(row.totalAmount, row.paidAmount, row.returnedAmount)
      return {
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        supplier: row.supplier.name,
        supplierId: row.supplierId,
        branch: row.branch.code,
        total: money(row.totalAmount),
        paid: money(row.paidAmount),
        owed: bal.owed,
        surplus: bal.surplus,
        sentBack: bal.sentBack,
        creditBalance: money(row.supplier.creditBalance),
      }
    })
    .filter((row) => row.owed > 0)
  const supplierCredits = [
    ...purchases
      .map((row) => {
        const bal = purchaseBalance(row.totalAmount, row.paidAmount, row.returnedAmount)
        return {
          id: row.id,
          invoiceNumber: row.invoiceNumber,
          supplier: row.supplier.name,
          supplierId: row.supplierId,
          branch: row.branch.code,
          total: money(row.totalAmount),
          paid: money(row.paidAmount),
          owed: bal.surplus,
        }
      })
      .filter((row) => row.owed > 0),
    ...groupSupplierLedgers(
      purchases.map((row) => ({
        supplierId: row.supplierId,
        supplierName: row.supplier.name,
        creditBalance: row.supplier.creditBalance,
        totalAmount: 0,
        paidAmount: 0,
        returnedAmount: 0,
      }))
    )
      .filter((house) => house.extraCredit > 0 && house.surplus > 0)
      .map((house) => ({
        id: `${house.id}-credit`,
        invoiceNumber: "Send-back surplus",
        supplier: house.name,
        supplierId: house.id,
        branch: "",
        total: 0,
        paid: 0,
        owed: house.extraCredit,
      })),
    ...creditHouses
      .filter((row) => !purchases.some((bill) => bill.supplierId === row.id))
      .map((row) => ({
        id: `${row.id}-credit`,
        invoiceNumber: "Send-back surplus",
        supplier: row.name,
        supplierId: row.id,
        branch: "",
        total: 0,
        paid: 0,
        owed: money(row.creditBalance),
      })),
  ]
  const priorMix = sumSaleTenders(priorSales)
  // Money in by the day it arrived, like Balance the till: debts collected in
  // the period count, and a later payment on a period sale does not.
  const [receipts, priorReceipts] = await Promise.all([
    receiptsInWindow({ branchId, start: period.start, end: period.end }),
    receiptsInWindow({ branchId, start: prior.start, end: prior.end }),
  ])
  const priorExpense = priorExpenses.reduce((sum, row) => sum + money(row.amount), 0)
  // Sales returns: value taken back on refunds and credit notes finished in
  // this period. The invoices themselves are never edited, so this is the
  // line that turns gross sales into net sales.
  const finishedReturns = await prisma.stockReturn.findMany({
    where: {
      ...shopWhere,
      status: "COMPLETED",
      outcome: { in: ["REFUND", "CREDIT_NOTE"] },
      completedAt: { gte: period.start, lt: period.end },
    },
    select: { returnValue: true, refundAmount: true },
  })
  const salesReturns = finishedReturns.reduce(
    (sum, row) => sum + (money(row.returnValue) || money(row.refundAmount)),
    0
  )

  // Already on the Swap Deal and Returns screens but not finished, so their
  // money is in no total yet. Shown beside the totals so Reports and those
  // screens tell the same story, without counting anything twice.
  const [openSwaps, openReturns, periodDue] = await Promise.all([
    prisma.swap.findMany({
      where: { ...shopWhere, status: { in: ["PENDING", "APPROVED"] } },
      select: { balanceAmount: true, status: true },
    }),
    prisma.stockReturn.findMany({
      where: { ...shopWhere, status: { in: ["PENDING", "APPROVED"] }, outcome: { in: ["REFUND", "CREDIT_NOTE"] } },
      select: { returnValue: true, refundAmount: true },
    }),
    // Still unpaid on the period's sales, after what returns already cleared.
    returnedValueBySale(prisma, sales.map((sale) => sale.id)).then((back) =>
      sales.reduce((sum, sale) => sum + dueAfterReturns(sale, back.get(sale.id) ?? 0), 0)
    ),
  ])
  // Customers owe: the shared rule (see customersOwing), so Home, Reports and
  // Check the books agree for every shop.
  const shopDebtors = (await customersOwing(branchId)).map((row) => ({
    ...row,
    currentBalance: new Prisma.Decimal(row.owed),
  }))
  const loggedReturns = await prisma.stockReturn.count({
    where: { ...shopWhere, createdAt: { gte: period.start, lt: period.end } },
  })

  const waiting = {
    swaps: openSwaps.length,
    swapBalance: openSwaps.reduce((sum, row) => sum + money(row.balanceAmount), 0),
    returns: openReturns.length,
    returnValue: openReturns.reduce((sum, row) => sum + (money(row.returnValue) || money(row.refundAmount)), 0),
    /** Still unpaid on the sales made in this period (part of the all-time total). */
    periodDue,
  }

  return {
    sales,
    loggedReturns,
    receipts,
    salesReturns,
    waiting,
    expenses,
    swaps,
    returns,
    inventory,
    debtors: shopDebtors,
    creditors,
    supplierCredits,
    period,
    prior: {
      from: prior.from,
      to: prior.to,
      revenue: priorMix.revenue,
      collected: priorReceipts.total,
      expenses: priorExpense,
    },
  }
}


/**
 * Every sale line that left the standard price, newest first. This is the
 * control that makes flexible pricing safe: prices may move for a buyer, and
 * the shop can see afterwards who moved them, by how much, and why.
 */
export async function getPriceChanges(limit = 200) {
  const user = await requireUser()
  // Sits on the Profit screen and carries cost and "below cost" lines: profit roles only.
  if (!canSeeProfit(user.role)) {
    return { lines: [] as PriceChangeLine[] }
  }
  const branchId = await viewBranchFilter(user)
  const rows = await prisma.saleItem.findMany({
    where: {
      sale: { status: "COMPLETED", ...(branchId ? { branchId } : {}) },
      // A line only counts as a price change when there is a standard to compare
      // against. Sales written before the standard was recorded carry 0.
      listPrice: { gt: 0 },
    },
    include: {
      product: { select: { name: true } },
      sale: {
        select: {
          invoiceNumber: true,
          saleDate: true,
          isWholesale: true,
          discount: true,
          discountReason: true,
          priceApprovedBy: true,
          branch: { select: { name: true } },
          customer: { select: { name: true } },
          user: { select: { name: true } },
        },
      },
    },
    orderBy: { sale: { saleDate: "desc" } },
    take: Math.min(1000, Math.max(1, limit)) * 3,
  })

  const lines = rows
    .map((row) => {
      const charged = money(row.unitPrice)
      const list = money(row.listPrice)
      const cost = money(row.costPrice)
      const off = money(row.discount)
      return {
        id: row.id,
        invoice: row.sale.invoiceNumber,
        date: row.sale.saleDate,
        shop: row.sale.branch.name,
        soldBy: row.sale.user.name ?? "Staff",
        customer: row.sale.customer?.name ?? "Walk-in",
        item: row.product.name,
        quantity: row.quantity,
        charged,
        list,
        cost,
        off,
        offPercent: list > 0 ? Math.round(((list - charged) / list) * 1000) / 10 : 0,
        reseller: row.sale.isWholesale,
        belowCost: cost > 0 && charged < cost,
        reason: row.priceReason ?? "",
        orderDiscount: money(row.sale.discount),
        orderDiscountReason: row.sale.discountReason ?? "",
        approvedBy: row.sale.priceApprovedBy ?? "",
      }
    })
    .filter((row) => row.off > 0 || row.belowCost || Boolean(row.reason))
    .slice(0, limit)

  return { lines }
}

export type PriceChangeLine = {
  id: string
  invoice: string
  date: Date
  shop: string
  soldBy: string
  customer: string
  item: string
  quantity: number
  charged: number
  list: number
  cost: number
  off: number
  offPercent: number
  reseller: boolean
  belowCost: boolean
  reason: string
  orderDiscount: number
  orderDiscountReason: string
  /** The CEO or Super Admin who approved the price on the seller's till. */
  approvedBy: string
}

export async function getProfitData() {
  const user = await requireUser()
  if (!canSeeProfit(user.role)) {
    return { shopLines: [], expenses: 0, byShop: [] as Array<{ name: string; shopProfit: number; expenses: number; net: number }> }
  }
  const branchId = await viewBranchFilter(user)
  // Every sale, not the latest 200: the page adds these up into "profit from
  // our own stock", and a cap silently dropped older sales from that total.
  // Only the fields the sums and the list use are read.
  const [sales, expenseRows, returned] = await Promise.all([
    prisma.sale.findMany({
      where: { status: "COMPLETED", ...(branchId ? { branchId } : {}) },
      select: {
        id: true,
        invoiceNumber: true,
        saleDate: true,
        subtotal: true,
        discount: true,
        branch: { select: { name: true } },
        items: {
          select: {
            id: true,
            imeiId: true,
            quantity: true,
            totalPrice: true,
            costPrice: true,
            listPrice: true,
            discount: true,
            priceReason: true,
            product: { select: { name: true, storage: true, condition: true, color: true, costPrice: true } },
          },
        },
      },
      orderBy: { saleDate: "desc" },
    }),
    prisma.expense.findMany({
      where: { ...(branchId ? { branchId } : {}), approvedAt: { not: null } },
      include: { branch: true },
    }),
    returnedSaleLineIds(prisma),
  ])

  // A line that came back for a refund or a credit note made no sale in the
  // end: the phone is back on the shelf. It stays on the invoice, not here.
  const wasReturned = (saleId: string, item: { id: string; imeiId: string | null }) =>
    returned.saleItemIds.has(item.id) || (item.imeiId ? returned.imeiOnSale.has(`${saleId}:${item.imeiId}`) : false)

  const shopLines = sales.flatMap((sale) =>
    sale.items.filter((item) => !wasReturned(sale.id, item)).map((item) => {
      // The cost copied onto the line on the day it sold. Sales written before
      // that field existed carry 0, so those fall back to the item's cost today
      // — the old behaviour, and the reason their profit could move on its own.
      const unitCost = money(item.costPrice) || money(item.product.costPrice)
      const cost = unitCost * item.quantity
      // What the line really fetched once the whole-order discount is shared out.
      const sell = lineValueAfterOrderDiscount(item.totalPrice, sale)
      const list = money(item.listPrice)
      return {
        id: item.id,
        invoice: sale.invoiceNumber,
        saleId: sale.id,
        shop: sale.branch.name,
        item: item.product.name,
        storage: item.product.storage,
        condition: item.product.condition,
        color: item.product.color,
        quantity: item.quantity,
        sell,
        cost,
        profit: sell - cost,
        /** 0 when the line carries no snapshot, so the books can flag it. */
        costIsSnapshot: money(item.costPrice) > 0,
        list,
        discount: money(item.discount),
        priceReason: item.priceReason,
        date: sale.saleDate,
      }
    })
  )

  const shopByKey = new Map<string, { name: string; shopProfit: number; expenses: number }>()
  function bucket(name: string) {
    const current = shopByKey.get(name) ?? { name, shopProfit: 0, expenses: 0 }
    shopByKey.set(name, current)
    return current
  }
  for (const line of shopLines) bucket(line.shop).shopProfit += line.profit
  for (const row of expenseRows) bucket(row.branch.name).expenses += money(row.amount)

  const byShop = [...shopByKey.values()]
    .map((row) => ({ ...row, net: row.shopProfit - row.expenses }))
    .sort((a, b) => b.net - a.net)

  return {
    shopLines,
    expenses: expenseRows.reduce((sum, row) => sum + money(row.amount), 0),
    byShop,
  }
}
