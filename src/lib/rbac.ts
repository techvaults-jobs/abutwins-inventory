import type { UserRole } from "@prisma/client"
import { can } from "@/lib/permissions"
import { canChangePrices, isBooksDesk, isShopOwner } from "@/lib/roles"

export {
  isSuperAdmin,
  isShopOwner,
  isCEO,
  canSeeProfit,
  canSeeCost,
  canChangeCost,
  canChangePrices,
  canSeePriceListCost,
  PRICE_SETTER_ROLES,
  canHardDelete,
  isBooksDesk,
  booksDeskPartner,
  BOOKS_DESK_ROLES,
  ROLE_LABELS,
  canEditLetterhead,
  canSendToSupplier,
} from "@/lib/roles"

export async function canSeeAllBranches(role: UserRole) {
  return can(role, "action.all_branches")
}

export async function canManageCatalog(role: UserRole) {
  return can(role, "action.catalog")
}

/**
 * Putting a new item name on the list. Full catalog staff can, and so can a
 * role given only Add new item names. Whether they also type its prices is
 * setsStartingPrices.
 */
export async function canAddItemName(role: UserRole) {
  return (await canManageCatalog(role)) || (await can(role, "action.add_item"))
}

/**
 * May this person type the starting prices on a brand-new item? The price
 * setters (CEO, main admin, branch manager) and full catalog staff. Anyone
 * else saves the name only and the price setters are asked to price it.
 */
export async function setsStartingPrices(role: UserRole) {
  return canChangePrices(role) || (await canManageCatalog(role))
}

export async function canSell(role: UserRole) {
  return can(role, "action.sell")
}

export async function canApprove(role: UserRole) {
  return can(role, "action.approve")
}

export async function canManageFinance(role: UserRole) {
  return can(role, "action.finance")
}

/** Opening cash and named banks. Main admin, CEO, accountant, records checker. */
export function canSetOpeningMoney(role: UserRole) {
  return isShopOwner(role) || isBooksDesk(role)
}

export async function canManageStaff(role: UserRole) {
  return can(role, "action.staff")
}

export async function scopedBranchId(role: UserRole, branchId: string | null, requested?: string | null) {
  if (await canSeeAllBranches(role)) return requested ?? undefined
  return branchId ?? requested ?? undefined
}
