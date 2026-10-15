import type { ProductCondition } from "@prisma/client"
import { SHOP_CONDITION_OPTIONS, parseShopCondition } from "@/lib/conditions"

/**
 * What staff fill on a supplier bill line, separate from the product name.
 * The name stays the model. Condition, storage, cost, and quantity sit beside it.
 */
export const BILL_CONDITION_OPTIONS = SHOP_CONDITION_OPTIONS

export const STORAGE_OPTIONS = ["32GB", "64GB", "128GB", "256GB", "512GB", "1TB", "2TB"] as const

export function mapBillCondition(raw?: string | null): ProductCondition | null {
  if (!raw?.trim()) return null
  return parseShopCondition(raw)
}

export function normalizeStorage(raw?: string | null): string {
  const trimmed = (raw || "").trim()
  if (!trimmed) return ""
  const compact = trimmed.toUpperCase().replace(/\s+/g, "")
  if (compact === "1TERABYTE" || compact === "1TB" || compact === "1024GB") return "1TB"
  if (compact === "2TERABYTE" || compact === "2TB" || compact === "2048GB") return "2TB"
  // "1TB GB" on a sheet: the TB already says it.
  const tera = compact.match(/^(\d+)TB(GB)?$/)
  if (tera) return `${tera[1]}TB`
  if (/^\d+GB$/.test(compact)) return compact
  if (/^\d+$/.test(compact)) return `${compact}GB`
  return trimmed
}
