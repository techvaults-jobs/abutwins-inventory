import type { Prisma } from "@prisma/client"
import { MARKED_PAID_ON_UPLOAD, OPENING_STOCK_METHOD, isOpeningStockSupplierName } from "@/lib/upload-purchase"
import { displayPartyName, partyNameKey } from "@/lib/party-key"
import { formatCurrency, money } from "@/lib/utils"

/**
 * Opening stock is the shop's starting value. It is never money owed.
 * True opening bills are OPEN- invoices or rows with an OpeningStock record.
 * A supplier carton loaded on Upload stock is a normal bill, even when its
 * source is UPLOAD_STOCK.
 */
export function isOpeningStockPurchase(row: {
  invoiceNumber?: string | null
  notes?: string | null
  openingStock?: unknown
  supplier?: { name: string } | null
}): boolean {
  if (row.openingStock) return true
  if (String(row.invoiceNumber || "").startsWith("OPEN-")) return true
  if (row.supplier && isOpeningStockSupplierName(row.supplier.name)) return true
  return isTrueOpeningStockNotes(row.notes)
}

export function isTrueOpeningStockNotes(notes?: string | null) {
  const text = notes ?? ""
  return /opening stock/i.test(text) && /not a supplier bill/i.test(text)
}

/** +₦x when the house owes Abu Twins after stock return. */
export function formatValueOwingPlus(amount: number) {
  const n = Math.max(0, Number(amount) || 0)
  return n > 0 ? `+${formatCurrency(n)}` : formatCurrency(0)
}

/** -₦x when Abu Twins still owes the house. */
export function formatValueOwingMinus(amount: number) {
  const n = Math.max(0, Number(amount) || 0)
  return n > 0 ? `-${formatCurrency(n)}` : formatCurrency(0)
}

/** Balance cell: surplus as +, still owed as -. */
export function formatPurchaseBalanceCell(owed: number, surplus: number) {
  if (surplus > 0) return formatValueOwingPlus(surplus)
  if (owed > 0) return formatValueOwingMinus(owed)
  return formatCurrency(0)
}

/** What is still owed, or surplus the supplier owes us, after send-backs. */
export function purchaseBalance(total: unknown, paid: unknown, returned: unknown = 0) {
  const billed = money(total)
  const paidVal = money(paid)
  const sentBack = money(returned)
  const remaining = Math.max(0, billed - sentBack)
  const net = remaining - paidVal
  return {
    billed,
    paid: paidVal,
    sentBack,
    remaining,
    owed: Math.max(0, net),
    surplus: Math.max(0, -net),
  }
}

/**
 * A supplier named for opening stock ("Opening Stock", "OPENING STOCK
 * (FAULTY)", "opening-stock" ...) is never a real house to owe. Same rule as
 * isOpeningStockSupplierName, written for the database.
 */
export const openingStockSupplierWhere: Prisma.SupplierWhereInput = {
  OR: [
    { name: { contains: "opening stock", mode: "insensitive" } },
    { name: { contains: "opening-stock", mode: "insensitive" } },
    { name: { contains: "opening_stock", mode: "insensitive" } },
  ],
}

/**
 * The one rule for "this bill is opening stock": the shop's starting value,
 * never money owed. An OPEN- bill, a bill with an OpeningStock record, or any
 * bill under an opening stock supplier name, however it was loaded (Upload
 * stock, a supplier bill or a sheet). Home, Suppliers, Reports and the
 * healing of opening bills all use this, so they cannot disagree.
 */
const OPENING_STOCK_BILL: Prisma.PurchaseWhereInput[] = [
  { invoiceNumber: { startsWith: "OPEN-" } },
  { openingStock: { isNot: null } },
  { supplier: openingStockSupplierWhere },
]

/** Prisma filter: supplier bills that can still be owed (everything that is not opening stock). */
export const payablePurchaseWhere: Prisma.PurchaseWhereInput = {
  status: { not: "CANCELLED" },
  NOT: { OR: OPENING_STOCK_BILL },
}

/**
 * Prisma filter: opening stock bills. The shop's starting stock value, shown
 * against its supplier ("Opening Stock", "Opening Stock (Faulty)", ...) as a
 * value, never as money owed. Same three rules as healOpeningStockBills, and
 * the exact opposite of what payablePurchaseWhere lets through.
 */
export const openingStockPurchaseWhere: Prisma.PurchaseWhereInput = {
  status: { not: "CANCELLED" },
  OR: OPENING_STOCK_BILL,
}

/**
 * Read the paid / unpaid state written on an Upload stock carton bill.
 * Heal used to overwrite every upload as opening stock. These notes are how
 * we put the real balance back.
 */
export function paymentFromUploadNotes(notes: string | null | undefined, total: number): {
  method: string
  paid: number
} {
  const text = notes ?? ""
  const totalSafe = money(total)
  if (isTrueOpeningStockNotes(text)) {
    return { method: OPENING_STOCK_METHOD, paid: totalSafe }
  }
  const partial = text.match(/partial payment of\s*₦?\s*([\d,]+(?:\.\d+)?)/i)
  if (partial) {
    const paid = money(Number(String(partial[1]).replace(/,/g, "")))
    return { method: "PARTIAL_PAYMENT", paid: Math.min(Math.max(0, paid), totalSafe) }
  }
  if (/unpaid invoice/i.test(text) || /not paid yet/i.test(text) || /nothing paid/i.test(text)) {
    return { method: "UNPAID", paid: 0 }
  }
  if (/paid in full/i.test(text) || /paid when the stock was loaded/i.test(text)) {
    return { method: "PAID_ON_UPLOAD", paid: totalSafe }
  }
  if (/marked as paid/i.test(text)) {
    return { method: MARKED_PAID_ON_UPLOAD, paid: totalSafe }
  }
  if (/\bpaid\b/i.test(text) && !/unpaid/i.test(text) && !/not paid/i.test(text) && !/partial/i.test(text)) {
    return { method: "PAID_ON_UPLOAD", paid: totalSafe }
  }
  return { method: "UNPAID", paid: 0 }
}

export type OwedBill = {
  id: string
  invoice: string
  supplier: string
  shop: string
  owed: number
}

export type OwedHouse = {
  key: string
  name: string
  owed: number
  bills: OwedBill[]
}

/** One house, then the bills inside it. IRIS and iris become one row. */
export function groupOwedHouses(rows: OwedBill[]): OwedHouse[] {
  const houses = new Map<string, OwedHouse>()
  for (const row of rows) {
    const key = partyNameKey(row.supplier) || displayPartyName(row.supplier) || row.id
    const existing = houses.get(key)
    if (existing) {
      existing.owed += row.owed
      existing.bills.push(row)
    } else {
      houses.set(key, {
        key,
        name: displayPartyName(row.supplier) || row.supplier,
        owed: row.owed,
        bills: [row],
      })
    }
  }
  return [...houses.values()].sort((a, b) => b.owed - a.owed || a.name.localeCompare(b.name))
}

export type SupplierLedgerBill = {
  supplierId: string
  supplierName: string
  creditBalance?: unknown
  totalAmount: unknown
  paidAmount: unknown
  returnedAmount?: unknown
}

export type SupplierLedger = {
  id: string
  name: string
  billed: number
  paid: number
  sentBack: number
  extraCredit: number
  owed: number
  surplus: number
}

/** One house: bills netted, then any leftover send-back credit that was not on a bill. */
export function groupSupplierLedgers(bills: SupplierLedgerBill[]): SupplierLedger[] {
  const houses = new Map<
    string,
    {
      id: string
      name: string
      bills: SupplierLedgerBill[]
      credits: Map<string, number>
    }
  >()
  for (const bill of bills) {
    const key = partyNameKey(bill.supplierName) || displayPartyName(bill.supplierName) || bill.supplierId
    const existing = houses.get(key)
    const credit = money(bill.creditBalance)
    if (existing) {
      existing.bills.push(bill)
      if (!existing.credits.has(bill.supplierId)) existing.credits.set(bill.supplierId, credit)
    } else {
      houses.set(key, {
        id: bill.supplierId,
        name: displayPartyName(bill.supplierName) || bill.supplierName,
        bills: [bill],
        credits: new Map([[bill.supplierId, credit]]),
      })
    }
  }
  return [...houses.values()]
    .map((house) => {
      let billed = 0
      let paid = 0
      let sentBack = 0
      let net = 0
      for (const bill of house.bills) {
        const bal = purchaseBalance(bill.totalAmount, bill.paidAmount, bill.returnedAmount)
        billed += bal.billed
        paid += bal.paid
        sentBack += bal.sentBack
        net += bal.remaining - bal.paid
      }
      const extraCredit = [...house.credits.values()].reduce((sum, value) => sum + value, 0)
      net -= extraCredit
      return {
        id: house.id,
        name: house.name,
        billed,
        paid,
        sentBack,
        extraCredit,
        owed: Math.max(0, net),
        surplus: Math.max(0, -net),
      }
    })
    .sort((a, b) => b.owed - a.owed || b.surplus - a.surplus || a.name.localeCompare(b.name))
}

/**
 * How a payment on a supplier bill is written in the money ledger, followed by
 * the bill number. Money in and out reads it back to tell a supplier paid in
 * cash (already out of the till) from one paid by bank.
 */
export const SUPPLIER_PAYMENT_NOTE = "Supplier payment "
