import Link from "next/link"
import { closeDay, getDayClosePreview, getDayCloses } from "@/app/actions/day-close"
import { getBranches } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { PageHeader } from "@/components/shared"
import { Input } from "@/components/ui/input"
import { requireUser } from "@/lib/session"
import { viewBranchFilter } from "@/lib/branch-scope"
import { watDayKey } from "@/lib/lagos-day"
import { formatCurrency, formatDate } from "@/lib/utils"
import { formatCondition } from "@/lib/status"
import { Store, CheckCircle2, AlertTriangle, ArrowLeft, ArrowRight, Calendar, Download } from "lucide-react"

export default async function DayClosePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; branchId?: string }>
}) {
  const user = await requireUser()
  const activeBranch = await viewBranchFilter(user)
  const params = await searchParams
  const today = watDayKey()
  const date = params.date
  const selectedBranchId = params.branchId || activeBranch || undefined

  const [preview, closes, branches] = await Promise.all([
    getDayClosePreview(selectedBranchId, date),
    getDayCloses(selectedBranchId),
    getBranches(),
  ])

  const isViewingToday = preview.businessDate === today
  const totalReceived = preview.expectedCash + preview.transferTotal + preview.posTotal

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader
          title="Balance the till"
          description="Count the money for a shop day and agree it with the system. Selling never waits for this — balance today, or go back and settle a day you missed."
        />
        <Link
          href="/finance"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Money in & out
        </Link>
      </div>

      {/* Branch Selector for Multi-Shop / Admin Users */}
      {branches.length > 1 && !user.branchId && (
        <div className="surface-card p-4 flex flex-wrap items-center justify-between gap-3 border-primary/20 bg-muted/20">
          <div className="flex items-center gap-2">
            <Store className="h-4 w-4 text-primary" />
            <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Which shop are you balancing?</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {branches.map((b) => {
              const isCurrent = preview.branchId === b.id
              return (
                <Link
                  key={b.id}
                  href={`/finance/close?branchId=${b.id}${date ? `&date=${date}` : ""}`}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                    isCurrent
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-background border border-border text-foreground hover:bg-muted"
                  }`}
                >
                  {b.name} ({b.code})
                </Link>
              )
            })}
          </div>
        </div>
      )}

      {/* Unclosed Days Warning Banner or Date Switcher */}
      {preview.unclosed.length ? (
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm text-foreground">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 font-bold text-warning">
              <AlertTriangle className="h-4 w-4" />
              <span>
                {preview.unclosed.length} day(s) still to balance {preview.branchName ? `for ${preview.branchName}` : ""}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              The shop keeps selling either way. Settle them when you can.
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Select date:</span>
            <Link
              href={`/finance/close?branchId=${preview.branchId}&date=${today}`}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                isViewingToday
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-background border border-border text-foreground hover:bg-muted"
              }`}
            >
              📅 Today ({today}) {isViewingToday ? " (Active)" : ""}
            </Link>
            {preview.unclosed.map((day) => (
              <Link
                key={day}
                href={`/finance/close?branchId=${preview.branchId}&date=${day}`}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                  day === preview.businessDate
                    ? "bg-warning text-black font-bold shadow-sm"
                    : "bg-background border border-warning/40 text-foreground hover:bg-warning/20"
                }`}
              >
                ⚠️ {day} {day === preview.businessDate ? " (Active)" : ""}
              </Link>
            ))}
          </div>
        </div>
      ) : !isViewingToday ? (
        <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-primary" />
            <span>
              Viewing records for past day: <strong>{preview.businessDate}</strong>
            </span>
          </div>
          <Link
            href={`/finance/close?branchId=${preview.branchId}&date=${today}`}
            className="text-primary font-semibold hover:underline"
          >
            Switch to Today&apos;s sales ({today}) →
          </Link>
        </div>
      ) : null}

      {/* Overview Metric Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="surface-card p-5 border-l-4 border-l-primary bg-primary/5">
          <p className="text-xs font-bold uppercase tracking-wider text-primary">Total sales for the day</p>
          <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(preview.totalSales)}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {preview.saleCount} {preview.saleCount === 1 ? "sale" : "sales"} · {preview.branchName} · {preview.businessDate}
          </p>
        </div>
        <div className="surface-card p-5 border-l-4 border-l-emerald-500">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cash received (Expected in till)</p>
          <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(preview.expectedCash)}</p>
          <p className="text-xs text-muted-foreground mt-1">Physical cash taken in today</p>
        </div>
        <div className="surface-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bank received</p>
          <p className="mt-2 text-2xl font-bold tabular-nums text-foreground">{formatCurrency(preview.transferTotal + preview.posTotal)}</p>
          <p className="text-xs text-muted-foreground mt-1">Transfer, POS terminal, and other bank channels counted as Bank</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-xs">
        <span className="font-semibold text-foreground">
          Total payments received today (Cash + Bank):
        </span>
        <span className="font-bold tabular-nums text-sm text-primary">
          {formatCurrency(totalReceived)}
        </span>
      </div>

      {preview.creditTotal > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-200 flex items-center justify-between">
          <span>Part payment / credit sales balance left unpaid today:</span>
          <span className="font-bold tabular-nums text-sm">{formatCurrency(preview.creditTotal)}</span>
        </div>
      ) : null}

      {preview.onOlderSalesTotal > 0 ? (
        <details className="rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-xs">
          <summary className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-muted-foreground">
              Of the money taken today, this was owed on goods that left on an earlier day:
            </span>
            <span className="font-bold tabular-nums text-sm">
              {formatCurrency(preview.onOlderSalesTotal)}
            </span>
          </summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {preview.onOlderSales.slice(0, 12).map((row, index) => (
              <li key={`${row.invoice}-${index}`} className="flex justify-between gap-3">
                <span>
                  {row.invoice} · {row.customer} · sold {row.soldOn} ·{" "}
                  {row.method === "CASH" ? "cash" : "bank"}
                </span>
                <span className="tabular-nums">{formatCurrency(row.amount)}</span>
              </li>
            ))}
            {preview.onOlderSales.length > 12 ? (
              <li>and {preview.onOlderSales.length - 12} more</li>
            ) : null}
          </ul>
          <p className="mt-2 text-muted-foreground">
            This money is counted in today&apos;s till because today is when it was handed over. It is
            not part of today&apos;s sales figure.
          </p>
        </details>
      ) : null}

      {preview.otherMoneyInTotal > 0 ? (
        <details className="rounded-lg border border-border bg-muted/40 px-4 py-2.5 text-xs">
          <summary className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-muted-foreground">
              Also taken today on no sale (paid on account, or on a replacement):
            </span>
            <span className="font-bold tabular-nums text-sm">{formatCurrency(preview.otherMoneyInTotal)}</span>
          </summary>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            {preview.otherMoneyIn.slice(0, 12).map((row, index) => (
              <li key={`${row.reference}-${index}`} className="flex justify-between gap-3">
                <span>
                  {row.what || row.reference} · {row.method === "CASH" ? "cash" : "bank"}
                </span>
                <span className="tabular-nums">{formatCurrency(row.amount)}</span>
              </li>
            ))}
            {preview.otherMoneyIn.length > 12 ? <li>and {preview.otherMoneyIn.length - 12} more</li> : null}
          </ul>
          <p className="mt-2 text-muted-foreground">
            This money is in the cash and bank figures above. It is not part of today&apos;s sales figure.
          </p>
        </details>
      ) : null}

      {/* Till Count Form or Closed Notice */}
      {preview.alreadyClosed ? (
        <div className="surface-card p-6 border-success/30 bg-success-soft">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 text-success font-bold">
              <CheckCircle2 className="h-5 w-5" />
              <span>This day is counted and balanced</span>
            </div>
            {preview.closedRecord ? (
              <span className="text-xs text-muted-foreground">
                Closed by <strong>{preview.closedRecord.closedBy}</strong> on {formatDate(preview.closedRecord.closeDate)}
              </span>
            ) : null}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-4 pt-3 border-t border-success/20">
            <div>
              <p className="text-xs text-muted-foreground uppercase font-semibold">Total sales for the day</p>
              <p className="text-lg font-bold font-mono">{formatCurrency(preview.totalSales)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase font-semibold">Cash expected</p>
              <p className="text-lg font-bold font-mono">{formatCurrency(preview.closedRecord?.expectedCash ?? preview.expectedCash)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase font-semibold">Cash remitted</p>
              <p className="text-lg font-bold font-mono text-primary">{formatCurrency(preview.closedRecord?.countedCash ?? 0)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase font-semibold">Shortage / Overage</p>
              <p className="text-lg font-bold font-mono">
                <span
                  className={`inline-block rounded-md px-2 py-0.5 text-xs font-bold ${
                    (preview.closedRecord?.variance ?? 0) === 0
                      ? "bg-success-soft text-success"
                      : (preview.closedRecord?.variance ?? 0) < 0
                      ? "bg-danger-soft text-danger"
                      : "bg-warning-soft text-warning"
                  }`}
                >
                  {(preview.closedRecord?.variance ?? 0) === 0
                    ? "Balanced (₦0.00)"
                    : (preview.closedRecord?.variance ?? 0) < 0
                    ? `Shortage: ${formatCurrency(preview.closedRecord?.variance ?? 0)}`
                    : `Overage: +${formatCurrency(preview.closedRecord?.variance ?? 0)}`}
                </span>
              </p>
            </div>
          </div>
          {preview.closedRecord && preview.closedRecord.cashDrift !== 0 ? (
            <p className="mt-3 rounded border border-warning/30 bg-warning-soft p-2.5 text-xs text-warning">
              <span className="font-semibold">
                The cash for this day has changed since it was counted.
              </span>{" "}
              It was closed against {formatCurrency(preview.closedRecord.expectedCash)}, and the day
              now stands at {formatCurrency(preview.closedRecord.liveExpectedCash)} — a difference of{" "}
              {formatCurrency(Math.abs(preview.closedRecord.cashDrift))}. The shortage or overage
              above was worked out on the older figure. Money taken later on a sale from this day is
              counted on the day it was received, so check that day&apos;s count too.
            </p>
          ) : null}
          {preview.closedRecord?.notes ? (
            <p className="mt-3 text-xs text-muted-foreground bg-background/50 p-2.5 rounded border border-border/50">
              <span className="font-semibold">Note:</span> {preview.closedRecord.notes}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="surface-card p-6 border-primary/20">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4 border-b border-border pb-3">
            <div>
              <h3 className="font-bold text-base">
                {preview.expectedCash > 0
                  ? `Count cash to remit — ${preview.branchName || "Shop"} (${preview.businessDate})`
                  : `Balance the till — ${preview.branchName || "Shop"} (${preview.businessDate})`}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {preview.expectedCash > 0
                  ? "Count the physical cash inside the till drawer. Remit this cash and enter the amount below."
                  : "No cash came in on this day. Bank money needs no till count, so this day balances on its own."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary">
                Total sales for the day: {formatCurrency(preview.totalSales)}
              </div>
              <div className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                Cash expected: {formatCurrency(preview.expectedCash)}
              </div>
            </div>
          </div>

          <ActionForm
            action={closeDay}
            submit={preview.expectedCash > 0 ? "Count is correct, balance this day" : "Balance this day"}
            className="space-y-4"
          >
            <input type="hidden" name="branchId" value={preview.branchId} />
            <input type="hidden" name="businessDate" value={preview.businessDate} />
            {preview.expectedCash > 0 ? (
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block mb-1.5">
                  Cash remitted (Money counted in the till) (₦) *
                </label>
                <Input
                  name="countedCash"
                  type="number"
                  step="any"
                  defaultValue={preview.expectedCash}
                  required
                  className="min-h-12 text-lg font-mono font-bold"
                  placeholder="Type the cash remitted"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  The physical cash handed over or remitted from the drawer. When balanced, this matches the cash sales of {formatCurrency(preview.expectedCash)}.
                </p>
              </div>
            ) : (
              <input type="hidden" name="countedCash" value="0" />
            )}
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground block mb-1.5">
                Note (optional)
              </label>
              <Input
                name="notes"
                placeholder={
                  preview.expectedCash > 0
                    ? "If there is a shortage or overage, say why. Example: ₦2,000 used to buy shop supplies."
                    : "Optional note for this day, for example: bank sales only."
                }
              />
            </div>
          </ActionForm>
        </div>
      )}

      {/* Sales Made On This Day - Detailed Itemized Breakdown */}
      <div className="surface-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-border">
          <div>
            <h3 className="font-bold text-base">Sales made on this day ({preview.sales.length})</h3>
            <p className="text-xs text-muted-foreground">
              Itemized sales making up the {formatCurrency(preview.totalSales)} total on {preview.businessDate}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {preview.sales.length > 0 && (
              <a
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-primary hover:bg-muted transition-colors"
                href={`data:text/csv;charset=utf-8,${encodeURIComponent(
                  [
                    "Invoice,Time,Customer,Device / Item,Storage,Condition,Color,IMEI / Serial,Qty,Unit Price,Total Price,Payment Method,Paid,Cashier",
                    ...preview.sales.flatMap((sale) =>
                      sale.items.map((it) =>
                        [
                          sale.invoiceNumber,
                          new Date(sale.saleDate).toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" }),
                          `"${sale.customer.replace(/"/g, '""')}"`,
                          `"${it.name.replace(/"/g, '""')}"`,
                          it.storage || "",
                          it.condition ? formatCondition(it.condition) : "",
                          it.color || "",
                          it.imei || it.serialNumber || "",
                          it.quantity,
                          it.unitPrice,
                          it.totalPrice,
                          sale.method,
                          sale.paid,
                          `"${sale.staff.replace(/"/g, '""')}"`,
                        ].join(",")
                      )
                    ),
                  ].join("\n")
                )}`}
                download={`sales-ledger-${preview.branchName || "shop"}-${preview.businessDate}.csv`}
              >
                <Download className="h-3.5 w-3.5" /> Download this day&apos;s sales (CSV)
              </a>
            )}
            <Link
              href="/sales"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              All sales <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground bg-muted/40 text-xs uppercase tracking-wider">
              <tr className="border-b border-border">
                <th className="px-5 py-3">Invoice</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Phones and items sold</th>
                <th className="px-4 py-3">Cashier</th>
                <th className="px-4 py-3">Paid by</th>
                <th className="px-4 py-3 text-right">Total amount</th>
                <th className="px-5 py-3 text-right">Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {preview.sales.map((sale) => (
                <tr key={sale.id} className="hover:bg-muted/30">
                  <td className="px-5 py-3 align-top">
                    <Link
                      href={`/sales/${sale.id}`}
                      className="font-mono font-bold text-primary hover:underline"
                    >
                      {sale.invoiceNumber}
                    </Link>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {new Date(sale.saleDate).toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </td>
                  <td className="px-4 py-3 font-medium align-top">{sale.customer}</td>
                  <td className="px-4 py-3 align-top">
                    <div className="space-y-1.5">
                      {sale.items.map((it) => (
                        <div key={it.id} className="text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-foreground">{it.name}</span>
                            {it.quantity > 1 ? (
                              <span className="text-muted-foreground font-mono"> × {it.quantity}</span>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
                            {it.imei ? (
                              <span className="font-mono text-primary font-medium bg-primary/5 px-1 py-0.2 rounded border border-primary/15">
                                IMEI: {it.imei}
                              </span>
                            ) : it.serialNumber ? (
                              <span className="font-mono text-muted-foreground bg-muted px-1 py-0.2 rounded">
                                SN: {it.serialNumber}
                              </span>
                            ) : null}
                            {it.storage ? (
                              <span className="inline-flex items-center px-1.5 py-0.2 rounded bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200 font-semibold text-[10px]">
                                {it.storage}
                              </span>
                            ) : null}
                            {it.condition ? (
                              <span className="inline-flex items-center px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 font-medium text-[10px]">
                                {formatCondition(it.condition)}
                              </span>
                            ) : null}
                            {it.color ? <span className="text-muted-foreground">· {it.color}</span> : null}
                          </div>
                        </div>
                      ))}
                      {sale.items.length === 0 && (
                        <span className="text-xs text-muted-foreground">{sale.itemsSummary || `${sale.itemCount} items`}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground align-top">{sale.staff}</td>
                  <td className="px-4 py-3 align-top">
                    <span
                      className={`inline-block rounded-md px-2 py-0.5 text-xs font-bold ${
                        sale.method === "CASH"
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : sale.method === "TRANSFER"
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : sale.method === "POS"
                          ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
                          : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                      }`}
                    >
                      {sale.method}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold align-top">{formatCurrency(sale.total)}</td>
                  <td className="px-5 py-3 text-right font-mono font-bold text-foreground align-top">{formatCurrency(sale.paid)}</td>
                </tr>
              ))}
              {preview.sales.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-muted-foreground">
                    No completed sales recorded on this day.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {/* Historical Closes Ledger */}
      <div className="surface-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h3 className="font-bold text-base">Days you have closed before</h3>
            <p className="text-xs text-muted-foreground">Every day close record with total sales, cash remitted, and shortage or overage</p>
          </div>
          <a
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-primary hover:bg-muted"
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(
              ["Shop day,Closed at,Shop,Total sales for the day,Cash expected,Cash remitted,Shortage or overage,Transfer,POS,Credit,How many sales,Closed by,Note", ...closes.map((row) =>
                [row.businessDate, formatDate(row.closeDate), row.branch, row.totalSales, row.expectedCash, row.countedCash, row.variance, row.transferTotal, row.posTotal, row.creditTotal, row.saleCount, `"${row.user}"`, `"${row.notes || ""}"`].join(",")
              )].join("\n")
            )}`}
            download="day-close-audits.csv"
          >
            Download as CSV
          </a>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground bg-muted/40 text-xs uppercase tracking-wider">
              <tr className="border-b border-border">
                <th className="px-5 py-3">Shop day</th>
                <th className="px-4 py-3">Shop</th>
                <th className="px-4 py-3 text-right">Total sales for the day</th>
                <th className="px-4 py-3 text-right">Cash expected</th>
                <th className="px-4 py-3 text-right">Cash remitted</th>
                <th className="px-4 py-3 text-right">Shortage / Overage</th>
                <th className="px-4 py-3">Bank</th>
                <th className="px-5 py-3">Who closed it</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {closes.map((row) => (
                <tr key={row.id} className="hover:bg-muted/30">
                  <td className="px-5 py-3 font-semibold">
                    <Link href={`/finance/close?branchId=${preview.branchId}&date=${row.businessDate}`} className="text-primary hover:underline">
                      {row.businessDate}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-medium">{row.branch}</td>
                  <td className="px-4 py-3 text-right font-mono font-bold text-foreground">{formatCurrency(row.totalSales)}</td>
                  <td className="px-4 py-3 text-right font-mono text-muted-foreground">{formatCurrency(row.expectedCash)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-primary">{formatCurrency(row.countedCash)}</td>
                  <td className="px-4 py-3 text-right font-mono">
                    <span
                      className={`inline-block rounded-md px-2 py-0.5 text-xs font-bold ${
                        row.variance === 0
                          ? "bg-success-soft text-success"
                          : row.variance < 0
                          ? "bg-danger-soft text-danger"
                          : "bg-warning-soft text-warning"
                      }`}
                    >
                      {row.variance === 0
                        ? "Balanced"
                        : row.variance < 0
                        ? `Short: ${formatCurrency(row.variance)}`
                        : `Overage: +${formatCurrency(row.variance)}`}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    Bank: {formatCurrency(row.transferTotal + row.posTotal)}
                  </td>
                  <td className="px-5 py-3 text-xs text-muted-foreground">{row.user}</td>
                </tr>
              ))}
              {closes.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-muted-foreground">No day has been closed yet.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

