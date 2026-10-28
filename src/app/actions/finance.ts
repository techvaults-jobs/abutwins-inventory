"use server"

import { revalidatePath } from "next/cache"
import { ExpenseCategory, Prisma, UserRole } from "@prisma/client"
import * as bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { setStock } from "@/lib/concurrency"
import { branchFilter, canReachBranch, OTHER_SHOP, resolveWritableShopId, viewBranchFilter } from "@/lib/branch-scope"
import { requireUser } from "@/lib/session"
import { canApprove, canHardDelete, canManageFinance, canManageStaff, canEditLetterhead, canSeeAllBranches, canSetOpeningMoney, canSeeProfit, isShopOwner, scopedBranchId } from "@/lib/rbac"
import { can } from "@/lib/permissions"
import { isLetterheadKey } from "@/lib/letterhead"
import { formatCurrency, generateDocNumber, money } from "@/lib/utils"
import { lineValueAfterOrderDiscount, saleTenders, sumSaleTenders } from "@/lib/sale-money"
import { healOpeningStockBills } from "@/lib/opening-stock-money"
import { openingStockSupplierWhere, payablePurchaseWhere, groupSupplierLedgers, purchaseBalance, SUPPLIER_PAYMENT_NOTE } from "@/lib/purchase-money"
import { listPayingBanks, resolveSupplierPayChannel, SUPPLIER_PAYMENT_UNDO_NOTE } from "@/lib/supplier-pay"
import { reportPeriodWindow, reportPreviousWindow, shopPeriodWindow, shopPreviousWindow, watBounds, watDayKey, type ReportRange } from "@/lib/lagos-day"
import { writeAudit } from "@/lib/audit"
import {
  displayAccountNumber,
  displayBankName,
  listedBankClash,
} from "@/lib/opening-money"
import {
  assertCashAvailable,
  cashSupplierUndoWhere,
  isSaidNoBill,
  isUndoneCollection,
  offInvoiceMoneyInWhere,
  saidNoBillKeys,
} from "@/lib/shop-cash"
import { dueAfterReturns, piecesStillSold, returnedSaleLineIds, returnedValueBySale } from "@/lib/returned-value"
import { receiptsInWindow } from "@/lib/receipts"
import { customersOwing } from "@/lib/owed"
import { displayPartyName, partyNameKey } from "@/lib/party-key"

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
    cashHeldForBills: 0,
    supplierPaidNoBank: 0,
    canNameSupplierBanks: false,
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
  /** Supplier payments sent by transfer from this account. */
  supplierPaid: number
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
        creditNoteUsed: true,
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
  const [cashToSupplierRows, cashSupplierUndos] = await Promise.all([
    prisma.financeEntry.findMany({
      where: { ...where, account: "CASH", type: "EXPENSE", description: { startsWith: SUPPLIER_PAYMENT_NOTE } },
      select: { amount: true, description: true },
    }),
    prisma.financeEntry.findMany({
      where: { ...where, ...cashSupplierUndoWhere },
      select: { amount: true, reference: true },
    }),
  ])
  const cashToSupplierByBill = new Map<string, number>()
  for (const row of cashToSupplierRows) {
    const invoice = (row.description ?? "").slice(SUPPLIER_PAYMENT_NOTE.length).split(" ")[0]
    cashToSupplierByBill.set(invoice, (cashToSupplierByBill.get(invoice) ?? 0) + money(row.amount))
  }
  // A cash payment undone is cash no longer paid on that bill; without this
  // the rest of what is paid on it read as less bank money than it was.
  for (const row of cashSupplierUndos) {
    const invoice = row.reference ?? ""
    cashToSupplierByBill.set(invoice, (cashToSupplierByBill.get(invoice) ?? 0) - money(row.amount))
  }
  const bankToSupplier = (po: { invoiceNumber: string; paidAmount: unknown }) =>
    Math.max(0, money(po.paidAmount) - (cashToSupplierByBill.get(po.invoiceNumber) ?? 0))
  const supplierPaymentsByBank = purchases.reduce((sum, p) => sum + bankToSupplier(p), 0)
  const netCashFlow = revenue - expenditure - supplierPayments

  // Which named bank each supplier transfer left from. A payment says so from
  // the day Pay supplier started asking; older ones name no bank, and stay as
  // one figure beside the accounts so the accounts still add up to Bank.
  const supplierBankRows = await prisma.financeEntry.findMany({
    where: {
      bankAccountId: { not: null },
      OR: [
        { type: "EXPENSE", account: "BANK", description: { startsWith: SUPPLIER_PAYMENT_NOTE } },
        { type: "EXPENSE", account: "SUPPLIER_PAYMENTS" },
        { type: "INCOME", account: "BANK", description: { startsWith: SUPPLIER_PAYMENT_UNDO_NOTE } },
      ],
    },
    select: { bankAccountId: true, type: true, amount: true },
  })
  const supplierPaidByBank = new Map<string, number>()
  for (const row of supplierBankRows) {
    const signed = row.type === "INCOME" ? -money(row.amount) : money(row.amount)
    supplierPaidByBank.set(row.bankAccountId!, (supplierPaidByBank.get(row.bankAccountId!) ?? 0) + signed)
  }

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

  // Money that came in with no payment on a sale behind it (see
  // offInvoiceMoneyInWhere), and cash paid to a supplier then undone.
  const otherMoneyIn = await prisma.financeEntry.findMany({
    where: { ...where, account: { in: ["CASH", "BANK"] }, OR: [offInvoiceMoneyInWhere, cashSupplierUndoWhere] },
    include: { branch: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  })
  let otherCashIn = 0
  let otherBankIn = 0
  const otherInByBank = new Map<string, number>()
  for (const entry of otherMoneyIn) {
    const amount = money(entry.amount)
    const line = {
      id: `in-${entry.id}`,
      date: entry.createdAt,
      branch: entry.branch.name,
      type: "IN" as const,
      category: entry.description?.startsWith(SUPPLIER_PAYMENT_UNDO_NOTE)
        ? "Supplier payment undone"
        : entry.reference?.startsWith("RTN-")
          ? "Paid on a replacement"
          : "Collected on account",
      description: entry.description || entry.reference || "Money in",
      amount,
    }
    if (entry.account === "CASH") {
      otherCashIn += amount
      cashEntries.push(line)
    } else {
      otherBankIn += amount
      if (entry.bankAccountId) otherInByBank.set(entry.bankAccountId, (otherInByBank.get(entry.bankAccountId) ?? 0) + amount)
      bankEntries.push(line)
    }
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
    salesReceived: (salesByBank.get(row.id) ?? 0) + (otherInByBank.get(row.id) ?? 0),
    depositsReceived: depositsByBank.get(row.id) ?? 0,
    refundsPaid: refundsByBank.get(row.id) ?? 0,
    supplierPaid: Math.max(0, supplierPaidByBank.get(row.id) ?? 0),
    branchId: row.branchId,
    branchName: row.branch.name,
    branchCode: row.branch.code,
    createdAt: row.createdAt.toISOString(),
  }))
  const openingCash = openingCashShops.reduce((sum, shop) => sum + shop.openingCash, 0)
  const openingBank = namedBanks.reduce((sum, row) => sum + row.openingBalance, 0)
  // Supplier money that left by bank with no account named on it.
  const supplierPaidNoBank = Math.max(0, supplierPaymentsByBank - namedBanks.reduce((sum, row) => sum + row.supplierPaid, 0))

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

  const cashBalance = openingCash + cashRevenue + otherCashIn - expenditure - otherCashOut - cashToBank
  // Still in the till, but held for bills waiting for yes: Ask for a shop bill
  // offers the balance less this, so both screens show it.
  const saidNo = await saidNoBillKeys()
  const cashHeldForBills = expenses
    .filter((e) => !e.approvedAt && !isSaidNoBill(e, saidNo))
    .reduce((sum, e) => sum + money(e.amount), 0)
  const bankBalance = openingBank + bankRevenue + otherBankIn - supplierPaymentsByBank + depositsIn - refundsOut

  const seenHouses = new Set(purchases.map((row) => row.supplierId))
  const ledgers = groupSupplierLedgers([
    ...purchases.map((row) => ({
      supplierId: row.supplierId,
      supplierName: row.supplier.name,
      creditBalance: row.supplier.creditBalance,
      totalAmount: row.totalAmount,
      paidAmount: row.paidAmount,
      returnedAmount: row.returnedAmount,
      shippingFee: row.shippingFee,
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
        shippingFee: 0,
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
    cashHeldForBills,
    supplierPaidNoBank,
    canNameSupplierBanks: await canManageFinance(user.role),
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
  const [rows, saidNo] = await Promise.all([
    prisma.expense.findMany({
      where: branchId ? { branchId } : {},
      include: { branch: { select: { name: true, code: true } } },
      orderBy: { date: "desc" },
    }),
    saidNoBillKeys(),
  ])
  return rows.map((row) => ({ ...row, saidNo: !row.approvedAt && isSaidNoBill(row, saidNo) }))
}

/** The day-by-day lines behind one balance, fetched when its ledger opens. */
export async function getFinanceLedger(account: "CASH" | "BANK") {
  const data = await getFinance({ withLedger: true })
  return account === "CASH" ? data.cashAccount.entries : data.bankAccount.entries
}

export type UnnamedSupplierPayment = {
  /** "entry:<id>" for a recorded payment, "gap:<bill id>" for money paid on a bill with no payment record. */
  key: string
  kind: "entry" | "gap"
  billId: string
  invoiceNumber: string
  supplier: string
  shop: string
  date: string
  amount: number
  what: string
}

/**
 * Supplier money that left by bank with no bank account named on it, one line
 * for each payment. Read the same way Money in and out works out the figure,
 * so the lines add up to it.
 *
 * A payment made on Pay supplier or on upload has a line in the money ledger;
 * naming its bank fills that line in. Some older bills only say how much was
 * paid, with no line behind it: that part shows as one line for the bill.
 */
async function unnamedSupplierPayments(branchId: string | null): Promise<UnnamedSupplierPayment[]> {
  const where = branchId ? { branchId } : {}
  const [bills, moves] = await Promise.all([
    prisma.purchase.findMany({
      where: { ...where, ...payablePurchaseWhere, paidAmount: { gt: 0 } },
      select: {
        id: true,
        invoiceNumber: true,
        paidAmount: true,
        receivedDate: true,
        createdAt: true,
        supplier: { select: { name: true } },
        branch: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.financeEntry.findMany({
      where: {
        ...where,
        OR: [
          { type: "EXPENSE", account: { in: ["CASH", "BANK"] }, description: { startsWith: SUPPLIER_PAYMENT_NOTE } },
          { type: "EXPENSE", account: "SUPPLIER_PAYMENTS" },
          { type: "INCOME", account: "BANK", description: { startsWith: SUPPLIER_PAYMENT_UNDO_NOTE } },
        ],
      },
      select: { id: true, account: true, type: true, amount: true, reference: true, description: true, bankAccountId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ])

  // Which bill a ledger line belongs to: Pay supplier writes the bill number
  // first in the description; an upload payment and an undo carry it as the reference.
  const billOf = (row: (typeof moves)[number]) =>
    row.type === "EXPENSE" && row.account !== "SUPPLIER_PAYMENTS"
      ? (row.description ?? "").slice(SUPPLIER_PAYMENT_NOTE.length).split(" ")[0]
      : row.reference ?? ""
  const byBill = new Map<string, typeof moves>()
  for (const row of moves) {
    const invoice = billOf(row)
    if (!invoice) continue
    const list = byBill.get(invoice) ?? []
    list.push(row)
    byBill.set(invoice, list)
  }

  const rows: UnnamedSupplierPayment[] = []
  for (const bill of bills) {
    const lines = byBill.get(bill.invoiceNumber) ?? []
    const cash = lines.filter((row) => row.type === "EXPENSE" && row.account === "CASH").reduce((sum, row) => sum + money(row.amount), 0)
    const byBank = Math.max(0, money(bill.paidAmount) - cash)
    const payments = lines.filter((row) => row.type === "EXPENSE" && row.account !== "CASH")
    const undos = lines.filter((row) => row.type === "INCOME")
    const named = Math.max(
      0,
      payments.filter((row) => row.bankAccountId).reduce((sum, row) => sum + money(row.amount), 0) -
        undos.filter((row) => row.bankAccountId).reduce((sum, row) => sum + money(row.amount), 0)
    )
    let left = byBank - named
    if (left <= 0.005) continue
    const undone = undos.map((row) => row.description ?? "").join(" ")
    const base = {
      billId: bill.id,
      invoiceNumber: bill.invoiceNumber,
      supplier: bill.supplier.name,
      shop: bill.branch.name,
    }
    for (const row of payments) {
      if (row.bankAccountId || undone.includes(`payment ${row.id}`)) continue
      const amount = money(row.amount)
      if (amount <= 0 || amount > left + 0.005) continue
      left -= amount
      rows.push({
        ...base,
        key: `entry:${row.id}`,
        kind: "entry",
        date: row.createdAt.toISOString(),
        amount,
        what: row.account === "SUPPLIER_PAYMENTS" ? "Paid when the bill was uploaded" : "Paid on Pay supplier",
      })
    }
    if (left > 0.005) {
      rows.push({
        ...base,
        key: `gap:${bill.id}`,
        kind: "gap",
        date: (bill.receivedDate ?? bill.createdAt).toISOString(),
        amount: money(left),
        what: "Marked paid on the bill, with no payment line",
      })
    }
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/** The screen where the accountant names the bank for past supplier payments. */
export async function getUnnamedSupplierPayments() {
  const user = await requireUser()
  if (!(await canManageFinance(user.role))) return null
  await healOpeningStockBills()
  const branchId = (await viewBranchFilter(user)) ?? null
  const [rows, banks] = await Promise.all([unnamedSupplierPayments(branchId), listPayingBanks(user)])
  return { rows, banks, total: rows.reduce((sum, row) => sum + row.amount, 0) }
}

/**
 * Name the bank account past supplier payments left from.
 *
 * Nothing about what was paid changes: not the bill, not the supplier's
 * balance, not the Bank total. The payment only moves from "no bank named"
 * onto the account it really left, so that account's balance is true.
 * `amounts` may give part of a bill's unrecorded payment, for a bill that was
 * paid from two banks.
 */
export async function nameSupplierPaymentBank(payload: { keys: string[]; bankAccountId: string; amounts?: Record<string, number> }) {
  const user = await requireUser()
  if (!(await canManageFinance(user.role))) return { error: "You are not allowed to change supplier payments. Ask accounts." }
  const keys = [...new Set((payload.keys ?? []).map(String))].slice(0, 2000)
  if (!keys.length) return { error: "Tick the payments first." }
  const channel = await resolveSupplierPayChannel(user, "TRANSFER", String(payload.bankAccountId || ""))
  if ("error" in channel) return { error: channel.error }

  // Worked out again here, never taken from the screen, so a payment named a
  // moment ago by someone else, or undone since, cannot be named twice.
  const branchId = (await viewBranchFilter(user)) ?? null
  const open = new Map((await unnamedSupplierPayments(branchId)).map((row) => [row.key, row]))
  const picked = keys.map((key) => open.get(key)).filter((row): row is UnnamedSupplierPayment => Boolean(row))
  if (!picked.length) return { error: "Those payments already have a bank. Refresh the page." }

  let total = 0
  try {
    await prisma.$transaction(async (tx) => {
      for (const row of picked) {
        if (row.kind === "entry") {
          const { count } = await tx.financeEntry.updateMany({
            where: { id: row.key.slice("entry:".length), bankAccountId: null },
            data: { bankAccountId: channel.bankAccountId },
          })
          if (count) total += row.amount
          continue
        }
        const asked = Number(payload.amounts?.[row.key])
        const amount = Number.isFinite(asked) && asked > 0 ? Math.min(money(asked), row.amount) : row.amount
        const bill = await tx.purchase.findUnique({ where: { id: row.billId }, select: { branchId: true } })
        if (!bill) continue
        // Not written as a payment (it starts with other words), so the month's
        // "sent to suppliers" on Home does not count the same money again.
        await tx.financeEntry.create({
          data: {
            branchId: bill.branchId,
            account: "SUPPLIER_PAYMENTS",
            type: "EXPENSE",
            amount: amount.toFixed(2),
            reference: row.invoiceNumber,
            bankAccountId: channel.bankAccountId,
            description: `Bank named for money already paid on ${row.invoiceNumber} (${row.supplier}) · from ${channel.from}`,
            createdAt: new Date(row.date),
          },
        })
        total += amount
      }
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: "UPDATE",
          entityType: "SupplierPaymentBank",
          entityId: picked.length === 1 ? picked[0].invoiceNumber : `${picked.length} payments`,
          newValue: JSON.stringify({
            bank: channel.from,
            payments: picked.length,
            total,
            bills: [...new Set(picked.map((row) => row.invoiceNumber))].slice(0, 60),
            note: `Named ${channel.from} as the bank ${picked.length} supplier payment${picked.length === 1 ? "" : "s"} left from. Nothing paid or owed changed.`,
          }),
          branchId: user.branchId,
        },
      })
    })
  } catch (error) {
    return { error: error instanceof Error && error.message ? "Could not save the bank for these payments. Nothing was changed." : "Could not save." }
  }

  revalidateMoneyViews()
  revalidatePath("/finance/supplier-banks")
  return { success: true, named: picked.length, total, bank: channel.from }
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
      // The day the money landed, not the day of the sale: a debt paid weeks
      // later sat in the statement weeks too early.
      date: payment.paidAt,
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

  // Customer money into this account with no sale payment behind it
  const otherIn = await prisma.financeEntry.findMany({
    where: { bankAccountId, account: "BANK", ...offInvoiceMoneyInWhere },
    orderBy: { createdAt: "desc" },
  })
  for (const entry of otherIn) {
    entries.push({
      id: `in-${entry.id}`,
      date: entry.createdAt,
      type: "IN",
      category: entry.reference?.startsWith("RTN-") ? "Paid on a replacement" : "Collected on account",
      description: entry.description || entry.reference || "Money in",
      amount: money(entry.amount),
      reference: entry.reference,
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

  // Supplier payments sent from this account, and any that were undone
  const supplierMoves = await prisma.financeEntry.findMany({
    where: {
      bankAccountId,
      OR: [
        { type: "EXPENSE", account: "BANK", description: { startsWith: SUPPLIER_PAYMENT_NOTE } },
        { type: "EXPENSE", account: "SUPPLIER_PAYMENTS" },
        { type: "INCOME", account: "BANK", description: { startsWith: SUPPLIER_PAYMENT_UNDO_NOTE } },
      ],
    },
    orderBy: { createdAt: "desc" },
  })
  for (const entry of supplierMoves) {
    entries.push({
      id: `supplier-${entry.id}`,
      date: entry.createdAt,
      type: entry.type === "INCOME" ? "IN" : "OUT",
      category: entry.type === "INCOME" ? "Supplier payment undone" : "Paid to supplier",
      description: entry.description || entry.reference || "Supplier payment",
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
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Type the amount and pick the shop." }
  // A missing kind used to reach the database as the word "null" and fail
  // with a server error instead of a message.
  const category = String(formData.get("category") || "")
  if (!(Object.values(ExpenseCategory) as string[]).includes(category)) return { error: "Pick what kind of bill it is." }

  const cashGate = await assertCashAvailable(branchId, amount)
  if (!cashGate.ok) return { error: cashGate.error }

  // The bill and its request for yes are written together: a bill with no
  // request could never be approved, and still held its cash aside.
  await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: {
        expenseNumber: generateDocNumber("EXP"),
        branchId,
        userId: user.id,
        category: category as ExpenseCategory,
        amount: money(amount).toFixed(2),
        description: String(formData.get("description") || "Expense"),
        notes: String(formData.get("notes") || "") || null,
      },
    })
    await tx.approval.create({
      data: {
        type: "EXPENSE",
        entityId: expense.expenseNumber,
        entityType: "Expense",
        requestedBy: user.id,
        reason: expense.description,
      },
    })
  })
  revalidatePath("/expenses")
  revalidatePath("/finance")
  revalidatePath("/approvals")
  return { success: true }
}

/**
 * Fix a shop expense a member of staff typed wrong: the amount, what it was
 * for or its kind. Or cancel one that should never have been written. The
 * CEO's and the main admin's correction; the old figures and the reason go to
 * Who did what.
 *
 * The till is counted from approved expenses, so it follows. A higher amount
 * must still be in the till. A cancelled expense stays on the list at nothing,
 * marked cancelled, so the trail is not lost; one still waiting for a yes is
 * taken off Needs approval.
 */
export async function correctExpense(formData: FormData) {
  const user = await requireUser()
  if (!isShopOwner(user.role)) return { error: "Only the CEO or the main admin can fix an expense." }
  const id = String(formData.get("id") || "")
  const cancel = formData.get("cancel") === "on"
  const why = String(formData.get("reason") || "").trim()
  if (why.length < 4) return { error: "Say why the expense is being fixed, for Who did what." }

  const expense = await prisma.expense.findUnique({ where: { id } })
  if (!expense) return { error: "We could not find that expense." }
  if (!(await canReachBranch(user, expense.branchId))) return { error: OTHER_SHOP }
  if (expense.description.startsWith(CANCELLED_EXPENSE)) return { error: "This expense was already cancelled." }
  if (!expense.approvedAt && isSaidNoBill(expense, await saidNoBillKeys())) {
    return { error: "A manager said no to this bill. Ask for a new shop bill instead." }
  }

  const oldAmount = money(expense.amount)
  const nextAmount = cancel ? 0 : money(Number(formData.get("amount")))
  const categoryRaw = String(formData.get("category") || expense.category)
  if (!(Object.values(ExpenseCategory) as string[]).includes(categoryRaw)) return { error: "Pick what kind of expense it was." }
  const nextCategory = categoryRaw as ExpenseCategory
  const typedDescription = String(formData.get("description") ?? expense.description).trim() || expense.description
  const nextDescription = cancel ? `${CANCELLED_EXPENSE}${typedDescription}` : typedDescription
  if (!cancel && (!Number.isFinite(nextAmount) || nextAmount <= 0)) {
    return { error: "Type the right amount. To take the expense away, tick Cancel this expense." }
  }
  if (!cancel && Math.abs(nextAmount - oldAmount) < 0.005 && nextCategory === expense.category && nextDescription === expense.description) {
    return { error: "Nothing was changed on this expense." }
  }

  // More money out of the till must be there. An approved expense already
  // came off the till, so only the extra counts; one waiting is held aside in
  // full, so it is checked in full without its old self.
  const extra = expense.approvedAt ? nextAmount - oldAmount : nextAmount
  if (extra > 0.005) {
    const till = await assertCashAvailable(expense.branchId, extra, { ignoreExpenseId: expense.id })
    if (!till.ok) return { error: till.error }
  }

  await prisma.$transaction(async (tx) => {
    await tx.expense.update({
      where: { id: expense.id },
      data: { amount: nextAmount.toFixed(2), category: nextCategory, description: nextDescription },
    })
    // The money-out line written when it was approved follows it.
    await tx.financeEntry.updateMany({
      where: { reference: expense.expenseNumber, type: "EXPENSE" },
      data: { amount: nextAmount.toFixed(2), description: nextDescription },
    })
    if (cancel && !expense.approvedAt) {
      await tx.approval.updateMany({
        where: { entityType: "Expense", entityId: { in: [expense.id, expense.expenseNumber] }, status: "PENDING" },
        data: { status: "REJECTED", approvedBy: user.id, approvedAt: new Date() },
      })
    }
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "UPDATE",
        entityType: "Expense",
        entityId: expense.expenseNumber,
        oldValue: JSON.stringify({ amount: oldAmount, category: expense.category, description: expense.description }),
        newValue: JSON.stringify({
          amount: nextAmount,
          category: nextCategory,
          description: nextDescription,
          cancelled: cancel || null,
          why,
          note: `Expense ${expense.expenseNumber} ${cancel ? "cancelled" : "fixed"} by ${user.name || user.email}: ${formatCurrency(oldAmount)} → ${formatCurrency(nextAmount)}.`,
        }),
        branchId: expense.branchId,
        risk: "HIGH",
      },
    })
  })
  revalidatePath("/expenses")
  revalidatePath("/finance")
  revalidatePath("/approvals")
  return { success: true }
}

/** How a cancelled expense's description starts. */
const CANCELLED_EXPENSE = "Cancelled: "

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

  // Only one decision lands. Two managers pressing yes at the same moment both
  // got past the check at the top, and each went on to post the money.
  const claimed = await prisma.approval.updateMany({
    where: { id, status: "PENDING" },
    data: { status, approvedBy: user.id, approvedAt: new Date() },
  })
  if (claimed.count !== 1) return { error: "Somebody has already decided on this one." }

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
      // The bill and its money-out line are written together, once.
      await prisma.$transaction(async (tx) => {
        const marked = await tx.expense.updateMany({
          where: { id: expense.id, approvedAt: null },
          data: { approvedBy: user.id, approvedAt: new Date() },
        })
        if (marked.count !== 1) return
        const alreadyPosted = await tx.financeEntry.findFirst({
          where: { reference: expense.expenseNumber },
        })
        if (!alreadyPosted) {
          await tx.financeEntry.create({
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
      })
    }
  }

  if (approval.type === "RECONCILIATION") {
    const recon = await prisma.reconciliation.findFirst({
      where: { OR: [{ id: approval.entityId }] },
      include: { items: true },
    })
    if (recon) {
      // The count and the shelves it sets move together, or not at all: a
      // failure half way left some shelves set and the count still waiting.
      await prisma.$transaction(async (tx) => {
        const decided = await tx.reconciliation.updateMany({
          where: { id: recon.id, status: { notIn: ["APPROVED", "REJECTED"] } },
          data: {
            status: status === "APPROVED" ? "APPROVED" : "REJECTED",
            approvedBy: user.id,
            approvedAt: new Date(),
            completedAt: new Date(),
          },
        })
        if (decided.count !== 1 || status !== "APPROVED") return
        for (const item of recon.items) {
          // A count says what the shelf is, so the ledger line is the difference
          // against the shelf as it stands now, not the variance worked out on
          // the day of the count — the shelf may have moved since.
          await setStock(tx, {
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
      }, { timeout: 60_000 })
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

  // The CEO owns the business, so the CEO can hand someone main admin too.
  if (role === "SUPER_ADMIN" && !isShopOwner(user.role)) {
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
  if (target.role === "SUPER_ADMIN" && !isShopOwner(user.role)) {
    return { error: "Only the CEO or another main admin can reset a main admin's password." }
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

  // The CEO owns the business, so the CEO can hand someone main admin too.
  if (role === "SUPER_ADMIN" && !isShopOwner(user.role)) {
    return { error: "Only the CEO or the main admin can make someone a main admin." }
  }
  if ((target.role === "CEO" || role === "CEO") && user.role !== "CEO") {
    return { error: "Only the CEO can edit the CEO's login or make someone CEO." }
  }
  if (target.role === "SUPER_ADMIN" && !isShopOwner(user.role)) {
    return { error: "Only the CEO or another main admin can edit a main admin." }
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
  range: ReportRange = "month",
  businessDate?: string,
  /** First day, when the range is a chosen stretch; `businessDate` is then the last day. */
  fromDate?: string
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
      returnsByShop: [] as Array<{ branchId: string; value: number; items: number; cost: number }>,
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
  const span: ReportRange = range === "week" || range === "day" || range === "custom" ? range : "month"
  const period = reportPeriodWindow(day, span, fromDate)
  const prior = reportPreviousWindow(period, span)
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
      select: { totalAmount: true, paidAmount: true, creditNoteUsed: true, paymentMethod: true, payments: { select: { method: true, amount: true } } },
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
  // Supplier money house by house, netted the way Home, Money in & out and
  // Check the books net it (groupSupplierLedgers). Bills were listed one by
  // one here, so a house owed on one bill and in credit on another (or holding
  // send-back credit) read as owed in full: Reports' "still owed to
  // suppliers" came out higher than the same figure on Home. Each house still
  // shows its bills; a closing line takes off what the netting takes off, so
  // the house adds up to what it really comes to.
  type SupplierRow = {
    id: string
    invoiceNumber: string
    supplier: string
    supplierId: string
    branch: string
    total: number
    paid: number
    owed: number
  }
  const houseKey = (name: string, id: string) => partyNameKey(name) || displayPartyName(name) || id
  const houses = new Map<string, { bills: typeof purchases; credit: Array<{ id: string; name: string; creditBalance: unknown }> }>()
  for (const bill of purchases) {
    const key = houseKey(bill.supplier.name, bill.supplierId)
    const house = houses.get(key) ?? { bills: [], credit: [] }
    house.bills.push(bill)
    houses.set(key, house)
  }
  for (const row of creditHouses) {
    if (purchases.some((bill) => bill.supplierId === row.id)) continue
    const key = houseKey(row.name, row.id)
    const house = houses.get(key) ?? { bills: [], credit: [] }
    house.credit.push(row)
    houses.set(key, house)
  }
  const creditors: SupplierRow[] = []
  const supplierCredits: SupplierRow[] = []
  for (const house of houses.values()) {
    const [ledger] = groupSupplierLedgers([
      ...house.bills.map((row) => ({
        supplierId: row.supplierId,
        supplierName: row.supplier.name,
        creditBalance: row.supplier.creditBalance,
        totalAmount: row.totalAmount,
        paidAmount: row.paidAmount,
        returnedAmount: row.returnedAmount,
        shippingFee: row.shippingFee,
      })),
      ...house.credit.map((row) => ({
        supplierId: row.id,
        supplierName: row.name,
        creditBalance: row.creditBalance,
        totalAmount: 0,
        paidAmount: 0,
        returnedAmount: 0,
        shippingFee: 0,
      })),
    ])
    if (!ledger) continue
    const billRows = house.bills.map((row) => ({ row, bal: purchaseBalance(row) }))
    const base = (row: (typeof purchases)[number], owed: number): SupplierRow => ({
      id: row.id,
      invoiceNumber: row.invoiceNumber,
      supplier: row.supplier.name,
      supplierId: row.supplierId,
      branch: row.branch.code,
      total: money(row.totalAmount),
      paid: money(row.paidAmount),
      owed,
    })
    const closing = (suffix: string, invoiceNumber: string, owed: number): SupplierRow => ({
      id: `${ledger.id}-${suffix}`,
      invoiceNumber,
      supplier: ledger.name,
      supplierId: ledger.id,
      branch: "",
      total: 0,
      paid: 0,
      owed,
    })
    if (ledger.owed > 0.005) {
      const rows = billRows.filter(({ bal }) => bal.owed > 0).map(({ row, bal }) => base(row, bal.owed))
      const listed = rows.reduce((sum, row) => sum + row.owed, 0)
      if (listed - ledger.owed > 0.005) rows.push(closing("netted", "Less send-backs and bills paid over", ledger.owed - listed))
      creditors.push(...rows)
    } else if (ledger.surplus > 0.005) {
      const rows = billRows.filter(({ bal }) => bal.surplus > 0).map(({ row, bal }) => base(row, bal.surplus))
      if (ledger.extraCredit > 0) rows.push(closing("credit", "Send-back surplus", ledger.extraCredit))
      const listed = rows.reduce((sum, row) => sum + row.owed, 0)
      if (listed - ledger.surplus > 0.005) rows.push(closing("netted", "Less bills still owed", ledger.surplus - listed))
      supplierCredits.push(...rows)
    }
  }
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
    select: {
      branchId: true,
      returnValue: true,
      refundAmount: true,
      quantity: true,
      saleId: true,
      imeiId: true,
      saleItem: { select: { quantity: true, costPrice: true, product: { select: { costPrice: true } } } },
      imei: { select: { product: { select: { costPrice: true } } } },
    },
  })
  const salesReturns = finishedReturns.reduce(
    (sum, row) => sum + (money(row.returnValue) || money(row.refundAmount)),
    0
  )
  // The same returns shop by shop, with how many items came back and what
  // they cost us when sold, so Sales by shop can go from total sales to the
  // actual sales and the cost of the actual sales. A phone's return points at
  // its sale and IMEI, not the sale line, so that line is looked up.
  const phoneLines = finishedReturns.filter((row) => !row.saleItem && row.saleId && row.imeiId)
  const phoneLineCost = new Map(
    (phoneLines.length
      ? await prisma.saleItem.findMany({
          where: { OR: phoneLines.map((row) => ({ saleId: row.saleId!, imeiId: row.imeiId! })) },
          select: { saleId: true, imeiId: true, costPrice: true, product: { select: { costPrice: true } } },
        })
      : []
    ).map((line) => [`${line.saleId}:${line.imeiId}`, money(line.costPrice) || money(line.product.costPrice)])
  )
  const returnsByShop = new Map<string, { value: number; items: number; cost: number }>()
  for (const row of finishedReturns) {
    const items = row.saleItem ? row.quantity || row.saleItem.quantity : 1
    // The cost written on the sale line the day it sold, as Profit uses;
    // older lines without one fall back to the item's cost today.
    const unitCost = row.saleItem
      ? money(row.saleItem.costPrice) || money(row.saleItem.product.costPrice)
      : phoneLineCost.get(`${row.saleId}:${row.imeiId}`) || money(row.imei?.product.costPrice)
    const entry = returnsByShop.get(row.branchId) ?? { value: 0, items: 0, cost: 0 }
    entry.value += money(row.returnValue) || money(row.refundAmount)
    entry.items += items
    entry.cost += unitCost * items
    returnsByShop.set(row.branchId, entry)
  }

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
    returnsByShop: [...returnsByShop.entries()].map(([branchId, row]) => ({ branchId, ...row })),
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
export async function getPriceChanges(limit = 200, period?: { from: string; to: string } | null) {
  const user = await requireUser()
  // Sits on the Profit screen and carries cost and "below cost" lines: profit roles only.
  if (!canSeeProfit(user.role)) {
    return { lines: [] as PriceChangeLine[] }
  }
  const branchId = await viewBranchFilter(user)
  const rows = await prisma.saleItem.findMany({
    where: {
      sale: {
        status: "COMPLETED",
        ...(branchId ? { branchId } : {}),
        ...(period ? { saleDate: { gte: watBounds(period.from).start, lt: watBounds(period.to).end } } : {}),
      },
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

export type ProfitByShop = {
  name: string
  items: number
  sales: number
  cost: number
  shopProfit: number
  expenses: number
  net: number
}

/**
 * Profit for a period: the Reports periods (one day, last 7 days, this month
 * so far, or any From and To days), or "all" for every sale ever. Leaving the
 * range out reads every sale, as the screen did before it had a period.
 */
export async function getProfitData(range: ReportRange | "all" = "all", businessDate?: string, fromDate?: string) {
  const user = await requireUser()
  const day = businessDate && /^\d{4}-\d{2}-\d{2}$/.test(businessDate) ? businessDate : watDayKey()
  const period = range === "all" ? null : reportPeriodWindow(day, range, fromDate)
  if (!canSeeProfit(user.role)) {
    return {
      shopLines: [],
      expenses: 0,
      byShop: [] as ProfitByShop[],
      period: period ? { from: period.from, to: period.to } : null,
      invoices: 0,
      invoiceTotal: 0,
      tax: 0,
      returnedValue: 0,
      mismatched: [] as Array<{ invoice: string; invoiceTotal: number; linesTotal: number }>,
    }
  }
  const branchId = await viewBranchFilter(user)
  const when = period ? { gte: period.start, lt: period.end } : undefined
  // Every sale in the period, not the latest 200: the page adds these up into
  // "profit from our own stock", and a cap silently dropped older sales from
  // that total. Only the fields the sums and the list use are read.
  const [sales, expenseRows, returned] = await Promise.all([
    prisma.sale.findMany({
      where: { status: "COMPLETED", ...(branchId ? { branchId } : {}), ...(when ? { saleDate: when } : {}) },
      select: {
        id: true,
        invoiceNumber: true,
        saleDate: true,
        subtotal: true,
        discount: true,
        tax: true,
        totalAmount: true,
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
            imei: { select: { imei1: true, serialNumber: true } },
          },
        },
      },
      orderBy: { saleDate: "desc" },
    }),
    // Shop bills dated in the same period, as Reports counts them.
    prisma.expense.findMany({
      where: { ...(branchId ? { branchId } : {}), approvedAt: { not: null }, ...(when ? { date: when } : {}) },
      include: { branch: true },
    }),
    returnedSaleLineIds(prisma),
  ])

  // What came back off these invoices, at what it had fetched, so the page
  // can show how the invoices' total comes down to the sales counted here.
  let returnedValue = 0

  // What came back for a refund or a credit note made no sale in the end: it
  // is back on the shelf. It stays on the invoice, not here. A line that came
  // back in part keeps the pieces still sold; the whole line used to drop out,
  // so two cords returned off a line of five took the profit on all five.
  const shopLines = sales.flatMap((sale) =>
    sale.items.flatMap((item) => {
      const kept = piecesStillSold(returned, sale.id, item)
      const fetched = lineValueAfterOrderDiscount(item.totalPrice, sale)
      if (item.quantity > 0) returnedValue += (fetched * Math.max(0, item.quantity - kept)) / item.quantity
      if (kept <= 0) return []
      const share = kept / item.quantity
      // The cost copied onto the line on the day it sold. Sales written before
      // that field existed carry 0, so those fall back to the item's cost today
      // — the old behaviour, and the reason their profit could move on its own.
      const unitCost = money(item.costPrice) || money(item.product.costPrice)
      const cost = unitCost * kept
      // What the line really fetched once the whole-order discount is shared out.
      const sell = fetched * share
      const list = money(item.listPrice)
      return [{
        id: item.id,
        invoice: sale.invoiceNumber,
        saleId: sale.id,
        shop: sale.branch.name,
        item: item.product.name,
        storage: item.product.storage,
        condition: item.product.condition,
        color: item.product.color,
        unit: item.imei ? item.imei.imei1 || item.imei.serialNumber || "" : "",
        quantity: kept,
        sell,
        cost,
        profit: sell - cost,
        /** 0 when the line carries no snapshot, so the books can flag it. */
        costIsSnapshot: money(item.costPrice) > 0,
        list,
        discount: money(item.discount),
        priceReason: item.priceReason,
        date: sale.saleDate,
      }]
    })
  )

  const shopByKey = new Map<string, Omit<ProfitByShop, "net">>()
  function bucket(name: string) {
    const current = shopByKey.get(name) ?? { name, items: 0, sales: 0, cost: 0, shopProfit: 0, expenses: 0 }
    shopByKey.set(name, current)
    return current
  }
  for (const line of shopLines) {
    const row = bucket(line.shop)
    row.items += line.quantity
    row.sales += line.sell
    row.cost += line.cost
    row.shopProfit += line.profit
  }
  for (const row of expenseRows) bucket(row.branch.name).expenses += money(row.amount)

  // An invoice whose lines do not add up to its total (a line changed and the
  // total not, or the other way round). Profit reads the lines and Reports the
  // total, so these are the invoices behind any gap between the two screens.
  const mismatched = sales.flatMap((sale) => {
    const linesTotal =
      sale.items.reduce((sum, item) => sum + lineValueAfterOrderDiscount(item.totalPrice, sale), 0) + money(sale.tax)
    const invoiceTotal = money(sale.totalAmount)
    return Math.abs(linesTotal - invoiceTotal) >= 1 ? [{ invoice: sale.invoiceNumber, invoiceTotal, linesTotal }] : []
  })

  const byShop: ProfitByShop[] = [...shopByKey.values()]
    .map((row) => ({ ...row, net: row.shopProfit - row.expenses }))
    .sort((a, b) => b.net - a.net)

  return {
    shopLines,
    expenses: expenseRows.reduce((sum, row) => sum + money(row.amount), 0),
    byShop,
    period: period ? { from: period.from, to: period.to } : null,
    invoices: sales.length,
    /** The invoices as written: the Total sales figure on Reports for the same period. */
    invoiceTotal: sales.reduce((sum, sale) => sum + money(sale.totalAmount), 0),
    tax: sales.reduce((sum, sale) => sum + money(sale.tax), 0),
    returnedValue,
    mismatched,
  }
}
