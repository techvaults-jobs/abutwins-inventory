import { cache } from "react"
import { UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { canSeeProfit, isCEO, isShopOwner, PROFIT_ROLES } from "@/lib/roles"

export { isSuperAdmin, isShopOwner, isCEO, isBooksDesk, BOOKS_DESK_ROLES } from "@/lib/roles"

export const VIEW_PERMS = [
  { key: "view.dashboard", label: "Home", href: "/dashboard" },
  { key: "view.owner", label: "Business today", href: "/owner" },
  { key: "view.uploads", label: "Upload stock", href: "/uploads" },
  { key: "view.products", label: "Phones & items", href: "/products" },
  { key: "view.imei", label: "Phone numbers (IMEI)", href: "/imei" },
  { key: "view.inventory", label: "Shop stock", href: "/inventory" },
  { key: "view.incoming", label: "Goods on the way", href: "/incoming" },
  { key: "view.sales", label: "Sales", href: "/sales" },
  { key: "view.pos", label: "Sell now", href: "/pos" },
  { key: "view.purchases", label: "Goods from supplier", href: "/purchases" },
  { key: "view.customers", label: "Customers & money owed", href: "/customers" },
  { key: "view.suppliers", label: "Suppliers", href: "/suppliers" },
  { key: "view.transfers", label: "Shop to shop", href: "/transfers" },
  { key: "view.returns", label: "Returns", href: "/returns" },
  { key: "view.swaps", label: "Swap Deal", href: "/swaps" },
  { key: "view.repairs", label: "Repairs", href: "/repairs" },
  { key: "view.reconciliation", label: "Stock count", href: "/reconciliation" },
  { key: "view.finance", label: "Money in & out", href: "/finance" },
  { key: "view.expenses", label: "Shop expenses", href: "/expenses" },
  { key: "view.approvals", label: "Needs approval", href: "/approvals" },
  { key: "view.branches", label: "Shops", href: "/branches" },
  { key: "view.staff", label: "Staff", href: "/staff" },
  { key: "view.access", label: "Who can see what", href: "/staff/access" },
  { key: "view.profits", label: "Profit", href: "/profits" },
  { key: "view.reports", label: "Reports", href: "/reports" },
  { key: "view.audit", label: "Who did what", href: "/audit" },
  { key: "view.notifications", label: "Alerts", href: "/notifications" },
  { key: "view.settings", label: "Settings", href: "/settings" },
] as const

export const ACTION_PERMS = [
  { key: "action.sell", label: "Sell and take payment" },
  { key: "action.catalog", label: "Add items, brands and categories" },
  { key: "action.add_item", label: "Add new item names (branch managers also price them; anyone else waits for a price setter)" },
  { key: "action.upload", label: "Upload stock from a sheet or supplier bill" },
  { key: "action.intake", label: "Put one phone on the shelf" },
  { key: "action.incoming", label: "Book goods on the way" },
  { key: "action.transfer", label: "Send and receive shop to shop" },
  { key: "action.return", label: "Take a return" },
  { key: "action.swap", label: "Record a Swap Deal" },
  { key: "action.repair", label: "Open and move a repair" },
  { key: "action.recon", label: "Send a stock count" },
  { key: "action.approve", label: "Say yes or no to waiting work" },
  { key: "action.finance", label: "Post expenses and pay suppliers" },
  { key: "action.deposit", label: "Move cash from the till to the bank" },
  { key: "action.staff", label: "Add and edit staff" },
  { key: "action.settings", label: "Change shop settings" },
  { key: "action.all_branches", label: "See every shop" },
  { key: "action.override_floor", label: "Sell below the lowest allowed price" },
  { key: "action.see_cost", label: "See what an item cost us while selling" },
] as const

export const ALL_PERM_KEYS = [...VIEW_PERMS, ...ACTION_PERMS].map((row) => row.key)

/**
 * Profit, and what items cost us, fixed in code for PROFIT_ROLES (the CEO, the
 * main admin and the books desk). They are not boxes on Who can see what, and
 * no other role gets them from a database row. See canSeeProfit and
 * canSeeCost in lib/roles.
 */
export const CEO_ONLY_KEYS: readonly string[] = ["view.profits", "action.see_cost"]
// Named for history: these are the profit keys, held by PROFIT_ROLES (the CEO
// the main admin and the books desk), decided in code by canSeeProfit, never by a box.

const ALL = ALL_PERM_KEYS

const V = (...keys: string[]) => keys

/**
 * Full shop oversight for the Internal Auditor (admin-style view of every page).
 * They may post money and see every shop. They may not sell, load stock, approve
 * floor work, or open Who can see what.
 */
export const AUDITOR_KEYS = V(
  ...VIEW_PERMS.filter((row) => row.key !== "view.access" && !CEO_ONLY_KEYS.includes(row.key)).map((row) => row.key),
  "action.finance",
  "action.all_branches"
)

/**
 * Money and books only for the Financial Accountant. The left menu must not show
 * till, repairs, stock load, or other floor jobs they cannot run.
 */
export const ACCOUNTANT_KEYS = V(
  "view.dashboard",
  "view.owner",
  "view.sales",
  "view.customers",
  "view.suppliers",
  "view.purchases",
  "view.products",
  "view.imei",
  "view.inventory",
  "view.finance",
  "view.expenses",
  "view.reports",
  "view.audit",
  "view.notifications",
  "view.branches",
  "action.finance",
  "action.deposit",
  "action.all_branches"
)

/** @deprecated Prefer AUDITOR_KEYS or ACCOUNTANT_KEYS. Kept for older call sites. */
export const BOOKS_DESK_KEYS = AUDITOR_KEYS

const DEFAULTS: Record<UserRole, string[]> = {
  // The main admin and the CEO run the shop together: every screen and job.
  // Profit and cost prices included. Nobody can secretly rewrite an old invoice.
  SUPER_ADMIN: ALL,
  CEO: ALL,
  AUDITOR: AUDITOR_KEYS,
  ACCOUNTANT: ACCOUNTANT_KEYS,
  BRANCH_MANAGER: V(
    "view.dashboard", "view.owner", "view.products", "view.uploads", "view.imei", "view.inventory", "view.incoming", "view.sales", "view.pos",
    "view.purchases", "view.customers", "view.suppliers", "view.transfers", "view.returns",
    "view.swaps", "view.repairs", "view.reconciliation", "view.finance", "view.expenses",
    "view.approvals", "view.staff", "view.reports", "view.notifications",
    "action.sell", "action.upload", "action.intake", "action.incoming", "action.transfer",
    "action.return", "action.swap", "action.repair", "action.recon", "action.approve", "action.finance", "action.deposit", "action.staff", "action.add_item"
  ),
  VAULT_MANAGER: V(
    "view.dashboard", "view.products", "view.uploads", "view.imei", "view.inventory", "view.incoming", "view.purchases",
    "view.suppliers", "view.transfers", "view.notifications",
    "action.upload", "action.intake", "action.incoming", "action.transfer"
  ),
  STOCK_UPLOADER: V(
    "view.dashboard", "view.uploads", "view.products", "view.imei", "view.inventory", "view.purchases", "view.notifications",
    "action.upload", "action.intake", "action.catalog", "action.all_branches"
  ),
  CASHIER: V(
    "view.dashboard", "view.pos", "view.sales", "view.customers", "view.expenses", "view.finance", "view.returns", "view.notifications",
    "action.sell", "action.return", "action.finance"
  ),
  SALES_EXECUTIVE: V(
    "view.dashboard", "view.pos", "view.sales", "view.customers", "view.products", "view.expenses", "view.finance", "view.returns", "view.notifications",
    "action.sell", "action.return", "action.finance"
  ),
  ENGINEER: V(
    "view.dashboard", "view.imei", "view.repairs", "view.returns", "view.customers", "view.notifications",
    "action.repair", "action.return"
  ),
}

const ROLE_LIST = Object.keys(DEFAULTS) as UserRole[]
const EXPECTED_ROWS = ROLE_LIST.length * ALL_PERM_KEYS.length

/**
 * Fill in any permission row a new release added. The common case is that
 * nothing is missing, so that case costs one cheap count instead of reading the
 * whole table. Wrapped in cache() so it runs once per request no matter how many
 * screens and buttons ask what this member of staff may do.
 */
export const ensureRolePermissions = cache(async () => {
  if ((await prisma.rolePermission.count()) < EXPECTED_ROWS) {
    const existing = await prisma.rolePermission.findMany({ select: { role: true, permKey: true } })
    const have = new Set(existing.map((row) => `${row.role}:${row.permKey}`))
    const missing = ROLE_LIST.flatMap((role) =>
      ALL_PERM_KEYS.filter((permKey) => !have.has(`${role}:${permKey}`)).map((permKey) => ({
        role,
        permKey,
        allowed: DEFAULTS[role].includes(permKey),
      }))
    )
    if (missing.length) await prisma.rolePermission.createMany({ data: missing })
  }

  // Small shops: cashier and sales also record expenses and call people who still
  // owe us. Turn those doors on even if an older install left them closed.
  await prisma.rolePermission.updateMany({
    where: {
      role: { in: ["CASHIER", "SALES_EXECUTIVE"] },
      permKey: { in: ["view.expenses", "view.finance", "view.customers", "action.finance"] },
      allowed: false,
    },
    data: { allowed: true },
  })

  // Sales reps log returns for phones they sold. Older installs left this shut.
  await prisma.rolePermission.updateMany({
    where: {
      role: "SALES_EXECUTIVE",
      permKey: { in: ["view.returns", "action.return"] },
      allowed: false,
    },
    data: { allowed: true },
  })

  // Goods intake and shop managers must be able to load stock both ways:
  // many phones from Excel, and one phone after another on a supplier bill.
  await prisma.rolePermission.updateMany({
    where: {
      role: { in: ["BRANCH_MANAGER", "VAULT_MANAGER", "STOCK_UPLOADER"] },
      permKey: { in: ["view.uploads", "action.upload", "action.intake", "view.imei", "view.products", "view.inventory"] },
      allowed: false,
    },
    data: { allowed: true },
  })

  // The CEO and the main admin hold every box. can() already lets them
  // through; opening the rows keeps Who can see what showing the same thing.
  await prisma.rolePermission.updateMany({
    where: { role: { in: ["CEO", "SUPER_ADMIN"] }, allowed: false },
    data: { allowed: true },
  })

  // Profit and cost prices belong to PROFIT_ROLES. can() already refuses them to
  // everyone else; closing the rows keeps menus and Who can see what honest.
  await prisma.rolePermission.updateMany({
    where: { role: { notIn: [...PROFIT_ROLES] }, permKey: { in: [...CEO_ONLY_KEYS] }, allowed: true },
    data: { allowed: false },
  })
  await prisma.rolePermission.updateMany({
    where: { role: { in: [...PROFIT_ROLES] }, permKey: { in: [...CEO_ONLY_KEYS] }, allowed: false },
    data: { allowed: true },
  })


  // Internal Auditor: full shop oversight on the left menu (every page except
  // Who can see what). Floor actions stay closed.
  const auditorViews = VIEW_PERMS.filter((row) => row.key !== "view.access" && !CEO_ONLY_KEYS.includes(row.key)).map(
    (row) => row.key
  )
  await prisma.rolePermission.updateMany({
    where: {
      role: "AUDITOR",
      permKey: { in: [...auditorViews, "action.finance", "action.all_branches"] },
      allowed: false,
    },
    data: { allowed: true },
  })
  await prisma.rolePermission.updateMany({
    where: {
      role: "AUDITOR",
      permKey: {
        in: [
          "view.access",
          "action.sell",
          "action.catalog",
          "action.upload",
          "action.intake",
          "action.incoming",
          "action.transfer",
          "action.return",
          "action.swap",
          "action.repair",
          "action.recon",
          "action.approve",
          "action.staff",
          "action.settings",
          "action.override_floor",
        ],
      },
      allowed: true,
    },
    data: { allowed: false },
  })

  // Financial Accountant: money and books only. Close till, Sell now, repairs,
  // stock load, and other floor pages so the left menu matches the job.
  await prisma.rolePermission.updateMany({
    where: {
      role: "ACCOUNTANT",
      permKey: { in: ACCOUNTANT_KEYS },
      allowed: false,
    },
    data: { allowed: true },
  })
  // Profit and cost are decided in code (canSeeProfit), so they are left out here.
  const accountantDenied = ALL_PERM_KEYS.filter((key) => !ACCOUNTANT_KEYS.includes(key) && !CEO_ONLY_KEYS.includes(key))
  await prisma.rolePermission.updateMany({
    where: {
      role: "ACCOUNTANT",
      permKey: { in: accountantDenied },
      allowed: true,
    },
    data: { allowed: false },
  })

  // Purge permission rows for keys that no longer exist in the system
  // (e.g. action.neighbor and view.neighbor-fills from the deleted NeighborFill
  // feature). Stale allowed=true rows for removed features can mislead Who can
  // see what and leave dead menu links for staff.
  await prisma.rolePermission.deleteMany({
    where: { permKey: { notIn: ALL_PERM_KEYS } },
  })
})

/**
 * Every allowed permission, for every role, in one read. Checking a single role
 * at a time meant a fresh query for each button on the page; a whole page load
 * used to run a dozen of them. cache() holds the answer for this one request
 * only, so a change on Who can see what still shows up on the next page.
 */
const loadPermissionMap = cache(async () => {
  await ensureRolePermissions()
  const rows = await prisma.rolePermission.findMany({
    select: { role: true, permKey: true, allowed: true },
  })
  // A role that appears here has been set up, even if every box is unticked.
  // That is different from a role nobody has touched yet, so both are tracked:
  // unticking everything must lock the role out, not quietly hand back the
  // permissions it shipped with.
  const map = new Map<UserRole, Set<string>>()
  for (const row of rows) {
    const set = map.get(row.role) ?? new Set<string>()
    if (row.allowed) set.add(row.permKey)
    map.set(row.role, set)
  }
  return map
})

export async function getAllowedKeys(role: UserRole) {
  if (isCEO(role)) return new Set(ALL_PERM_KEYS)
  // The main admin holds every box, profit included.
  if (role === "SUPER_ADMIN") return new Set(ALL_PERM_KEYS)
  const map = await loadPermissionMap()
  // No rows at all means Who can see what has never been set up for this role,
  // so fall back to what it ships with rather than locking the person out.
  // Handed back as a copy: the map is held for the whole request, and a caller
  // that added to it would change what everyone else on the page is allowed.
  const allowed = new Set(map.get(role) ?? DEFAULTS[role] ?? [])
  for (const key of CEO_ONLY_KEYS) {
    if (canSeeProfit(role)) allowed.add(key)
    else allowed.delete(key)
  }
  if (isShopOwner(role)) allowed.add("view.access")
  return allowed
}

export async function can(role: UserRole, key: string) {
  if (isCEO(role)) return true
  if (CEO_ONLY_KEYS.includes(key)) return canSeeProfit(role)
  if (role === "SUPER_ADMIN") return true
  // Undoing a collection or a supplier payment: the CEO and the main admin.
  if (key === "action.undo") return false
  if (key === "view.access") return isShopOwner(role)
  const allowed = await getAllowedKeys(role)
  return allowed.has(key)
}

export async function canUndo(role: UserRole) {
  return isShopOwner(role)
}

export function viewKeyForPath(pathname: string) {
  const match = VIEW_PERMS
    .slice()
    .sort((a, b) => b.href.length - a.href.length)
    .find((row) => pathname === row.href || pathname.startsWith(`${row.href}/`))
  return match?.key ?? "view.dashboard"
}

export function hrefsForKeys(keys: Set<string>) {
  const hrefs: string[] = VIEW_PERMS.filter((row) => keys.has(row.key)).map((row) => row.href)
  // Close the day sits under Money in & out / Sell now for till staff.
  if ((keys.has("view.finance") || keys.has("view.pos")) && !hrefs.includes("/finance/close")) {
    hrefs.push("/finance/close")
  }
  // Check the books is an audit paper. Do not unlock it just because someone
  // can open Money in & out (cashiers must not see that left-menu item).
  // It is a money paper too, so it also needs a door to the money.
  if (
    keys.has("view.audit") &&
    (keys.has("view.finance") || keys.has("view.reports")) &&
    !hrefs.includes("/audit/books")
  ) {
    hrefs.push("/audit/books")
  }
  // Opening stock correction belongs to stock load / CEO-admin work, not every
  // person who can open Reports.
  if (keys.has("view.uploads") && !hrefs.includes("/opening-stock")) {
    hrefs.push("/opening-stock")
  }
  if (!hrefs.includes("/help")) hrefs.push("/help")
  return hrefs
}

export { pathIsAllowed } from "@/lib/access-path"

export function firstAllowedHref(keys: Set<string>) {
  return hrefsForKeys(keys)[0] || "/login"
}

export { DEFAULTS }
