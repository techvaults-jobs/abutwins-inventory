import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { money } from "@/lib/utils"

/**
 * Money paid out to customers: refunds on returns (RTN- numbers) and Swap
 * Deal pay-outs, from the till or a bank. Money in & out already takes these
 * off the bank; Check the books left them out of Total expenditure, so its
 * money out read short by every refund in the period.
 */
export const customerPayOutWhere: Prisma.FinanceEntryWhereInput = {
  type: "EXPENSE",
  account: { in: ["CASH", "BANK"] },
  OR: [{ reference: { startsWith: "RTN-" } }, { description: { startsWith: "Swap payable" } }],
}

/** Refunds and swap pay-outs in a window, by the day the money left. */
export async function customerPayOutsInWindow(args: { branchId?: string | null; start: Date; end: Date }) {
  const total = await prisma.financeEntry.aggregate({
    where: {
      ...(args.branchId ? { branchId: args.branchId } : {}),
      createdAt: { gte: args.start, lt: args.end },
      ...customerPayOutWhere,
    },
    _sum: { amount: true },
  })
  return money(total._sum.amount)
}
