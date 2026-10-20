import { prisma } from "@/lib/prisma"
import { dueAfterReturns, returnedValueBySale } from "@/lib/returned-value"
import { money } from "@/lib/utils"

/**
 * What customers owe, per customer.
 *
 * All shops: each customer's balance, the figure their statement ends on.
 * One shop: what is unpaid on THAT shop's invoices, less refunds and credit
 * notes finished on them, and never more than the customer owes in all.
 * Going by the shop a customer was registered at missed buyers from
 * elsewhere who owe here, and counting a buyer's whole balance put other
 * shops' debts on this one. Home, Reports and Check the books all use this,
 * so their "customers owe" figures agree for every shop.
 *
 * Debt that sits on no invoice (an opening balance from before this software,
 * a repair charge, a return's balance) belongs to the shop the customer is
 * registered at. It used to count on no shop at all, so the shops' figures
 * added up to less than the all-shops figure.
 */
export async function customersOwing(branchId?: string | null) {
  if (!branchId) {
    const rows = await prisma.customer.findMany({
      where: { currentBalance: { gt: 0 } },
      include: { branch: true },
      orderBy: { currentBalance: "desc" },
    })
    return rows.map((row) => ({ ...row, owed: money(row.currentBalance) }))
  }
  const [open, homeOwing] = await Promise.all([
    prisma.sale.findMany({
      where: { branchId, status: "COMPLETED", customerId: { not: null } },
      select: { id: true, customerId: true, totalAmount: true, paidAmount: true },
    }),
    prisma.customer.findMany({ where: { branchId, currentBalance: { gt: 0 } }, select: { id: true } }),
  ])
  const dueHere = await invoiceDueByCustomer(open)
  // What this shop's own customers owe on invoices anywhere, to find the part
  // of their balance that is on no invoice at all.
  const homeIds = homeOwing.map((row) => row.id)
  const dueAnywhere = homeIds.length
    ? await invoiceDueByCustomer(
        await prisma.sale.findMany({
          where: { customerId: { in: homeIds }, status: "COMPLETED" },
          select: { id: true, customerId: true, totalAmount: true, paidAmount: true },
        })
      )
    : new Map<string, number>()
  const people = await prisma.customer.findMany({
    where: { id: { in: [...new Set([...dueHere.keys(), ...homeIds])] } },
    include: { branch: true },
  })
  return people
    .map((person) => {
      const balance = money(person.currentBalance)
      const onInvoicesHere = dueHere.get(person.id) ?? 0
      const offInvoice = person.branchId === branchId ? Math.max(0, balance - (dueAnywhere.get(person.id) ?? 0)) : 0
      return { ...person, owed: Math.min(onInvoicesHere + offInvoice, balance) }
    })
    .filter((person) => person.owed > 0)
    .sort((a, b) => b.owed - a.owed)
}

/** Still due per customer on these invoices, after finished returns. */
async function invoiceDueByCustomer(
  sales: Array<{ id: string; customerId: string | null; totalAmount: unknown; paidAmount: unknown }>
) {
  const open = sales.filter((row) => row.customerId && money(row.totalAmount) > money(row.paidAmount))
  const returned = await returnedValueBySale(prisma, open.map((row) => row.id))
  const due = new Map<string, number>()
  for (const row of open) {
    const left = dueAfterReturns(row, returned.get(row.id) ?? 0)
    if (left > 0) due.set(row.customerId!, (due.get(row.customerId!) ?? 0) + left)
  }
  return due
}
