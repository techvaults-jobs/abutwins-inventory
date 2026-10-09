"use server"

import { AuditAction, UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { can } from "@/lib/permissions"
import { requireUser } from "@/lib/session"
import { verifyAuditChain, writeAudit } from "@/lib/audit"
import { isAfterHours } from "@/lib/audit-meta"
import { formatRecordChange, pageNameFromPath, recordKindLabel } from "@/lib/shop-speak"
import { statusLabel } from "@/lib/status"
import { isWatDayKey, watBounds } from "@/lib/lagos-day"

export type AuditFilters = {
  q?: string
  action?: string
  risk?: string
  userId?: string
  /** Only this job's work, e.g. SUPER_ADMIN to watch the main admin. */
  role?: string
  result?: string
  from?: string
  to?: string
  views?: string
}

function whereFrom(filters: AuditFilters) {
  const createdAt =
    filters.from || filters.to
      ? {
          // Lagos days, not the server's: a day starts at midnight in the shop.
          ...(filters.from && isWatDayKey(filters.from) ? { gte: watBounds(filters.from).start } : {}),
          ...(filters.to && isWatDayKey(filters.to) ? { lt: watBounds(filters.to).end } : {}),
        }
      : undefined
  const action =
    filters.action
      ? { action: filters.action as AuditAction }
      : filters.views === "1"
        ? {}
        : { action: { not: "VIEW" as const } }

  return {
    ...action,
    ...(filters.risk ? { risk: filters.risk } : {}),
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.role && (Object.values(UserRole) as string[]).includes(filters.role)
      ? { user: { role: filters.role as UserRole } }
      : {}),
    ...(filters.result === "failed" ? { success: false } : filters.result === "ok" ? { success: true } : {}),
    ...(filters.q
      ? {
          OR: [
            { entityId: { contains: filters.q } },
            { entityType: { contains: filters.q } },
            { newValue: { contains: filters.q } },
            { path: { contains: filters.q } },
            { user: { name: { contains: filters.q } } },
            { user: { email: { contains: filters.q } } },
          ],
        }
      : {}),
    ...(createdAt ? { createdAt } : {}),
  }
}

export async function getAuditMonitor(filters: AuditFilters = {}) {
  const user = await requireUser()
  if (!(await can(user.role, "view.audit"))) {
    return {
      logs: [],
      staff: [],
      watch: { failedLogins: 0, highRisk: 0, exports: 0, denied: 0, afterHours: 0, screens: 0, mainAdmin: 0, removals: 0 },
      activity: [],
      integrity: { ok: true, checked: 0, brokenAt: null as string | null },
    }
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const [logs, staff, failedLogins, highRisk, exports, denied, screens, weekLogs, integrity, mainAdmin, removals] = await Promise.all([
    prisma.auditLog.findMany({
      where: whereFrom(filters),
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { createdAt: "desc" },
      take: 250,
    }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
    prisma.auditLog.count({ where: { action: "LOGIN", success: false, createdAt: { gte: dayAgo } } }),
    prisma.auditLog.count({ where: { risk: "HIGH", createdAt: { gte: dayAgo } } }),
    prisma.auditLog.count({ where: { action: "EXPORT", createdAt: { gte: weekAgo } } }),
    prisma.auditLog.count({ where: { action: "DENIED", createdAt: { gte: dayAgo } } }),
    prisma.auditLog.count({ where: { action: "VIEW", createdAt: { gte: dayAgo } } }),
    prisma.auditLog.findMany({
      where: { createdAt: { gte: weekAgo }, action: { not: "VIEW" } },
      select: { userId: true, user: { select: { name: true } }, createdAt: true, risk: true },
    }),
    verifyAuditChain(),
    prisma.auditLog.count({
      where: { user: { role: "SUPER_ADMIN" }, action: { notIn: ["VIEW", "LOGIN", "LOGOUT"] }, createdAt: { gte: weekAgo } },
    }),
    // Every removal by anyone: items, brands, banks, payments, opening stock.
    prisma.auditLog.count({ where: { action: "DELETE", success: true, createdAt: { gte: weekAgo } } }),
  ])

  const afterHours = weekLogs.filter((row) => isAfterHours(row.createdAt)).length
  const activityMap = new Map<string, { name: string; count: number; high: number }>()
  for (const row of weekLogs) {
    const key = row.userId ?? "unknown"
    const current = activityMap.get(key) ?? { name: row.user?.name ?? "Unknown sign-in", count: 0, high: 0 }
    current.count += 1
    if (row.risk === "HIGH") current.high += 1
    activityMap.set(key, current)
  }

  return {
    logs: logs.map((log) => ({
      id: log.id,
      when: log.createdAt,
      who: log.user?.name ?? "Unknown sign-in",
      email: log.user?.email ?? log.entityId,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      change: log.newValue ?? log.oldValue,
      ip: log.ipAddress,
      path: log.path,
      success: log.success,
      risk: log.risk,
      afterHours: isAfterHours(log.createdAt),
    })),
    staff,
    watch: { failedLogins, highRisk, exports, denied, afterHours, screens, mainAdmin, removals },
    activity: [...activityMap.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    integrity,
  }
}

export async function exportAuditCsv(filters: AuditFilters) {
  const user = await requireUser()
  if (!(await can(user.role, "view.audit"))) return { error: "You are not allowed to download this trail. Ask the main admin." }
  const rows = await prisma.auditLog.findMany({
    where: whereFrom({ ...filters, views: "1" }),
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 2000,
  })
  await writeAudit({
    userId: user.id,
    action: "EXPORT",
    entityType: "AuditLog",
    entityId: `rows-${rows.length}`,
    newValue: JSON.stringify({ filters, count: rows.length }),
    branchId: user.branchId,
  })
  const header = "When,Who,Email,Action,Result,Risk,Record,Number,Page,Device,What changed"
  const lines = rows.map((row) =>
    [
      row.createdAt.toISOString(),
      csv(row.user?.name ?? "Unknown"),
      csv(row.user?.email ?? ""),
      csv(statusLabel(row.action)),
      row.success ? "Worked" : "Failed",
      csv(statusLabel(row.risk)),
      csv(recordKindLabel(row.entityType)),
      csv(row.entityId.startsWith("c") ? "" : row.entityId),
      csv(pageNameFromPath(row.path) ?? ""),
      csv(row.ipAddress ?? ""),
      csv(formatRecordChange(row.newValue ?? row.oldValue)),
    ].join(",")
  )
  return { success: true, csv: [header, ...lines].join("\n") }
}

function csv(value: string) {
  if (!/[",\n]/.test(value)) return value
  return `"${value.replaceAll("\"", "\"\"")}"`
}

export async function syncOfflineTrail(input: {
  events: Array<{ id: string; at: string; kind: string; detail?: Record<string, unknown> }>
  postedInvoices?: string[]
}) {
  const user = await requireUser()
  if (!input.events.length && !input.postedInvoices?.length) return { success: true }
  const down = input.events.find((event) => event.kind === "LINE_DOWN")
  const back = [...input.events].reverse().find((event) => event.kind === "LINE_BACK")
  await writeAudit({
    userId: user.id,
    action: "IMPORT",
    entityType: "Offline",
    entityId: down?.id ?? input.events[0]?.id ?? `sync-${Date.now()}`,
    newValue: JSON.stringify({
      lineDownAt: down?.at ?? null,
      lineBackAt: back?.at ?? new Date().toISOString(),
      parkedSales: input.events.filter((event) => event.kind === "SALE_PARKED").length,
      postedInvoices: input.postedInvoices ?? [],
      events: input.events,
    }),
    branchId: user.branchId,
    risk: "HIGH",
  })
  return { success: true }
}
