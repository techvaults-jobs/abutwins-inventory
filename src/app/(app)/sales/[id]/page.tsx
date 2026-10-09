import Link from "next/link"
import { notFound } from "next/navigation"
import { reverseInvoicePayment } from "@/app/actions/access"
import { attachSaleCustomer, collectInvoicePayment, getSale } from "@/app/actions/sales"
import { getAppSettings } from "@/lib/settings"
import { letterheadFromSettings } from "@/lib/letterhead"
import { getCustomers } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { CollectMoneyFields } from "@/components/collect-money-fields"
import { PageHeader, StatusBadge } from "@/components/shared"
import { PrintButton } from "@/components/print-button"
import { ReceiptPdfButton } from "@/components/receipt-pdf-button"
import { AutoPrint } from "@/components/auto-print"
import { Receipt } from "@/components/receipt"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { isShopOwner } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { formatCurrency, formatDateTime, money } from "@/lib/utils"
import { formatCondition, statusLabel } from "@/lib/status"
import { warrantyState } from "@/lib/warranty"
import { dueAfterReturns, returnedValueBySale } from "@/lib/returned-value"
import { prisma } from "@/lib/prisma"
import { buildPaymentTrails } from "@/lib/payment-trail"
import { PaymentTrail } from "@/components/payment-trail"

export default async function SaleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ receipt?: string }>
}) {
  const { id } = await params
  // The till sends the cashier straight here after a sale, asking for the
  // receipt to print itself.
  const { receipt } = await searchParams
  const [me, sale, settings, customers] = await Promise.all([requireUser(), getSale(id), getAppSettings(), getCustomers()])
  if (!sale) notFound()
  // A finished refund or credit note has already cleared part of this sale.
  const [returnedBySale, trails] = await Promise.all([
    returnedValueBySale(prisma, [sale.id]),
    buildPaymentTrails(prisma, [sale]),
  ])
  const returned = returnedBySale.get(sale.id) ?? 0
  const paymentSteps = trails.get(sale.id) ?? []
  const due = dueAfterReturns(sale, returned)
  const brand = letterheadFromSettings(settings)
  const branchCustomers = customers.filter(
    (row) => row.branchId === sale.branchId && !row.name.toLowerCase().includes("walk-in")
  )
  const banks = await prisma.bankAccount.findMany({
    where: { isActive: true, branchId: sale.branchId },
    orderBy: [{ bankName: "asc" }, { accountNumber: "asc" }],
    select: { id: true, bankName: true, accountNumber: true, accountName: true },
  })

  const receiptData = {
    company: brand.name,
    tagline: brand.tagline,
    logoSrc: brand.logoSrc,
    footer: brand.footer,
    invoiceNumber: sale.invoiceNumber,
    branch: sale.branch.name,
    address: brand.address || sale.branch.address,
    shopPhone: brand.phone || sale.branch.phone,
    email: brand.email,
    cashier: sale.user.name ?? "Staff",
    customer: sale.customer?.name ?? null,
    customerPhone: sale.customer?.phone ?? null,
    soldAt: formatDateTime(sale.saleDate),
    items: sale.items.map((item) => ({
      name: item.product.name,
      imei: item.imei?.imei1,
      quantity: item.quantity,
      amount: money(item.totalPrice),
      warranty: warrantyState(sale.saleDate, item.warrantyDays ?? item.product.warrantyDays).label,
      storage: item.product.storage,
      condition: item.product.condition,
      color: item.product.color,
    })),
    total: money(sale.totalAmount),
    paid: money(sale.paidAmount),
    method: statusLabel(sale.paymentMethod),
    paymentReference: sale.payments.find((p) => p.reference)?.reference ?? null,
    notes: sale.notes,
  }

  return (
    <>
      <AutoPrint when={receipt === "1"} />
    <div className="space-y-6">
      {/* Straight after Complete sale: a tick draws itself so the cashier
          knows the sale landed, while the receipt prints. Not on paper. */}
      {receipt === "1" ? (
        <div
          role="status"
          className="motion-pop flex items-center gap-3 rounded-xl border border-success/30 bg-success-soft px-4 py-3 text-success print:hidden"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground">
            <svg
              className="motion-check h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          <p className="text-sm">
            <span className="font-semibold">Sale saved</span>
            <span className="text-success/80"> · {formatCurrency(money(sale.totalAmount))} · the receipt is printing</span>
          </p>
        </div>
      ) : null}
      <PageHeader
        backHref="/sales"
        title={sale.invoiceNumber}
        description={`${sale.branch.name} · ${formatDateTime(sale.saleDate)} · posted by ${sale.user.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/pos"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors"
            >
              + Next Customer / New Sale
            </Link>
            <ReceiptPdfButton data={receiptData} />
            <PrintButton label="Print invoice" />
          </div>
        }
      />
      <div className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning print:hidden">
        This sale cannot be changed. Staff cannot edit items, IMEIs, or prices. Collect any remaining money below.
      </div>
      <div className="grid gap-4 md:grid-cols-3 print:hidden">
        <div className="surface-card p-5">
          <p className="text-sm text-muted-foreground">Customer</p>
          <p className="font-semibold">
            {sale.customer ? (
              <Link href={`/customers/${sale.customer.id}`} className="text-primary">{sale.customer.name}</Link>
            ) : (
              "Walk-in. Put a buyer name on it before anybody can return it"
            )}
          </p>
          <p className="text-sm text-muted-foreground">{sale.customer?.phone}</p>
        </div>
        <div className="surface-card p-5">
          <p className="text-sm text-muted-foreground">Status</p>
          <StatusBadge value={sale.status} />
          <p className="mt-2 text-sm text-muted-foreground">{statusLabel(sale.paymentMethod)}{sale.isWholesale ? " · wholesale" : ""}</p>
          {sale.priceApprovedBy ? (
            <p className="mt-1 text-sm text-muted-foreground">Price approved by {sale.priceApprovedBy}</p>
          ) : null}
        </div>
        <div className="surface-card p-5">
          <p className="text-sm text-muted-foreground">Amount paid</p>
          <p className="text-2xl font-semibold">{formatCurrency(money(sale.paidAmount))}</p>
          <p className="text-sm text-muted-foreground">
            of {formatCurrency(money(sale.totalAmount))}
            {due > 0 ? ` · still due ${formatCurrency(due)}` : " · settled"}
          </p>
        </div>
      </div>
      {/* A list, not a four-column table, so a phone name and its price
          both fit on a phone screen. */}
      <div className="surface-card overflow-hidden print:hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h3 className="text-sm font-semibold">
            {sale.items.length} item{sale.items.length === 1 ? "" : "s"}
          </h3>
          <span className="text-sm font-semibold tabular-nums">{formatCurrency(money(sale.totalAmount))}</span>
        </div>
        <ul className="divide-y divide-border">
          {sale.items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-4 px-5 py-3.5">
              <div className="min-w-0">
                <p className="font-medium">{item.product.name}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                  {item.product.storage ? (
                    <span className="rounded bg-info-soft px-1.5 py-0.5 font-semibold text-info">{item.product.storage}</span>
                  ) : null}
                  {item.product.condition ? (
                    <span className="rounded bg-success-soft px-1.5 py-0.5 font-medium text-success">
                      {formatCondition(item.product.condition)}
                    </span>
                  ) : null}
                  {item.product.color ? <span className="text-muted-foreground">{item.product.color}</span> : null}
                  {item.imei ? (
                    <Link href={`/imei/${item.imei.id}`} className="font-mono text-primary hover:underline">
                      {item.imei.imei1}
                    </Link>
                  ) : null}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-semibold tabular-nums">{formatCurrency(money(item.totalPrice))}</p>
                {item.quantity > 1 ? (
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {item.quantity} × {formatCurrency(money(item.unitPrice))}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="surface-card p-5 print:hidden">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">How it was paid</h3>
          <p className="text-xs text-muted-foreground">Each payment in order, with its reference and who took it</p>
        </div>
        <PaymentTrail steps={paymentSteps} total={money(sale.totalAmount)} returned={returned} />
      </div>
      {!sale.customerId ? (
        <div className="surface-card p-5 print:hidden">
          <h3 className="mb-2 font-semibold">Attach named buyer</h3>
          <p className="mb-3 text-sm text-muted-foreground">Warranty and returns need a name. Items and prices stay as they are.</p>
          <ActionForm action={attachSaleCustomer} submit="Attach buyer" className="grid gap-3 md:grid-cols-2">
            <input type="hidden" name="saleId" value={sale.id} />
            <Select name="customerId" defaultValue="" className="md:col-span-2">
              <option value="">Add a new customer below, or pick one from this shop</option>
              {branchCustomers.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · {row.phone}
                </option>
              ))}
            </Select>
            <Input name="name" placeholder="Full name" />
            <Input name="phone" placeholder="Phone" />
          </ActionForm>
        </div>
      ) : null}
      {isShopOwner(me.role) && sale.payments.length ? (
        <div className="surface-card p-5 print:hidden">
          <h3 className="mb-2 font-semibold">Undo the last money collected</h3>
          <p className="mb-3 text-sm text-muted-foreground">Items and IMEIs stay. Who did what keeps this.</p>
          <ActionForm action={reverseInvoicePayment} submit="Reverse last payment" variant="outline">
            <input type="hidden" name="saleId" value={sale.id} />
          </ActionForm>
        </div>
      ) : null}
      {due > 0 && sale.customerId ? (
        <div className="surface-card p-5 print:hidden">
          <h3 className="mb-3 font-semibold">Collect the rest of the money</h3>
          <ActionForm action={collectInvoicePayment} submit="Save this payment" className="grid gap-3 md:grid-cols-1 md:items-end">
            <input type="hidden" name="saleId" value={sale.id} />
            <CollectMoneyFields banks={banks} defaultAmount={due} allowSplit />
          </ActionForm>
        </div>
      ) : null}
      {/* The invoice is a paper document: on a phone it keeps its paper width
          and scrolls sideways inside this box instead of squeezing its columns. */}
      <div className="surface-card overflow-x-auto print:overflow-visible print:border-0 print:shadow-none">
        <div className="min-w-[600px] print:min-w-0">
        <Receipt
          brand={brand}
          invoiceNumber={sale.invoiceNumber}
          branch={sale.branch.name}
          cashier={sale.user.name ?? "Staff"}
          customer={sale.customer?.name ?? "Walk-in"}
          phone={sale.customer?.phone}
          soldAt={sale.saleDate}
          items={sale.items.map((item) => ({
            name: item.product.name,
            imei: item.imei?.imei1,
            quantity: item.quantity,
            amount: money(item.totalPrice),
            warranty: warrantyState(sale.saleDate, item.warrantyDays ?? item.product.warrantyDays).label,
            storage: item.product.storage,
            condition: item.product.condition,
            color: item.product.color,
          }))}
          total={money(sale.totalAmount)}
          discount={money(sale.discount)}
          paid={money(sale.paidAmount)}
          method={statusLabel(sale.paymentMethod)}
          paymentReference={sale.payments.find((p) => p.reference)?.reference ?? null}
          notes={sale.notes}
        />
        </div>
      </div>
    </div>
    </>
  )
}
