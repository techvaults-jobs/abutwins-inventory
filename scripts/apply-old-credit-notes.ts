/**
 * Bring credit notes issued before the till could spend them into the
 * customer's balance.
 *
 * Until now a credit note return wrote a ₦0 line in the customer's money
 * history ("Credit note for ₦X ... to use on a later purchase") and left the
 * balance alone, so nothing knew we owed the customer. The balance now goes
 * below zero by the credit note, and the till offers it as a way to pay.
 *
 * This lists every such credit note, what the customer's balance is, and what
 * it becomes. With --apply it moves each balance and writes one line in the
 * customer's money history and one in Who did what. It never touches money
 * entries, stock or sales. Running it twice changes nothing the second time.
 *
 * A credit note the shop already honoured by hand (a discount, cash) must be
 * left out: pass its return number with --skip.
 *
 *   npx tsx scripts/apply-old-credit-notes.ts                          # dry run
 *   npx tsx scripts/apply-old-credit-notes.ts --apply
 *   npx tsx scripts/apply-old-credit-notes.ts --apply --skip RTN-A,RTN-B
 */
import { PrismaClient } from "@prisma/client"
import { stampHash } from "../src/lib/audit-meta"

const prisma = new PrismaClient()
const apply = process.argv.includes("--apply")
const skipAt = process.argv.indexOf("--skip")
const skip = new Set(skipAt >= 0 ? String(process.argv[skipAt + 1] ?? "").split(",").map((v) => v.trim()).filter(Boolean) : [])
const naira = (value: number) => `₦${value.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const n = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100
const DONE = "Credit note now counts in the balance"

async function main() {
  const lines = await prisma.ledgerEntry.findMany({
    where: { type: "CREDIT_NOTE", amount: 0, reference: { startsWith: "RTN-" }, description: { startsWith: "Credit note for" } },
    select: { id: true, customerId: true, reference: true, description: true, createdAt: true, customer: { select: { name: true, branchId: true, currentBalance: true } } },
    orderBy: { createdAt: "asc" },
  })
  const done = new Set(
    (
      await prisma.ledgerEntry.findMany({
        where: { type: "ADJUSTMENT", description: { startsWith: DONE }, reference: { in: lines.map((row) => row.reference!) } },
        select: { reference: true },
      })
    ).map((row) => row.reference)
  )

  const plan: Array<{ line: (typeof lines)[number]; value: number }> = []
  for (const line of lines) {
    if (done.has(line.reference)) continue
    const found = (line.description ?? "").match(/^Credit note for ₦([\d,]+(?:\.\d+)?)/)
    const value = found ? n(found[1].replace(/,/g, "")) : 0
    if (value <= 0) {
      console.log(`${line.reference}: could not read the amount from "${line.description}". Left alone.`)
      continue
    }
    plan.push({ line, value })
  }

  const balanceAfter = new Map<string, number>()
  console.log(`${lines.length} old credit note line(s); ${done.size} already counted; ${plan.length} to bring in.\n`)
  for (const { line, value } of plan) {
    const before = balanceAfter.get(line.customerId) ?? n(line.customer.currentBalance)
    const skipped = skip.has(line.reference!)
    const after = skipped ? before : n(before - value)
    balanceAfter.set(line.customerId, after)
    console.log(
      `${line.reference} · ${line.createdAt.toISOString().slice(0, 10)} · ${line.customer.name} · credit ${naira(value)} · balance ${naira(before)} → ${naira(after)}${skipped ? " · SKIPPED (--skip)" : ""}`
    )
  }
  const todo = plan.filter(({ line }) => !skip.has(line.reference!))
  if (!todo.length) return
  if (!apply) {
    console.log("\nDry run. Nothing was changed. Add --apply to bring these credit notes into the balances.")
    return
  }

  for (const { line, value } of todo) {
    await prisma.$transaction(async (tx) => {
      const already = await tx.ledgerEntry.findFirst({ where: { type: "ADJUSTMENT", reference: line.reference, description: { startsWith: DONE } }, select: { id: true } })
      if (already) return
      const updated = await tx.customer.update({
        where: { id: line.customerId },
        data: { currentBalance: { decrement: value } },
        select: { currentBalance: true },
      })
      await tx.ledgerEntry.create({
        data: {
          customerId: line.customerId,
          type: "ADJUSTMENT",
          amount: (-value).toFixed(2),
          balance: n(updated.currentBalance).toFixed(2),
          reference: line.reference,
          description: `${DONE}: we owe them ${naira(value)}, to spend at the till`,
        },
      })
      // Stamped into Who did what's hash chain the same way lib/prisma does.
      const last = await tx.auditLog.findFirst({ orderBy: { createdAt: "desc" }, select: { hash: true } })
      const createdAt = new Date()
      const newValue = JSON.stringify({
        creditNote: value,
        balance: n(updated.currentBalance),
        note: `Credit note ${line.reference} for ${naira(value)} brought into ${line.customer.name}'s balance so the till can use it. No money, stock or sale changed.`,
      })
      await tx.auditLog.create({
        data: {
          userId: null,
          action: "UPDATE",
          entityType: "Customer",
          entityId: line.customerId,
          createdAt,
          success: true,
          hash: stampHash(last?.hash ?? null, { createdAt, userId: null, action: "UPDATE", entityType: "Customer", entityId: line.customerId, newValue, success: true }),
          newValue,
          branchId: line.customer.branchId,
          risk: "MEDIUM",
        },
      })
    })
    console.log(`brought in ${line.reference}: ${naira(value)} for ${line.customer.name}`)
  }
  console.log(`\nDone. ${todo.length} credit note(s) now count in the balances.`)
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
