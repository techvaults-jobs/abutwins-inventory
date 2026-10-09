import { notFound } from "next/navigation"
import { getCustomer, getCustomerOpening } from "@/app/actions/parties"
import { collectPayment } from "@/app/actions/sales"
import { ActionForm } from "@/components/action-form"
import { CollectMoneyFields } from "@/components/collect-money-fields"
import { PageHeader, StatusBadge } from "@/components/shared"
import { formatCurrency, formatDate, money } from "@/lib/utils"
import { warrantyState } from "@/lib/warranty"
import { statusLabel } from "@/lib/status"
import { prisma } from "@/lib/prisma"
import { dueAfterReturns, returnedValueBySale } from "@/lib/returned-value"
import { cn } from "@/lib/utils"
import { OpeningBalanceCard } from "./opening-balance-card"

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [customer, opening] = await Promise.all([getCustomer(id), getCustomerOpening(id)])
  if (!customer || !opening) notFound()
  const banks = await prisma.bankAccount.findMany({
    where: { isActive: true, branchId: customer.branchId },
    orderBy: [{ bankName: "asc" }, { accountNumber: "asc" }],
    select: { id: true, bankName: true, accountNumber: true, accountName: true },
  })
  // What returns took off each invoice, so a returned sale reads as returned,
  // not as still owing.
  const returned = await returnedValueBySale(prisma, customer.sales.map((sale) => sale.id))
  // Return lines written before they were split read "Refund" even when nothing
  // was paid back. Money only left if the ledger has a pay-out for that return.
  const returnRefs = customer.ledgerEntries
    .filter((entry) => entry.type === "REFUND" && entry.reference?.startsWith("RTN-"))
    .map((entry) => entry.reference!)
  const paidBack = new Set(
    (
      await prisma.financeEntry.findMany({
        where: { reference: { in: returnRefs }, type: "EXPENSE" },
        select: { reference: true },
      })
    ).map((row) => row.reference)
  )
  const lineLabel = (entry: { type: string; reference: string | null; description: string | null }) => {
    if (entry.type === "REFUND" && entry.reference?.startsWith("RTN-") && !paidBack.has(entry.reference)) {
      return { tag: "Returned · debt cleared", tone: "text-success", note: "No money was paid out on this return." }
    }
    if (entry.type === "ADJUSTMENT" && entry.reference?.startsWith("OBAL")) {
      return { tag: "Opening balance", tone: "text-warning", note: null as string | null }
    }
    const tags: Record<string, { tag: string; tone: string }> = {
      SALE: { tag: "Bought on credit", tone: "text-warning" },
      PAYMENT: { tag: "Paid us", tone: "text-success" },
      REFUND: { tag: "Refund paid out", tone: "text-danger" },
      ADJUSTMENT: { tag: entry.reference?.startsWith("RTN-") ? "Returned" : "Adjustment", tone: "text-success" },
      CREDIT_NOTE: { tag: "Credit note", tone: "text-info" },
      DISCOUNT: { tag: "Discount", tone: "text-success" },
    }
    return { ...(tags[entry.type] ?? { tag: entry.type, tone: "text-muted-foreground" }), note: null as string | null }
  }

  return (
    <div className="space-y-6">
      <PageHeader backHref="/customers" title={customer.name} description={`${customer.phone} · ${customer.branch.name}`} />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-4">
          <div className="surface-card p-5">
            <p className="text-sm text-muted-foreground">Still owing</p>
            <p className="text-2xl font-semibold">{formatCurrency(money(customer.currentBalance))}</p>
            <p className="text-xs text-muted-foreground">Credit limit {formatCurrency(money(customer.creditLimit))}</p>
          </div>
          <OpeningBalanceCard
            customerId={customer.id}
            customerName={customer.name}
            opening={opening.amount}
            owing={money(customer.currentBalance)}
            history={opening.history}
            canChange={opening.canChange}
          />
        </div>
        <div className="surface-card self-start p-5 md:col-span-2">
          <h3 className="mb-3 font-semibold">Collect money</h3>
          <ActionForm action={collectPayment} submit="Record payment" className="grid gap-3 md:grid-cols-1 md:items-end">
            <input type="hidden" name="customerId" value={customer.id} />
            <CollectMoneyFields banks={banks} allowSplit />
          </ActionForm>
        </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="surface-card p-5">
          <h3 className="mb-4 font-semibold">Money history</h3>
          <div className="space-y-3 text-sm">
            {customer.ledgerEntries.map((entry) => {
              const label = lineLabel(entry)
              return (
              <div key={entry.id} className="flex justify-between gap-3 border-b border-border/70 pb-2">
                <div className="min-w-0">
                  <p className={cn("text-[11px] font-semibold uppercase tracking-wide", label.tone)}>{label.tag}</p>
                  <p className="font-medium">{entry.description}</p>
                  {label.note ? <p className="text-xs text-success">{label.note}</p> : null}
                  <p className="text-xs text-muted-foreground">{entry.reference} · {formatDate(entry.createdAt)}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p>{formatCurrency(money(entry.amount))}</p>
                  <p className="text-xs text-muted-foreground">Bal {formatCurrency(money(entry.balance))}</p>
                </div>
              </div>
              )
            })}
          </div>
        </div>
        <div className="surface-card p-5">
          <h3 className="mb-4 font-semibold">Purchases</h3>
          <div className="space-y-3 text-sm">
            {customer.sales.map((sale) => {
              const back = returned.get(sale.id) ?? 0
              const due = dueAfterReturns(sale, back)
              const fullyReturned = back > 0 && back >= money(sale.totalAmount) - 0.005
              return (
              <div key={sale.id} className="flex items-start justify-between gap-3 border-b border-border/70 pb-3 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <a href={`/sales/${sale.id}`} className="whitespace-nowrap font-medium text-primary hover:underline">{sale.invoiceNumber}</a>
                  <div className="mt-1">
                    <StatusBadge value={fullyReturned ? "RETURNED" : due > 0.005 ? "DUE" : "SETTLED"} />
                  </div>
                </div>
                <div className="shrink-0 text-right tabular-nums">
                  <p className="font-medium">{formatCurrency(money(sale.totalAmount))}</p>
                  {back > 0 ? <p className="text-xs text-muted-foreground">Returned {formatCurrency(back)}</p> : null}
                  {due > 0.005 ? (
                    <p className="text-xs text-warning">Still {formatCurrency(due)}</p>
                  ) : fullyReturned && money(sale.paidAmount) <= 0 ? (
                    <p className="text-xs text-success">Nothing owed</p>
                  ) : (
                    <p className="text-xs text-success">Paid</p>
                  )}
                </div>
              </div>
              )
            })}
          </div>
        </div>
      </div>
      {customer.imeiRecords.length ? (
        <div className="surface-card p-5">
          <h3 className="mb-4 font-semibold">Devices & warranty</h3>
          <div className="space-y-3 text-sm">
            {customer.imeiRecords.map((row) => {
              const cover = row.sale ? warrantyState(row.sale.saleDate, row.product.warrantyDays) : null
              return (
                <div key={row.id} className="flex justify-between gap-3 border-b border-border/70 pb-2">
                  <div>
                    <a href={`/imei/${row.id}`} className="font-medium text-primary">{row.imei1}</a>
                    <p className="text-xs text-muted-foreground">{row.product.name} · {statusLabel(row.status)}</p>
                  </div>
                  <span className="text-right text-xs text-muted-foreground">{cover?.label ?? "Not on a sale"}</span>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
