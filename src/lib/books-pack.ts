import type { BooksCheck } from "@/app/actions/books-check"
import { formatWatLong } from "@/lib/lagos-day"

export function booksPeriodLabel(range: BooksCheck["range"], from: string, to: string) {
  if (range === "day") return formatWatLong(from)
  return `${formatWatLong(from)} to ${formatWatLong(to)}`
}

export function booksRangeTitle(range: BooksCheck["range"]) {
  if (range === "week") return "Check the books (last 7 days)"
  if (range === "month") return "Check the books (this month so far)"
  return "Check the books (one day)"
}

export function booksCompareRows(data: BooksCheck) {
  return [
    { label: "Total sales", now: data.revenue, then: data.compare.priorRevenue, change: data.compare.revenue, money: true },
    // Money by the day it came in, cash and bank, debts collected included.
    { label: "Total payments received", now: data.methodSum, then: data.compare.priorMethodSum, change: data.compare.methodSum, money: true },
    { label: "Cash received", now: data.cash, then: data.compare.priorCash, change: data.compare.cash, money: true },
    {
      label: "Bank received",
      now: data.transfer + data.pos,
      then: data.compare.priorTransfer + data.compare.priorPos,
      // Its own movement. It used to borrow the percentage of Total payments
      // received, so the % on this line did not match its own two figures.
      change: data.compare.bank,
      money: true,
    },
    // Unpaid on this period's sales after returns. The all-time figure is "Customers still owe, in total".
    { label: "Still owed on this period's sales", now: data.due, then: data.compare.priorDue, change: data.compare.due, money: true },
    { label: "Approved expenses", now: data.expenses, then: data.compare.priorExpenses, change: data.compare.expenses, money: true },
    {
      label: "Refunds and swap pay-outs",
      now: data.customerPayOuts,
      then: data.compare.priorCustomerPayOuts,
      change: change(data.customerPayOuts, data.compare.priorCustomerPayOuts),
      money: true,
    },
    { label: "Total expenditure", now: data.moneyOut, then: data.compare.priorMoneyOut, change: data.compare.moneyOut, money: true },
    { label: "Sales volume", now: data.salesCount, then: data.compare.priorCount, change: data.compare.count, money: false },
  ]
}


export function formatPdfMoney(value: number) {
  const n = Math.round(Number.isFinite(value) ? value : 0)
  const digits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.abs(n))
  return `${n < 0 ? "-" : ""}NGN ${digits}`
}

export function formatPdfMove(change: { amount: number; value: string }, money: boolean) {
  const amount = money ? formatPdfMoney(change.amount) : `${change.amount > 0 ? "+" : ""}${change.amount}`
  if (change.value === "0") return amount
  if (change.value === "New") return `${amount} (new)`
  return `${amount} (${change.value})`
}

function change(current: number, previous: number) {
  if (!previous) return { value: current ? "New" : "0", amount: current - previous, up: current >= previous }
  const pct = ((current - previous) / previous) * 100
  return { value: `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`, amount: current - previous, up: pct >= 0 }
}

/**
 * The money summary in three blocks, each adding up to its own total line:
 * money in by the day it came, where this period's sales stand, money out.
 *
 * It used to run them together: "Of it, on this period's sales" sat under
 * Total sales but was a share of payments received, and "Still owed" was
 * marked as a total that no line above it added up to.
 */
export function booksMoneyLines(data: BooksCheck) {
  const lines: Array<{ label: string; value: number; total: boolean; head?: boolean; minus?: boolean }> = [
    { label: "Money in, by the day it came", value: 0, total: false, head: true },
    { label: "Cash received", value: data.cash, total: false },
    { label: "Bank received", value: data.transfer + data.pos, total: false },
    { label: "Total payments received", value: data.methodSum, total: true },
    { label: "Of it, on this period's sales and replacements", value: data.methodSum - (data.debtsCollected ?? 0), total: false },
    { label: "Of it, debts collected on earlier sales", value: data.debtsCollected ?? 0, total: false },

    { label: "This period's sales", value: 0, total: false, head: true },
    { label: "Paid in cash or bank, so far", value: data.paidMoney, total: false },
    { label: "Paid from a credit note", value: data.paidCreditNote, total: false },
    { label: "Cleared by a return", value: data.clearedByReturns, total: false },
    { label: "Still owed", value: data.due, total: false },
  ]
  if (data.paidOver > 0.005) lines.push({ label: "Less paid over the bill", value: -data.paidOver, total: false, minus: true })
  lines.push(
    { label: "Total sales", value: data.revenue, total: true },

    { label: "Money out", value: 0, total: false, head: true },
    { label: "Approved expenses", value: data.expenses, total: false },
    { label: "Suppliers payment", value: data.purchasesPaid, total: false },
    { label: "Refunds and swap pay-outs", value: data.customerPayOuts, total: false },
    { label: "Total expenditure", value: data.moneyOut, total: true },
    { label: "Money in less money out", value: data.methodSum - data.moneyOut, total: true }
  )
  return lines
}

function cells(...values: unknown[]) {
  return values.map((value) => (value == null ? "" : String(value)))
}

export function booksCsvRows(data: BooksCheck): string[][] {
  const period = booksPeriodLabel(data.range, data.from, data.to)
  const compared = booksPeriodLabel(data.range, data.priorFrom, data.priorTo)
  return [
    cells(data.company.product || data.company.name),
    cells("Check the books"),
    cells("Statement number", data.statementRef),
    cells("Shop", `${data.shopName} (${data.shopCode})`),
    cells("Period", period),
    cells("Compared with", compared),
    cells("Prepared by", data.preparedBy),
    cells("Prepared at (Lagos time)", data.preparedAt),
    cells("Verdict", data.verdict),
    [],
    cells("THIS PERIOD AGAINST THE OTHER"),
    cells("Line", "This period", "Other period", "Difference (amount)", "Difference (%)"),
    ...booksCompareRows(data).map((row) => cells(row.label, row.now, row.then, row.change.amount, row.change.value)),
    [],
    cells("CHECKS"),
    cells("Check", "Status", "Notes"),
    ...data.papers.map((row) => cells(row.label, row.ok ? "Clear" : "Flag", row.detail)),
    [],
    cells("MONEY SUMMARY"),
    cells("Line", "Amount"),
    ...booksMoneyLines(data).map((row) => (row.head ? cells(row.label.toUpperCase()) : cells(row.label, row.value))),
    [],
    cells("STILL OWED"),
    cells("Customers still owe, in total", data.customersOwe),
    cells("Still owed to suppliers", data.supplierOwed),
    cells("Suppliers who owe us", data.supplierCredit),
    cells("Sales with no customer name", data.walkIns),
    [],
    cells("SALES BY STAFF"),
    cells("Staff", "Sales", "Value sold", "Paid on them so far"),
    ...data.byStaff.map((row) => cells(row.name, row.count, row.sold, row.collected)),
    [],
    cells("SALES"),
    cells("Invoice", "When", "Customer", "Staff", "Paid by", "Total", "Paid"),
    ...data.invoices.map((row) => cells(row.invoice, row.when, row.customer, row.staff, row.method, row.total, row.paid)),
    [],
    cells("IMEI VS SHOP COUNT"),
    cells("Item", "Shop", "Shop count", "IMEIs", "Gap"),
    ...data.imeiRows.map((row) => cells(row.product, row.shop, row.shopQty, row.imeis, row.delta)),
  ]
}
