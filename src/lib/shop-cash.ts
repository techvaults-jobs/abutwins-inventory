import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sumSaleTenders } from "@/lib/sale-money"
import { SUPPLIER_PAYMENT_UNDO_NOTE } from "@/lib/supplier-pay"
import { money } from "@/lib/utils"

/**
 * How money collected on a customer's account is written when no invoice was
 * waiting for it: an opening balance from before this software, a repair
 * charge, or a return's balance. The part that pays invoices becomes payments
 * on those invoices; this part has no invoice, so it is its own line.
 */
export const ON_ACCOUNT_NOTE = "Collected on account, on no invoice: "

/**
 * Customer money that came in with no payment on a sale behind it: the extra
 * paid on a replacement that costs more (written against the return number),
 * and money collected on account that no invoice was waiting for.
 *
 * Every till, bank and money-in figure is built from payments on sales, so
 * this money used to reach none of them: Iwo Road's till read short by every
 * opening balance a customer paid off in cash.
 */
export const offInvoiceMoneyInWhere: Prisma.FinanceEntryWhereInput = {
  type: "INCOME",
  OR: [{ reference: { startsWith: "RTN-" } }, { description: { startsWith: ON_ACCOUNT_NOTE } }],
}

/**
 * A supplier payment made in cash, undone. The payment's own line still reads
 * as cash out, so the till takes this back in. (An undone bank payment needs
 * nothing: the bank is worked out from what is still paid on the bill.)
 */
export const cashSupplierUndoWhere: Prisma.FinanceEntryWhereInput = {
  type: "INCOME",
  account: "CASH",
  description: { startsWith: SUPPLIER_PAYMENT_UNDO_NOTE },
}

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
  const [branch, sales, approvedExpenses, expenseNumbers, cashPayOuts, deposits, cashBack] = await Promise.all([
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
    prisma.financeEntry.aggregate({
      where: { branchId, account: "CASH", OR: [offInvoiceMoneyInWhere, cashSupplierUndoWhere] },
      _sum: { amount: true },
    }),
  ])

  const cashIn = sumSaleTenders(sales).cash + money(cashBack._sum.amount)
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

/**
 * Shop bills a manager said no to. A bill has no status of its own: saying no
 * only marks its approval, so the bill keeps an empty approvedAt and looked
 * like it was still waiting for yes. Each one held its cash aside for ever:
 * Ask for a shop bill read ₦145,500 at Iwo Road while Money in & out read
 * ₦153,500. Holds the bill's number and id, as an approval may name either.
 */
export async function saidNoBillKeys() {
  const rows = await prisma.approval.findMany({
    where: { status: "REJECTED", OR: [{ type: "EXPENSE" }, { entityType: "Expense" }] },
    select: { entityId: true },
  })
  return new Set(rows.map((row) => row.entityId))
}

export function isSaidNoBill(bill: { id: string; expenseNumber: string }, saidNo: Set<string>) {
  return saidNo.has(bill.id) || saidNo.has(bill.expenseNumber)
}

/** Cash held aside in one shop for bills still waiting for yes. */
export async function cashHeldForBills(branchId: string, options?: { ignoreExpenseId?: string }) {
  const [waiting, saidNo] = await Promise.all([
    prisma.expense.findMany({
      where: {
        branchId,
        approvedAt: null,
        ...(options?.ignoreExpenseId ? { id: { not: options.ignoreExpenseId } } : {}),
      },
      select: { id: true, expenseNumber: true, amount: true },
    }),
    saidNoBillKeys(),
  ])
  return waiting.reduce((sum, bill) => (isSaidNoBill(bill, saidNo) ? sum : sum + money(bill.amount)), 0)
}

/** Refuse a cash pay-out that would push the till below zero. */
export async function assertCashAvailable(
  branchId: string,
  amount: number,
  options?: { ignoreExpenseId?: string }
) {
  const want = money(amount)
  if (want <= 0) return { ok: true as const, available: 0 }
  const [till, reserved] = await Promise.all([shopCashOnHand(branchId), cashHeldForBills(branchId, options)])
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
