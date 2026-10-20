import { prisma } from "@/lib/prisma"
import { ON_ACCOUNT_NOTE, offInvoiceMoneyInWhere } from "@/lib/shop-cash"
import { money } from "@/lib/utils"

/**
 * Money actually received in a window, by the day it came in.
 *
 * Home, Reports and Check the books used to add up what was paid on the sales
 * MADE in the window. That missed debts paid today on earlier invoices (Iwo
 * Road collected ₦800,000 on 26 September invoices on the 28th, so those
 * screens read ₦2,696,000 while the till, rightly, read ₦3,496,000), and it
 * counted a later payment on the day of the sale. Balance the till always
 * worked by the day money arrived; this makes the other screens agree.
 *
 * Sales saved before payment rows existed carry their money on the sale
 * itself, so those count on the day of the sale, as they always did.
 */
export async function receiptsInWindow(args: { branchId?: string | null; start: Date; end: Date }) {
  const shop = args.branchId ? { branchId: args.branchId } : {}
  const [payments, legacy, offInvoice] = await Promise.all([
    prisma.payment.findMany({
      where: { paidAt: { gte: args.start, lt: args.end }, sale: { status: "COMPLETED", ...shop } },
      select: { amount: true, method: true, sale: { select: { saleDate: true } } },
    }),
    prisma.sale.findMany({
      where: {
        status: "COMPLETED",
        ...shop,
        saleDate: { gte: args.start, lt: args.end },
        paidAmount: { gt: 0 },
        payments: { none: {} },
      },
      select: { paidAmount: true, creditNoteUsed: true, paymentMethod: true },
    }),
    // Customer money with no sale payment behind it (see offInvoiceMoneyInWhere).
    prisma.financeEntry.findMany({
      where: { ...shop, account: { in: ["CASH", "BANK"] }, createdAt: { gte: args.start, lt: args.end }, ...offInvoiceMoneyInWhere },
      select: { amount: true, account: true, description: true },
    }),
  ])

  let onPeriodSales = 0
  let debtsCollected = 0
  let cash = 0
  let transfer = 0
  let pos = 0
  const add = (method: string, amount: number) => {
    if (method === "CASH") cash += amount
    else if (method === "POS") pos += amount
    else transfer += amount
  }
  for (const row of payments) {
    const amount = money(row.amount)
    if (row.sale.saleDate < args.start) debtsCollected += amount
    else onPeriodSales += amount
    add(row.method, amount)
  }
  for (const row of legacy) {
    // A credit note settles part of a sale with no money coming in.
    const amount = money(row.paidAmount) - money(row.creditNoteUsed)
    if (amount <= 0.005) continue
    onPeriodSales += amount
    add(row.paymentMethod, amount)
  }
  for (const row of offInvoice) {
    const amount = money(row.amount)
    // Collected on account is an old debt paid; the extra on a replacement is
    // today's dealing, like a sale.
    if (row.description?.startsWith(ON_ACCOUNT_NOTE)) debtsCollected += amount
    else onPeriodSales += amount
    add(row.account === "CASH" ? "CASH" : "TRANSFER", amount)
  }
  return { total: onPeriodSales + debtsCollected, onPeriodSales, debtsCollected, cash, transfer, pos, bank: transfer + pos }
}
