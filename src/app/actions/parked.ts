"use server"

import { prisma } from "@/lib/prisma"
import { requireUser } from "@/lib/session"
import { alertWatchers, writeAudit } from "@/lib/audit"
import { scopedBranchId } from "@/lib/rbac"
import { canReachBranch } from "@/lib/branch-scope"

const SIT_MS = 2 * 60 * 60 * 1000
const VANISH_GRACE_MS = 90 * 1000

export async function heartbeatParkedSales(input: {
  deviceId: string
  rows: Array<{ id: string; queuedAt: string; branchId: string; itemCount: number; paidAmount: number }>
}) {
  const user = await requireUser()
  const deviceId = input.deviceId.slice(0, 80)
  if (!deviceId) return { vanished: 0, sitting: 0 }
  const now = new Date()
  const seen = new Set(input.rows.slice(0, 200).map((row) => String(row.id || "").slice(0, 80)))
  const fallbackShop =
    user.branchId ||
    (await prisma.branch.findFirst({ where: { isActive: true }, orderBy: { isHq: "desc" }, select: { id: true } }))?.id ||
    ""

  // The device sends its own list, so nothing in it is trusted: a row is
  // only ever this person's, on a shop they can reach, and a refresh can
  // never touch another person's parked sale (turning a vanished one back to
  // parked would hide the alert it raised).
  const rows = input.rows.slice(0, 200)
  for (const row of rows) {
    const id = String(row.id || "").slice(0, 80)
    if (!id) continue
    const asked = row.branchId || fallbackShop
    const shopId = asked && (await canReachBranch(user, asked)) ? asked : fallbackShop
    if (!shopId) continue
    const queuedAt = new Date(row.queuedAt)
    const payload = JSON.stringify({
      itemCount: Math.max(0, Math.floor(Number(row.itemCount) || 0)),
      paidAmount: Math.max(0, Number(row.paidAmount) || 0),
    })
    const touched = await prisma.parkedSale.updateMany({
      where: { id, userId: user.id, deviceId },
      data: { lastSeenAt: now, status: "PARKED", payload },
    })
    if (touched.count > 0) continue
    // Someone else's id, or this person's from another device: leave it alone.
    if (await prisma.parkedSale.findUnique({ where: { id }, select: { id: true } })) continue
    await prisma.parkedSale.create({
      data: {
        id,
        userId: user.id,
        branchId: shopId,
        deviceId,
        queuedAt: Number.isNaN(queuedAt.getTime()) ? now : queuedAt,
        lastSeenAt: now,
        status: "PARKED",
        payload,
      },
    })
  }

  const missing = await prisma.parkedSale.findMany({
    where: {
      userId: user.id,
      deviceId,
      status: "PARKED",
      id: { notIn: seen.size ? [...seen] : ["__none__"] },
      lastSeenAt: { lt: new Date(now.getTime() - VANISH_GRACE_MS) },
    },
  })

  for (const row of missing) {
    await prisma.parkedSale.update({
      where: { id: row.id },
      data: { status: "VANISHED" },
    })
    await writeAudit({
      userId: user.id,
      action: "DELETE",
      entityType: "ParkedSale",
      entityId: row.id,
      newValue: JSON.stringify({ result: "vanished", queuedAt: row.queuedAt, deviceId }),
      branchId: row.branchId,
      success: false,
      risk: "HIGH",
    })
    await alertWatchers(
      "A waiting sale disappeared",
      `${user.name ?? user.email} had a waiting sale from ${row.queuedAt.toLocaleString("en-NG")}. It is no longer on that phone. Open Who did what.`,
      "/audit?risk=HIGH"
    )
  }

  const sitting = await prisma.parkedSale.findMany({
    where: {
      status: "PARKED",
      queuedAt: { lt: new Date(now.getTime() - SIT_MS) },
      alertedAt: null,
    },
  })
  for (const row of sitting) {
    await prisma.parkedSale.update({ where: { id: row.id }, data: { alertedAt: now } })
    await alertWatchers(
      "A waiting sale has waited too long",
      `A sale parked at ${row.queuedAt.toLocaleString("en-NG")} has still not gone into the system. Money may be in the drawer with no invoice.`,
      "/pos"
    )
    await writeAudit({
      userId: row.userId,
      action: "UPDATE",
      entityType: "ParkedSale",
      entityId: row.id,
      newValue: JSON.stringify({ result: "sitting", queuedAt: row.queuedAt }),
      branchId: row.branchId,
      risk: "HIGH",
    })
  }

  return { vanished: missing.length, sitting: sitting.length }
}

export async function markParkedPosted(offlineId: string, saleId: string) {
  const user = await requireUser()
  if (!offlineId || !saleId) return
  // Only a real sale, in a shop this person can reach, can close a parked one,
  // and only that shop's parked sale. Otherwise anyone could mark another
  // shop's parked sale as posted and hide it from "vanished from a device".
  const sale = await prisma.sale.findUnique({ where: { id: saleId }, select: { branchId: true } })
  if (!sale || !(await canReachBranch(user, sale.branchId))) return
  await prisma.parkedSale.updateMany({
    where: { id: offlineId, branchId: sale.branchId },
    data: { status: "POSTED", postedSaleId: saleId, lastSeenAt: new Date() },
  })
}

export async function getParkedWatch() {
  const user = await requireUser()
  const branchId = await scopedBranchId(user.role, user.branchId)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const sitFrom = new Date(Date.now() - SIT_MS)
  const where = branchId ? { branchId } : {}
  const [sitting, vanished, parked] = await Promise.all([
    prisma.parkedSale.count({ where: { ...where, status: "PARKED", queuedAt: { lt: sitFrom } } }),
    prisma.parkedSale.count({ where: { ...where, status: "VANISHED", updatedAt: { gte: weekAgo } } }),
    prisma.parkedSale.count({ where: { ...where, status: "PARKED" } }),
  ])
  return { sitting, vanished, parked }
}
