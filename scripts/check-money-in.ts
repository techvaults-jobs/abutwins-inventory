/**
 * Money that came in, or went back, with nothing on the books to show for it.
 *
 *   npx tsx scripts/check-money-in.ts           # report only, writes nothing
 *   npx tsx scripts/check-money-in.ts --apply   # also puts right section 3
 *
 * Found in the October 2026 audit. Every till, bank and money-in figure is
 * built from payments on sales, and three kinds of money had none:
 *
 * 1. Money collected on a customer's account that no invoice was waiting for
 *    (an opening balance, a repair charge). The customer's debt came down,
 *    but the cash never reached the till or the bank. Collections from now on
 *    write their own "Collected on account" line; older ones are listed here
 *    for the books desk to decide. Nothing in section 1 is changed by --apply:
 *    a shortage at the count may already have been written off by hand.
 *
 * 2. The extra a customer paid on a replacement that cost more than what they
 *    returned. The till now counts these lines, so each shop's cash goes up by
 *    the total listed. They were already written; nothing changes here.
 *
 * 3. A cash payment to a supplier, undone, was put back into the bank instead
 *    of the till: the till read short and the bank high by the same amount.
 *    --apply moves each such undo line to the till. Exact and safe: the line
 *    names the payment it undid, and that payment left from the till.
 */
import { PrismaClient } from "@prisma/client"
import { stampHash } from "../src/lib/audit-meta"

const prisma = new PrismaClient()
const apply = process.argv.includes("--apply")

const ON_ACCOUNT_NOTE = "Collected on account, on no invoice: "
const UNDO_NOTE = "Undid a payment to the supplier"
const SHARED_NOTE = "Taken from what the customer paid on their account"

function naira(value: number) {
  return `₦${value.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

async function main() {
  const shops = new Map((await prisma.branch.findMany({ select: { id: true, code: true } })).map((row) => [row.id, row.code]))

  // ---- 1. Collected on account, never reaching the till or bank -----------
  console.log("\n1. Money collected on account with no invoice behind it (older collections)")
  const collections = await prisma.financeEntry.findMany({
    where: { type: "INCOME", reference: { startsWith: "PAY-" }, description: { startsWith: "Money collected from " } },
    orderBy: { createdAt: "asc" },
  })
  const explicit = new Set(
    (
      await prisma.financeEntry.findMany({
        where: { type: "INCOME", description: { startsWith: ON_ACCOUNT_NOTE } },
        select: { reference: true },
      })
    ).map((row) => row.reference)
  )
  const byRef = new Map<string, typeof collections>()
  for (const row of collections) {
    if (!row.reference || explicit.has(row.reference)) continue
    byRef.set(row.reference, [...(byRef.get(row.reference) ?? []), row])
  }
  let gapTotal = 0
  for (const [ref, lines] of byRef) {
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "LedgerEntry", entityId: ref }, select: { newValue: true } })
    const customerId = (() => {
      try {
        return JSON.parse(audit?.newValue ?? "{}").customerId as string | undefined
      } catch {
        return undefined
      }
    })()
    const at = lines[0].createdAt
    const payments = await prisma.payment.findMany({
      where: {
        OR: [
          { reference: ref },
          // Bank payments carry the bank reference instead; they were written
          // in the same step, seconds apart, for the same customer.
          {
            notes: { startsWith: SHARED_NOTE },
            paidAt: { gte: new Date(at.getTime() - 15_000), lte: new Date(at.getTime() + 15_000) },
            ...(customerId ? { sale: { customerId } } : {}),
          },
        ],
      },
      select: { amount: true, method: true },
    })
    for (const account of ["CASH", "BANK"] as const) {
      const came = lines.filter((row) => row.account === account).reduce((sum, row) => sum + Number(row.amount), 0)
      const placed = payments
        .filter((row) => (account === "CASH" ? row.method === "CASH" : row.method !== "CASH"))
        .reduce((sum, row) => sum + Number(row.amount), 0)
      const gap = Math.round((came - placed) * 100) / 100
      if (gap > 0.005) {
        gapTotal += gap
        console.log(`  ${shops.get(lines[0].branchId) ?? "?"} · ${ref} · ${at.toISOString().slice(0, 10)} · ${account === "CASH" ? "cash" : "bank"} ${naira(gap)} · ${lines[0].description}`)
      }
    }
  }
  console.log(gapTotal > 0 ? `  Total never counted: ${naira(gapTotal)}. The books desk decides how each is put right.` : "  None.")

  // ---- 2. Paid on a replacement --------------------------------------------
  console.log("\n2. Paid on a replacement (now counted in the till and bank)")
  const topUps = await prisma.financeEntry.findMany({
    where: { type: "INCOME", reference: { startsWith: "RTN-" } },
    orderBy: { createdAt: "asc" },
  })
  for (const row of topUps) {
    console.log(`  ${shops.get(row.branchId) ?? "?"} · ${row.reference} · ${row.createdAt.toISOString().slice(0, 10)} · ${row.account === "CASH" ? "cash" : "bank"} ${naira(Number(row.amount))}`)
  }
  const topUpTotal = topUps.reduce((sum, row) => sum + Number(row.amount), 0)
  console.log(topUps.length ? `  Total: ${naira(topUpTotal)}. Days already balanced will show the change since they were counted.` : "  None.")

  // ---- 3. Cash supplier payments undone into the bank ----------------------
  console.log("\n3. Cash paid to a supplier, undone into the bank instead of the till")
  const undos = await prisma.financeEntry.findMany({
    where: { type: "INCOME", account: "BANK", description: { startsWith: UNDO_NOTE } },
  })
  let moved = 0
  for (const undo of undos) {
    const paymentId = undo.description?.match(/· payment (\S+)/)?.[1]
    if (!paymentId) continue
    const paid = await prisma.financeEntry.findUnique({ where: { id: paymentId }, select: { account: true } })
    if (paid?.account !== "CASH") continue
    console.log(`  ${shops.get(undo.branchId) ?? "?"} · ${undo.reference} · ${undo.createdAt.toISOString().slice(0, 10)} · ${naira(Number(undo.amount))} back to the till`)
    if (apply) {
      await prisma.$transaction(async (tx) => {
        await tx.financeEntry.update({ where: { id: undo.id }, data: { account: "CASH", bankAccountId: null } })
        // Chained onto Who did what the way the app writes it, so the lock holds.
        const last = await tx.auditLog.findFirst({ orderBy: { createdAt: "desc" }, select: { hash: true } })
        const createdAt = new Date()
        const newValue = JSON.stringify({
          account: "CASH",
          note: `Undone cash supplier payment on ${undo.reference} moved back to the till (October 2026 audit fix).`,
        })
        await tx.auditLog.create({
          data: {
            userId: null,
            action: "UPDATE",
            entityType: "FinanceEntry",
            entityId: undo.id,
            createdAt,
            success: true,
            hash: stampHash(last?.hash ?? null, { createdAt, userId: null, action: "UPDATE", entityType: "FinanceEntry", entityId: undo.id, newValue, success: true }),
            oldValue: JSON.stringify({ account: "BANK", bankAccountId: undo.bankAccountId }),
            newValue,
            branchId: undo.branchId,
            risk: "HIGH",
          },
        })
      })
    }
    moved += 1
  }
  console.log(
    moved === 0 ? "  None." : apply ? `  Moved ${moved} line(s) to the till.` : `  ${moved} line(s). Run with --apply to move them to the till.`
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
