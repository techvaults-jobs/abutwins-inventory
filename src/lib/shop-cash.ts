import { prisma } from "@/lib/prisma"
import { sumSaleTenders } from "@/lib/sale-money"
import { money } from "@/lib/utils"

/**
 * Cash sitting in one shop till on the books:
 * opening cash + cash sales − approved shop expenses − other cash pay-outs
 * (refunds, neighbor pay, swap pay-outs) that are not already an approved expense
 * − cash paid into the bank (Move cash to bank).
 */
/** How an undone collection is written in the money ledger. */
export const UNDO_COLLECTION_NOTE = "Undid money collected on "

/**
 * True for the ledger line an undone collection leaves behind.
 *
 * Undo deletes the payment itself, and cash figures are built from payments,
 * so that money has already left the total. Counting this line as a cash
 * pay-out as well took it off twice: Iwo Road's till read ₦740,000 when it
 * held ₦810,000 after a ₦70,000 cash payment was undone and re-entered by bank.
 */
export function isUndoneCollection(entry: { description?: string | null }) {
  return Boolean(entry.description?.startsWith(UNDO_COLLECTION_NOTE))
}

export async function shopCashOnHand(branchId: string) {
  const [branch, sales, approvedExpenses, expenseNumbers, cashPayOuts, deposits] = await Promise.all([
    prisma.branch.findUnique({
      where: { id: branchId },
      select: { openingCash: true, name: true },
    }),
    prisma.sale.findMany({
      where: { branchId, status: "COMPLETED" },
      select: {
        paymentMethod: true,
        paidAmount: true,
        creditNoteUsed: true,
        totalAmount: true,
        payments: { select: { method: true, amount: true } },
      },
    }),
    prisma.expense.aggregate({
      where: { branchId, approvedAt: { not: null } },
      _sum: { amount: true },
    }),
    prisma.expense.findMany({
      where: { branchId, approvedAt: { not: null } },
      select: { expenseNumber: true },
    }),
    prisma.financeEntry.findMany({
      where: { branchId, account: "CASH", type: "EXPENSE" },
      select: { amount: true, reference: true, description: true },
    }),
    prisma.cashDeposit.aggregate({
      where: { branchId, undoneAt: null },
      _sum: { amount: true },
    }),
  ])

  const cashIn = sumSaleTenders(sales).cash
  const expenseOut = money(approvedExpenses._sum.amount)
  const expenseRefs = new Set(expenseNumbers.map((row) => row.expenseNumber))
  const otherOut = cashPayOuts.reduce((sum, row) => {
    if (row.reference && expenseRefs.has(row.reference)) return sum
    if (isUndoneCollection(row)) return sum
    return sum + money(row.amount)
  }, 0)
  const depositedOut = money(deposits._sum.amount)

  return {
    branchName: branch?.name ?? "This shop",
    openingCash: money(branch?.openingCash),
    cashIn,
    expenseOut,
    otherOut,
    depositedOut,
    available: money(branch?.openingCash) + cashIn - expenseOut - otherOut - depositedOut,
  }
}

/** Refuse a cash pay-out that would push the till below zero. */
export async function assertCashAvailable(
  branchId: string,
  amount: number,
  options?: { ignoreExpenseId?: string }
) {
  const want = money(amount)
  if (want <= 0) return { ok: true as const, available: 0 }
  const till = await shopCashOnHand(branchId)
  const pending = await prisma.expense.aggregate({
    where: {
      branchId,
      approvedAt: null,
      ...(options?.ignoreExpenseId ? { id: { not: options.ignoreExpenseId } } : {}),
    },
    _sum: { amount: true },
  })
  const reserved = money(pending._sum.amount)
  const free = till.available - reserved
  if (want <= free + 0.005) {
    return { ok: true as const, available: free }
  }
  const haveLabel = `₦${Math.max(0, free).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`
  const wantLabel = `₦${want.toLocaleString("en-NG", { maximumFractionDigits: 0 })}`
  if (free <= 0) {
    return {
      ok: false as const,
      available: free,
      error: `Cash in the till at ${till.branchName} is empty${reserved > 0 ? " after bills still waiting for yes" : ""}. You cannot take cash out. Collect a cash sale first, or pay this from the bank.`,
    }
  }
  return {
    ok: false as const,
    available: free,
    error: `Cash in the till at ${till.branchName} is only ${haveLabel}${reserved > 0 ? " after bills still waiting for yes" : ""}. You asked to take out ${wantLabel}. Lower the amount, collect more cash sales first, or pay this from the bank.`,
  }
}
