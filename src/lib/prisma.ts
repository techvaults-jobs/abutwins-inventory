import { PrismaClient } from "@prisma/client"
import { inferRisk, requestContext, stampHash, userIdFromCreate } from "@/lib/audit-meta"
import { recordKindLabel } from "@/lib/shop-speak"

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

const base =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  })

export const prisma = base.$extends({
  query: {
    auditLog: {
      async create({ args, query }) {
        const ctx = await requestContext()
        const data = args.data
        const createdAt = data.createdAt ? new Date(data.createdAt as Date) : new Date()
        const action = String(data.action)
        const entityType = String(data.entityType ?? "")
        const success = data.success !== false
        const last = await base.auditLog.findFirst({
          orderBy: { createdAt: "desc" },
          select: { hash: true },
        })
        args.data = {
          ...data,
          createdAt,
          ipAddress: data.ipAddress ?? ctx.ip,
          userAgent: data.userAgent ?? ctx.userAgent,
          path: data.path ?? ctx.path,
          success,
          risk: data.risk ?? inferRisk({ action, entityType, success, createdAt }),
          hash: stampHash(last?.hash ?? null, {
            createdAt,
            userId: userIdFromCreate(data),
            action,
            entityType,
            entityId: String(data.entityId ?? ""),
            newValue: typeof data.newValue === "string" ? data.newValue : null,
            success,
          }),
        }
        const saved = await query(args)
        void watchMainAdmin(args.data as WatchedRow)
        return saved
      },
    },
  },
}) as unknown as PrismaClient

type WatchedRow = {
  userId?: string | null
  user?: { connect?: { id?: string } }
  action?: unknown
  entityType?: unknown
  entityId?: unknown
  newValue?: unknown
  success?: boolean
  risk?: unknown
}

/**
 * The main admin holds full control of the system, under the CEO's watch.
 * Every move is already in Who did what; the high-risk ones (removals,
 * downloads, staff, access, settings, day closes, approvals) and every cost
 * change also land on the CEO's alerts as they happen, as does a branch
 * manager's cost change. Best effort: an alert
 * that fails never touches the work it reports on.
 */
async function watchMainAdmin(row: WatchedRow) {
  try {
    const action = String(row.action ?? "")
    if (row.success === false || action === "VIEW" || action === "LOGIN" || action === "LOGOUT" || action === "DENIED") return
    const newValue = typeof row.newValue === "string" ? row.newValue : ""
    const costChange = row.entityType === "Product" && newValue.includes("costPrice")
    if (row.risk !== "HIGH" && !costChange) return
    const userId = userIdFromCreate(row)
    if (!userId) return
    const actor = await base.user.findUnique({ where: { id: userId }, select: { role: true, name: true, email: true } })
    // A branch manager also sets prices (PRICE_SETTER_ROLES). Their cost
    // changes go to the CEO and the main admin, so a cost moved in one shop is
    // seen by the people who answer for the whole business.
    if (actor?.role === "BRANCH_MANAGER" && costChange) {
      const watchers = await base.user.findMany({
        where: { role: { in: ["CEO", "SUPER_ADMIN"] }, isActive: true },
        select: { id: true },
      })
      if (watchers.length === 0) return
      let note = ""
      try {
        note = String(JSON.parse(newValue)?.note ?? "")
      } catch {}
      await base.notification.createMany({
        data: watchers.map((watcher) => ({
          userId: watcher.id,
          type: "SYSTEM" as const,
          title: "Branch manager changed a cost price",
          message: note
            ? `${actor.name || actor.email} changed a cost price. ${note}`
            : `${actor.name || actor.email} changed a cost price${row.entityId ? ` (${String(row.entityId).slice(0, 60)})` : ""}.`,
          actionUrl: "/audit?role=BRANCH_MANAGER",
        })),
      })
      return
    }
    if (actor?.role !== "SUPER_ADMIN") return
    const ceos = await base.user.findMany({ where: { role: "CEO", isActive: true }, select: { id: true } })
    if (ceos.length === 0) return
    const verb: Record<string, string> = {
      DELETE: "removed",
      UPDATE: "changed",
      CREATE: "added",
      EXPORT: "downloaded",
      IMPORT: "imported",
      APPROVE: "approved",
      REJECT: "rejected",
    }
    const kind = recordKindLabel(String(row.entityType ?? ""))
    const what = costChange ? "changed a cost price" : `${verb[action] ?? action.toLowerCase()} ${kind.toLowerCase()}`
    await base.notification.createMany({
      data: ceos.map((ceo) => ({
        userId: ceo.id,
        type: "SYSTEM" as const,
        title: action === "DELETE" ? "Main admin removed something" : "Main admin activity",
        message: `${actor.name || actor.email} ${what}${row.entityId ? ` (${String(row.entityId).slice(0, 60)})` : ""}.`,
        actionUrl: "/audit?role=SUPER_ADMIN",
      })),
    })
  } catch {
    // Watching must never break the work being watched.
  }
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = base
}
