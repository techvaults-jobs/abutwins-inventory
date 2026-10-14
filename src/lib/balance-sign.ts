import { formatCurrency } from "@/lib/utils"

/**
 * One way to write an account balance, for customers and suppliers alike,
 * the way the client reads them:
 *
 *   ₦1,400,000   they owe us (no sign: the client asked for no plus)
 *   −₦1,400,000  we owe them (a credit note, a send-back surplus)
 *
 * `theyOweUs` is the balance seen from our side: above zero when the other
 * party owes us, below zero when we owe them.
 */
export function formatSignedBalance(theyOweUs: number) {
  const value = Math.round(theyOweUs * 100) / 100
  if (value > 0.005) return formatCurrency(value)
  if (value < -0.005) return `−${formatCurrency(-value)}`
  return formatCurrency(0)
}

/** The words that go under a signed balance. */
export function balanceMeaning(theyOweUs: number, them = "they") {
  if (theyOweUs > 0.005) return `${them[0].toUpperCase()}${them.slice(1)} owe${them === "they" ? "" : "s"} us`
  if (theyOweUs < -0.005) return `We owe ${them === "they" ? "them" : them}`
  return "Nothing owed either way"
}
