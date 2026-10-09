import type { Prisma, PrismaClient } from "@prisma/client"
import { statusLabel } from "@/lib/status"
import { money } from "@/lib/utils"

type Db = PrismaClient | Prisma.TransactionClient

/** One way the money came in on a step: cash, or bank with its account and reference. */
export type PaymentTender = {
  method: string
  amount: number
  bank: string | null
  reference: string | null
}

/**
 * One time money was taken on an invoice: at the sale, or a later part
 * payment. Cash and bank taken together are one step with two tenders.
 */
export type PaymentStep = {
  key: string
  /** ISO time the money was taken. */
  when: string
  /** "At the sale", "Payment 2", ..., with "(final)" on the one that cleared it. */
  stage: string
  amount: number
  tenders: PaymentTender[]
  /** Who took the money, when it is known. */
  by: string | null
  /** What was left to pay on the invoice after this step. */
  leftAfter: number
  note: string | null
}

type PaymentInput = {
  id: string
  amount: unknown
  method: string
  reference: string | null
  notes: string | null
  paidAt: Date
  receivedByUser?: { name: string | null; email: string } | null
  bankAccount?: { bankName: string; accountNumber: string } | null
}

type SaleInput = {
  id: string
  invoiceNumber: string
  totalAmount: unknown
  createdAt: Date
  customerId: string | null
  user?: { name: string | null; email?: string | null } | null
  payments: PaymentInput[]
}

/** Money taken this close to the sale was taken at the till, by the seller. */
const AT_SALE_MS = 5 * 60 * 1000
/** Tenders this close together were one collection (cash and bank at once). */
const SAME_STEP_MS = 5 * 1000
/** How near a Who did what line must be to a payment to name who took it. */
const TRAIL_MATCH_MS = 5 * 60 * 1000

/**
 * The payments on each sale as steps in order, with who took each one and
 * what was left after it. Payments made before the taker was recorded are
 * named from the sale (money taken at the till) or from the collection line
 * in Who did what (a later part payment), where one can be matched.
 */
export async function buildPaymentTrails(db: Db, sales: SaleInput[]) {
  const unnamed = sales.flatMap((sale) =>
    sale.payments
      .filter((payment) => !payment.receivedByUser && payment.paidAt.getTime() - sale.createdAt.getTime() > AT_SALE_MS)
      .map((payment) => ({ sale, payment }))
  )

  // Later collections from before the taker was saved: the invoice's own
  // collection line, or the customer-account collection line, nearest in time.
  const trail: Array<{ at: number; who: string; invoice: string | null; text: string }> = []
  if (unnamed.length) {
    const times = unnamed.map((row) => row.payment.paidAt.getTime())
    const customers = [...new Set(unnamed.map((row) => row.sale.customerId).filter((id): id is string => Boolean(id)))]
    const rows = await db.auditLog.findMany({
      where: {
        action: "CREATE",
        OR: [
          { entityType: "Payment", entityId: { in: [...new Set(unnamed.map((row) => row.sale.invoiceNumber))] } },
          ...customers.map((id) => ({ entityType: "LedgerEntry", newValue: { contains: id } })),
        ],
        createdAt: { gte: new Date(Math.min(...times) - TRAIL_MATCH_MS), lte: new Date(Math.max(...times) + TRAIL_MATCH_MS) },
      },
      select: { entityType: true, entityId: true, newValue: true, createdAt: true, user: { select: { name: true, email: true } } },
    })
    for (const row of rows) {
      const who = row.user?.name || row.user?.email
      if (!who) continue
      trail.push({
        at: row.createdAt.getTime(),
        who,
        invoice: row.entityType === "Payment" ? row.entityId : null,
        text: row.newValue ?? "",
      })
    }
  }

  function takerFromTrail(sale: SaleInput, payment: PaymentInput) {
    const at = payment.paidAt.getTime()
    let best: { gap: number; who: string } | null = null
    for (const row of trail) {
      const mine = row.invoice ? row.invoice === sale.invoiceNumber : Boolean(sale.customerId && row.text.includes(sale.customerId))
      if (!mine) continue
      const gap = Math.abs(row.at - at)
      if (gap <= TRAIL_MATCH_MS && (!best || gap < best.gap)) best = { gap, who: row.who }
    }
    return best?.who ?? null
  }

  const trails = new Map<string, PaymentStep[]>()
  for (const sale of sales) {
    const total = money(sale.totalAmount)
    const ordered = [...sale.payments].sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime())
    const steps: PaymentStep[] = []
    let paidSoFar = 0
    let last: { at: number; by: string | null } | null = null

    for (const payment of ordered) {
      const at = payment.paidAt.getTime()
      const atSale = at - sale.createdAt.getTime() <= AT_SALE_MS
      const by =
        payment.receivedByUser?.name ||
        payment.receivedByUser?.email ||
        (atSale ? sale.user?.name || sale.user?.email || null : takerFromTrail(sale, payment))
      const tender: PaymentTender = {
        method: statusLabel(payment.method),
        amount: money(payment.amount),
        bank: payment.bankAccount ? `${payment.bankAccount.bankName} · ${payment.bankAccount.accountNumber}` : null,
        reference: payment.reference,
      }
      paidSoFar += tender.amount

      const current = steps[steps.length - 1]
      if (current && last && at - last.at <= SAME_STEP_MS && last.by === by) {
        current.tenders.push(tender)
        current.amount += tender.amount
        current.leftAfter = Math.max(0, total - paidSoFar)
      } else {
        steps.push({
          key: payment.id,
          when: payment.paidAt.toISOString(),
          stage: atSale && steps.length === 0 ? "At the sale" : `Payment ${steps.length + 1}`,
          amount: tender.amount,
          tenders: [tender],
          by,
          leftAfter: Math.max(0, total - paidSoFar),
          note: payment.notes,
        })
      }
      last = { at, by }
    }

    // The step that cleared the invoice, when it was a later one.
    const clearing = steps.findIndex((step) => step.leftAfter <= 0.005)
    if (clearing > 0) steps[clearing].stage = `${steps[clearing].stage} (final)`
    trails.set(sale.id, steps)
  }
  return trails
}

/** Every reference on a sale's payments, latest first, without repeats. */
export function trailReferences(steps: PaymentStep[]) {
  const refs: string[] = []
  for (const step of [...steps].reverse()) {
    for (const tender of step.tenders) if (tender.reference && !refs.includes(tender.reference)) refs.push(tender.reference)
  }
  return refs
}

/** One line per step for Excel: "1 Oct 14:05 ₦50,000 Bank (GTB · 0123) ref ABC by Ade". */
export function trailText(steps: PaymentStep[], format: (when: string) => string, currency: (value: number) => string) {
  return steps
    .map((step) => {
      const how = step.tenders
        .map((tender) => `${currency(tender.amount)} ${tender.method}${tender.bank ? ` (${tender.bank})` : ""}${tender.reference ? ` ref ${tender.reference}` : ""}`)
        .join(" + ")
      return `${step.stage}: ${format(step.when)} · ${how}${step.by ? ` · by ${step.by}` : ""} · left ${currency(step.leftAfter)}`
    })
    .join("\n")
}
