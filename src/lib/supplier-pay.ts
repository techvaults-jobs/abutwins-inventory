import type { UserRole } from "@prisma/client"
import { canReachBranch, viewBranchFilter } from "@/lib/branch-scope"
import { prisma } from "@/lib/prisma"

type Payer = { id: string; role: UserRole; branchId: string | null }

/** A supplier is paid by bank transfer or in cash. Nothing else. */
export const SUPPLIER_PAY_METHODS = ["TRANSFER", "CASH"] as const
export type SupplierPayMethod = (typeof SUPPLIER_PAY_METHODS)[number]

export type PayingBank = { id: string; label: string; branchId: string }

/** How an undone supplier payment is written in the money ledger. */
export const SUPPLIER_PAYMENT_UNDO_NOTE = "Undid a payment to the supplier"

export function bankLabel(bank: { bankName: string; accountNumber: string; accountName?: string | null }) {
  return `${bank.bankName} ${bank.accountNumber}${bank.accountName ? ` · ${bank.accountName}` : ""}`
}

/** The named bank accounts this person may pay a supplier from. */
export async function listPayingBanks(user: Payer): Promise<PayingBank[]> {
  const branchId = await viewBranchFilter(user)
  const banks = await prisma.bankAccount.findMany({
    where: { isActive: true, ...(branchId ? { branchId } : {}) },
    select: { id: true, bankName: true, accountNumber: true, accountName: true, branchId: true },
    orderBy: [{ bankName: "asc" }, { accountNumber: "asc" }],
  })
  return banks.map((bank) => ({ id: bank.id, label: bankLabel(bank), branchId: bank.branchId }))
}

/**
 * Where a supplier payment leaves from. Cash leaves the till. A transfer
 * must name the bank account it left, so the money shows against that
 * account on Money in and out instead of against no bank at all.
 */
export async function resolveSupplierPayChannel(
  user: Payer,
  methodRaw: string,
  bankAccountIdRaw: string
): Promise<{ method: SupplierPayMethod; account: "CASH" | "BANK"; bankAccountId: string | null; from: string } | { error: string }> {
  const method = methodRaw.trim().toUpperCase()
  if (method === "CASH") return { method: "CASH", account: "CASH", bankAccountId: null, from: "cash" }
  if (method !== "TRANSFER") return { error: "A supplier is paid by transfer or in cash. Pick one of the two." }
  const bankAccountId = bankAccountIdRaw.trim()
  if (!bankAccountId) return { error: "Pick the bank account the transfer was sent from." }
  const bank = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, isActive: true },
    select: { id: true, bankName: true, accountNumber: true, accountName: true, branchId: true },
  })
  if (!bank) return { error: "That bank account is not on the list any more. Pick another one." }
  if (!(await canReachBranch(user, bank.branchId))) return { error: "That bank account belongs to another shop. Pick one of yours." }
  return { method: "TRANSFER", account: "BANK", bankAccountId: bank.id, from: bankLabel(bank) }
}
