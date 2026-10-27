import { SHOP_CONDITION_OPTIONS, shopConditionLabel } from "@/lib/conditions"
import { formatCondition } from "@/lib/status"

/**
 * How the phone looks when it is booked into the shop.
 * Same list as Add item and Upload stock.
 */
export const PHONE_LOOK_OPTIONS = SHOP_CONDITION_OPTIONS

export type PhoneLookValue = (typeof PHONE_LOOK_OPTIONS)[number]["value"]

export function phoneLookLabel(value?: string | null) {
  return shopConditionLabel(value) || formatCondition(value)
}

/**
 * A Faulty look or item condition. Sell now no longer uses this: a phone is
 * sellable while it is In shop, and Set Damaged is what takes it off.
 */
export function isFaultyBlocked(value?: string | null) {
  return String(value || "").trim().toUpperCase() === "FAULTY"
}

export function isBlockedFromSell(opts: {
  cosmeticGrade?: string | null
  productCondition?: string | null
}) {
  return isFaultyBlocked(opts.cosmeticGrade) || isFaultyBlocked(opts.productCondition)
}
