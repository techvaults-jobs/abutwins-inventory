import Link from "next/link"
import { notFound } from "next/navigation"
import { getSupplier, getSupplierOpening, removeSupplier, updateSupplier } from "@/app/actions/parties"
import { EditDetailsButton } from "@/components/edit-details-button"
import { canHardDelete } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { SupplierOpeningCard } from "./supplier-opening-card"
import { SupplierBillsDownload } from "./supplier-bills-download"
import { linkPeriod, watDayKey } from "@/lib/lagos-day"
import { PeriodPicker } from "@/components/period-picker"
import { statusLabel } from "@/lib/status"
import { PageHeader, StatCard, StatGrid, StatusBadge, TonePill, Toolbar } from "@/components/shared"
import { formatCurrency, formatDate, money } from "@/lib/utils"
import {
  formatPurchaseBalanceCell,
  formatValueOwingMinus,
  formatValueOwingPlus,
  purchaseBalance,
} from "@/lib/purchase-money"

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ range?: string; from?: string; date?: string }>
}) {
  const { id } = await params
  // Any period, for analysis: the bills dated in it, and what stands on them
  // today. All time (the default) is the whole account, as before.
  const period = linkPeriod(await searchParams)
  const supplier = await getSupplier(id)
  if (!supplier) notFound()
  const opening = await getSupplierOpening(id)
  const me = await requireUser()
  // Only a house added by mistake, with nothing on record, can be removed.
  const removable =
    canHardDelete(me.role) &&
    Math.abs(money(supplier.creditBalance)) < 0.005 &&
    supplier.purchases.length === 0 &&
    supplier.imeiRecords.length === 0 &&
    !supplier.openingBills.length

  const purchases = supplier.purchases.filter((row) => period.holds(row.createdAt))
  const openingBills = supplier.openingBills.filter((row) => period.holds(row.createdAt))
  // Send-back credit not on a bill, and phones added without one, carry no
  // bill date, so they belong to All time only.
  const extraCredit = period.window ? 0 : money(supplier.creditBalance)
  const totalPurchased = purchases.reduce((sum, row) => sum + money(row.totalAmount), 0)
  const totalPaid = purchases.reduce((sum, row) => sum + money(row.paidAmount), 0)
  let net = 0
  let totalShipping = 0
  for (const row of purchases) {
    const bal = purchaseBalance(row)
    net += bal.remaining - bal.paid
    totalShipping += bal.shipping
  }
  net -= extraCredit
  const totalOwed = Math.max(0, net)
  const totalSurplus = Math.max(0, -net)
  // Opening stock loaded under this name: the shop's starting value. Shown in
  // full, kept out of everything above, because nothing on it is owed.
  const unbilled = period.window ? { units: 0, value: 0 } : supplier.unbilledOpening
  const openingValue = openingBills.reduce((sum, row) => sum + money(row.totalAmount), 0) + unbilled.value
  const openingUnits = openingBills.reduce((sum, row) => sum + row._count.imeiRecords, 0) + unbilled.units
  const hasOpening = openingBills.length > 0 || unbilled.units > 0

  // The account as a sheet: every bill as on screen, opening stock (never
  // owed), then the totals. Plain numbers, so the columns add up in Excel.
  const billTotals = purchases.reduce(
    (acc, row) => {
      const bal = purchaseBalance(row)
      acc.billed += bal.billed
      acc.shipping += bal.shipping
      acc.payable += bal.payable
      acc.paid += bal.paid
      acc.sentBack += bal.sentBack
      return acc
    },
    { billed: 0, shipping: 0, payable: 0, paid: 0, sentBack: 0 }
  )
  const accountRows: Array<Array<string | number>> = [
    [supplier.name, period.window ? `Bills dated ${period.label}` : "All time"],
    [],
    ["Bill number", "Date", "Shop", "Uploaded value (₦)", "Shipping fee (₦)", "Payable value (₦)", "Payment (₦)", "Stock return (₦)", "We owe (₦)", "They owe us (₦)", "Status"],
    ...purchases.map((row) => {
      const bal = purchaseBalance(row)
      return [
        row.invoiceNumber,
        watDayKey(row.createdAt),
        row.branch.name || row.branch.code,
        bal.billed,
        bal.shipping,
        bal.payable,
        bal.paid,
        bal.sentBack,
        bal.owed,
        bal.surplus,
        statusLabel(row.status),
      ]
    }),
    ...openingBills.map((row) => [
      row.invoiceNumber,
      watDayKey(row.createdAt),
      row.branch.name || row.branch.code,
      money(row.totalAmount),
      0,
      0,
      0,
      0,
      0,
      0,
      "Opening stock · not owed",
    ]),
    ...(unbilled.units > 0
      ? [[`${unbilled.units} phone${unbilled.units === 1 ? "" : "s"} added without a bill`, "", "", unbilled.value, 0, 0, 0, 0, 0, 0, "Opening stock · not owed"]]
      : []),
    [
      `Total (${purchases.length} bill${purchases.length === 1 ? "" : "s"})`,
      "",
      "",
      billTotals.billed,
      billTotals.shipping,
      billTotals.payable,
      billTotals.paid,
      billTotals.sentBack,
      totalOwed,
      totalSurplus,
      extraCredit > 0 ? `Includes ${formatCurrency(extraCredit)} send-back credit not on a bill` : "",
    ],
  ]
  const periodPart = period.window ? (period.from === period.date ? period.from : `${period.from}-to-${period.date}`) : `all-time-${watDayKey()}`
  const accountFile = `supplier-${supplier.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "account"}-${periodPart}`

  return (
    <div className="space-y-6">
      <PageHeader
        backHref="/suppliers"
        title={supplier.name}
        description={`${supplier.kind === "NEIGHBOR" ? "Neighboring shop" : "Supplier"} · ${[supplier.city, supplier.country].filter(Boolean).join(", ") || "Where they are is not set"} · ${supplier.phone}${supplier.contactPerson ? ` · ${supplier.contactPerson}` : ""}`}
        actions={
          <EditDetailsButton
            id={supplier.id}
            title={`Edit details: ${supplier.name}`}
            description="Put right a name, phone or contact typed wrong. Their bills and balance are not changed here."
            save={updateSupplier}
            remove={removable ? { action: removeSupplier, what: supplier.name } : undefined}
            fields={[
              { name: "name", label: "Name", value: supplier.name, required: true },
              { name: "phone", label: "Phone", value: supplier.phone, type: "tel" },
              { name: "contactPerson", label: "Contact person", value: supplier.contactPerson ?? "" },
              { name: "email", label: "Email", value: supplier.email ?? "", type: "email" },
              { name: "city", label: "City", value: supplier.city ?? "" },
              { name: "country", label: "Country", value: supplier.country ?? "" },
              {
                name: "kind",
                label: "Kind",
                value: supplier.kind,
                options: [
                  { value: "SUPPLIER", label: "Supplier" },
                  { value: "NEIGHBOR", label: "Neighboring shop" },
                ],
              },
              { name: "address", label: "Address", value: supplier.address ?? "", wide: true },
            ]}
          />
        }
      />

      {opening && !supplier.name.toLowerCase().includes("opening stock") ? (
        <SupplierOpeningCard
          supplierId={supplier.id}
          supplierName={supplier.name}
          opening={opening.amount}
          paidOnIt={opening.paidOnIt}
          bills={opening.bills}
          canChange={opening.canChange}
        />
      ) : null}

      <Toolbar className="justify-between">
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          <PeriodPicker range={period.range} from={period.from} date={period.date} allowAll />
          <TonePill tone={period.window ? "primary" : "neutral"}>{period.window ? `Bills dated ${period.label}` : "All time"}</TonePill>
        </div>
        {period.window ? (
          <p className="text-xs text-muted-foreground sm:max-w-sm sm:text-right">
            Payment, stock return and balance are what stands on these bills today. Send-back credit not on a bill shows under All time.
          </p>
        ) : null}
      </Toolbar>

      <StatGrid>
        {hasOpening ? (
          <StatCard
            label="Opening stock value"
            value={formatCurrency(openingValue)}
            hint={`Starting stock · not owed · ${openingUnits} phone${openingUnits === 1 ? "" : "s"}`}
            href="#opening-stock"
          />
        ) : null}
        <StatCard
          label={period.window ? "Uploaded in this period" : "Total uploaded value"}
          value={formatCurrency(totalPurchased)}
          hint={`${purchases.length} supplier bill${purchases.length === 1 ? "" : "s"}`}
          href="#supplier-bills"
        />
        {totalShipping > 0 ? (
          <StatCard
            label="Shipping fees"
            value={formatCurrency(totalShipping)}
            hint={`Taken off · ${formatCurrency(Math.max(0, totalPurchased - totalShipping))} payable to them`}
            href="#supplier-bills"
          />
        ) : null}
        <StatCard
          label={period.window ? "Payment on these bills" : "Payment"}
          value={formatCurrency(totalPaid)}
          tone="success"
          href="#supplier-bills"
        />
        <StatCard
          label={period.window ? "We owe them on these bills (−)" : "We owe them (−)"}
          value={formatValueOwingMinus(totalOwed)}
          tone={totalOwed > 0 ? "warning" : "neutral"}
          href="#supplier-bills"
        />
        <StatCard
          label={period.window ? "They owe us on these bills" : "They owe us"}
          value={formatValueOwingPlus(totalSurplus)}
          tone={totalSurplus > 0 ? "success" : "neutral"}
          href="#supplier-bills"
        />
        <StatCard
          label="Phones we collected"
          value={String(supplier.imeiRecords.length)}
          href="#supplier-bills"
        />
      </StatGrid>

      {hasOpening ? (
        <div id="opening-stock" className="surface-card scroll-mt-4 overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-5 py-4">
            <h3 className="font-semibold">Opening stock loaded under this name</h3>
            <p className="text-xs text-muted-foreground">
              The value of stock already on the shelf when the shops started on the software. It is not a supplier
              bill, so nothing on it is owed.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-5 py-3">Opening record</th>
                  <th className="px-3 py-3">Shop</th>
                  <th className="px-3 py-3">Loaded</th>
                  <th className="px-3 py-3 text-right">Phones</th>
                  <th className="px-3 py-3 text-right">Stock value</th>
                  <th className="px-5 py-3 text-right">Owed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {openingBills.map((row) => (
                  <tr key={row.id}>
                    <td className="px-5 py-3">
                      <Link href={`/purchases/${row.id}`} className="whitespace-nowrap font-semibold text-primary hover:underline">
                        {row.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-3">{row.branch.name}</td>
                    <td className="px-3 py-3 text-muted-foreground">{formatDate(row.createdAt)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{row._count.imeiRecords}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums">{formatCurrency(money(row.totalAmount))}</td>
                    <td className="px-5 py-3 text-right text-xs font-medium text-muted-foreground">Not owed · opening stock</td>
                  </tr>
                ))}
                {unbilled.units > 0 ? (
                  <tr>
                    <td className="px-5 py-3 font-medium">Phones added without a bill</td>
                    <td className="px-3 py-3 text-muted-foreground" colSpan={2}>
                      Put on the shelf one at a time · valued at item cost
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{unbilled.units}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums">{formatCurrency(unbilled.value)}</td>
                    <td className="px-5 py-3 text-right text-xs font-medium text-muted-foreground">Not owed · opening stock</td>
                  </tr>
                ) : null}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                  <td className="px-5 py-3" colSpan={3}>
                    Total opening stock value
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{openingUnits}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(openingValue)}</td>
                  <td className="px-5 py-3 text-right text-xs text-muted-foreground">₦0 owed</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : null}

      <div id="supplier-bills" className="surface-card scroll-mt-4 overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 className="font-semibold">Every bill from this supplier</h3>
          <SupplierBillsDownload filename={accountFile} rows={accountRows} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="text-left text-muted-foreground bg-muted/40 text-xs uppercase tracking-wider">
              <tr className="border-b border-border">
                <th className="px-5 py-3">Bill number</th>
                <th className="px-3 py-3">Shop</th>
                <th className="px-3 py-3 text-right">Uploaded value</th>
                <th className="px-3 py-3 text-right">Shipping fee</th>
                <th className="px-3 py-3 text-right">Payable value</th>
                <th className="px-3 py-3 text-right">Payment</th>
                <th className="px-3 py-3 text-right">Stock return</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-5 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {purchases.map((row) => {
                const poVal = money(row.totalAmount)
                const poPaid = money(row.paidAmount)
                const bal = purchaseBalance(row)

                return (
                  <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-5 py-3">
                      <Link href={`/purchases/${row.id}`} className="whitespace-nowrap font-semibold text-primary hover:underline">
                        {row.invoiceNumber}
                      </Link>
                      <p className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</p>
                    </td>

                    <td className="px-3 py-3 font-medium">
                      <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-semibold">{row.branch.code}</span>
                    </td>

                    <td className="px-3 py-3 text-right tabular-nums font-mono font-medium">
                      {formatCurrency(poVal)}
                    </td>

                    <td className="px-3 py-3 text-right tabular-nums font-mono">
                      {bal.shipping > 0 ? `−${formatCurrency(bal.shipping)}` : <span className="text-muted-foreground">—</span>}
                    </td>

                    <td className="px-3 py-3 text-right tabular-nums font-mono font-medium">
                      {formatCurrency(bal.payable)}
                    </td>

                    <td className="px-3 py-3 text-right tabular-nums font-mono font-semibold text-success">
                      {formatCurrency(poPaid)}
                    </td>

                    <td className="px-3 py-3 text-right tabular-nums font-mono">
                      {formatCurrency(bal.sentBack)}
                    </td>

                    <td className="px-4 py-3 text-right tabular-nums font-mono font-bold text-foreground">
                      {formatPurchaseBalanceCell(bal.owed, bal.surplus)}
                    </td>

                    <td className="px-5 py-3 text-center">
                      <StatusBadge value={row.status} />
                    </td>
                  </tr>
                )
              })}
              {purchases.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-5 py-4 text-sm text-muted-foreground">
                    {period.window ? "No bill from this supplier is dated in this period." : "No supplier bill yet."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
