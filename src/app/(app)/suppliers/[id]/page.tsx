import Link from "next/link"
import { notFound } from "next/navigation"
import { getSupplier, getSupplierOpening, removeSupplier, updateSupplier } from "@/app/actions/parties"
import { EditDetailsButton } from "@/components/edit-details-button"
import { canHardDelete } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { SupplierOpeningCard } from "./supplier-opening-card"
import { PageHeader, StatCard, StatGrid, StatusBadge } from "@/components/shared"
import { formatCurrency, formatDate, money } from "@/lib/utils"
import {
  formatPurchaseBalanceCell,
  formatValueOwingMinus,
  formatValueOwingPlus,
  purchaseBalance,
} from "@/lib/purchase-money"

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
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

  const totalPurchased = supplier.purchases.reduce((sum, row) => sum + money(row.totalAmount), 0)
  const totalPaid = supplier.purchases.reduce((sum, row) => sum + money(row.paidAmount), 0)
  let net = 0
  let totalShipping = 0
  for (const row of supplier.purchases) {
    const bal = purchaseBalance(row)
    net += bal.remaining - bal.paid
    totalShipping += bal.shipping
  }
  net -= money(supplier.creditBalance)
  const totalOwed = Math.max(0, net)
  const totalSurplus = Math.max(0, -net)
  // Opening stock loaded under this name: the shop's starting value. Shown in
  // full, kept out of everything above, because nothing on it is owed.
  const unbilled = supplier.unbilledOpening
  const openingValue = supplier.openingBills.reduce((sum, row) => sum + money(row.totalAmount), 0) + unbilled.value
  const openingUnits = supplier.openingBills.reduce((sum, row) => sum + row._count.imeiRecords, 0) + unbilled.units
  const hasOpening = supplier.openingBills.length > 0 || unbilled.units > 0

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
          label="Total uploaded value"
          value={formatCurrency(totalPurchased)}
          hint={`${supplier.purchases.length} supplier bill${supplier.purchases.length === 1 ? "" : "s"}`}
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
          label="Payment"
          value={formatCurrency(totalPaid)}
          tone="success"
          href="#supplier-bills"
        />
        <StatCard
          label="We owe them (−)"
          value={formatValueOwingMinus(totalOwed)}
          tone={totalOwed > 0 ? "warning" : "neutral"}
          href="#supplier-bills"
        />
        <StatCard
          label="They owe us"
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
                {supplier.openingBills.map((row) => (
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
              {supplier.purchases.map((row) => {
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
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
