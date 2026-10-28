"use server"

import { prisma } from "@/lib/prisma"
import { requireUser } from "@/lib/session"
import { can } from "@/lib/permissions"
import { scopedBranchId } from "@/lib/rbac"
import { viewBranchFilter } from "@/lib/branch-scope"
import { asReportRange, reportPeriodWindow, watDayKey } from "@/lib/lagos-day"
import { backfillSupplierReturnLines, moneyEffectWords } from "@/lib/supplier-returns"
import { money } from "@/lib/utils"

export type SupplierReturnRow = {
  id: string
  reference: string
  sentAt: string
  supplier: string
  shop: string
  shopCode: string
  item: string
  imei: string
  bill: string | null
  value: number
  effect: string
  source: "SEND_BACK" | "CUSTOMER_RETURN"
  by: string
}

/**
 * Returns outward for Reports: every unit sent back to a supplier in the
 * period, for the shop in view, newest first. Managers follow up with the
 * supplier from this: what went back, how many, to whom, and the value.
 */
export async function getSupplierReturnsReport(requestedBranchId?: string, range?: string, businessDate?: string, fromDate?: string) {
  const user = await requireUser()
  if (!(await can(user.role, "view.reports"))) return { rows: [] as SupplierReturnRow[], from: "", to: "" }
  await backfillSupplierReturnLines()

  const scoped = await scopedBranchId(user.role, user.branchId, requestedBranchId)
  const branchId = scoped || requestedBranchId || (await viewBranchFilter(user))
  const day = businessDate && /^\d{4}-\d{2}-\d{2}$/.test(businessDate) ? businessDate : watDayKey()
  const period = reportPeriodWindow(day, asReportRange(range), fromDate)

  const lines = await prisma.supplierReturnLine.findMany({
    where: { sentAt: { gte: period.start, lt: period.end }, ...(branchId ? { branchId } : {}) },
    include: {
      supplier: { select: { name: true } },
      branch: { select: { name: true, code: true } },
      product: { select: { name: true, storage: true } },
      imei: { select: { imei1: true, serialNumber: true } },
      purchase: { select: { invoiceNumber: true } },
      user: { select: { name: true, email: true } },
    },
    orderBy: { sentAt: "desc" },
  })

  const rows: SupplierReturnRow[] = lines.map((line) => ({
    id: line.id,
    reference: line.reference,
    sentAt: line.sentAt.toISOString(),
    supplier: line.supplier.name,
    shop: line.branch.name,
    shopCode: line.branch.code,
    item:
      line.product.storage && !line.product.name.toLowerCase().includes(line.product.storage.toLowerCase())
        ? `${line.product.name} ${line.product.storage}`
        : line.product.name,
    imei:
      line.imei.serialNumber && line.imei.serialNumber !== line.imei.imei1
        ? `${line.imei.imei1} · ${line.imei.serialNumber}`
        : line.imei.imei1,
    bill: line.purchase?.invoiceNumber ?? null,
    value: money(line.cost),
    effect: moneyEffectWords(line.moneyEffect),
    source: line.source === "CUSTOMER_RETURN" ? "CUSTOMER_RETURN" : "SEND_BACK",
    by: line.user?.name || line.user?.email || "—",
  }))
  return { rows, from: period.from, to: period.to }
}

/**
 * Full all-time supplier returns history for the dedicated history page.
 * No date cap — returns every SupplierReturnLine the shop has, newest first,
 * scoped to the branch the user may see. Managers use this to audit every
 * send-back, see totals per supplier, and export the complete record to Excel.
 */
export async function getSupplierReturnsHistory(requestedBranchId?: string) {
  const user = await requireUser()
  if (!(await can(user.role, "view.purchases"))) return { rows: [] as SupplierReturnRow[] }
  await backfillSupplierReturnLines()

  const scoped = await scopedBranchId(user.role, user.branchId, requestedBranchId)
  const branchId = scoped || requestedBranchId || (await viewBranchFilter(user))

  const lines = await prisma.supplierReturnLine.findMany({
    where: branchId ? { branchId } : undefined,
    include: {
      supplier: { select: { name: true } },
      branch:   { select: { name: true, code: true } },
      product:  { select: { name: true, storage: true } },
      imei:     { select: { imei1: true, serialNumber: true } },
      purchase: { select: { invoiceNumber: true } },
      user:     { select: { name: true, email: true } },
    },
    orderBy: { sentAt: "desc" },
  })

  const rows: SupplierReturnRow[] = lines.map((line) => ({
    id: line.id,
    reference: line.reference,
    sentAt: line.sentAt.toISOString(),
    supplier: line.supplier.name,
    shop: line.branch.name,
    shopCode: line.branch.code,
    item:
      line.product.storage &&
      !line.product.name.toLowerCase().includes(line.product.storage.toLowerCase())
        ? `${line.product.name} ${line.product.storage}`
        : line.product.name,
    imei:
      line.imei.serialNumber && line.imei.serialNumber !== line.imei.imei1
        ? `${line.imei.imei1} · ${line.imei.serialNumber}`
        : line.imei.imei1,
    bill: line.purchase?.invoiceNumber ?? null,
    value: money(line.cost),
    effect: moneyEffectWords(line.moneyEffect),
    source: line.source === "CUSTOMER_RETURN" ? "CUSTOMER_RETURN" : "SEND_BACK",
    by: line.user?.name || line.user?.email || "—",
  }))

  return { rows }
}
