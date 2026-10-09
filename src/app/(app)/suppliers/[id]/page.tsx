import Link from "next/link"
import { notFound } from "next/navigation"
import { getSupplier } from "@/app/actions/parties"
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

  const totalPurchased = supplier.purchases.reduce((sum, row) => sum + money(row.totalAmount), 0)
  const totalPaid = supplier.purchases.reduce((sum, row) => sum + money(row.paidAmount), 0)
  let net = 0
  for (const row of supplier.purchases) {
    const bal = purchaseBalance(row.totalAmount, row.paidAmount, row.returnedAmount)
    net += bal.remaining - bal.paid
  }
  net -= money(supplier.creditBalance)
  const totalOwed = Math.max(0, net)
  const totalSurplus = Math.max(0, -net)
  // Opening stock loaded under this name: the shop's starting value. Shown in
  // full, kept out of everything above, because nothing on it is owed.
  const openingValue = supplier.openingBills.reduce((sum, row) => sum + money(row.totalAmount), 0)
  const openingUnits = supplier.openingBills.reduce((sum, row) => sum + row._count.imeiRecords, 0)

  return (
    <div className="space-y-6">
      <PageHeader
        backHref="/suppliers"
        title={supplier.name}
        description={`${supplier.kind === "NEIGHBOR" ? "Neighboring shop" : "Supplier"} · ${[supplier.city, supplier.country].filter(Boolean).join(", ") || "Where they are is not set"} · ${supplier.phone}${supplier.contactPerson ? ` · ${supplier.contactPerson}` : ""}`}
      />

      <StatGrid>
        {supplier.openingBills.length ? (
          <StatCard
            label="Opening stock value"
            value={formatCurrency(openingValue)}
            hint={`Starting stock · not owed · ${supplier.openingBills.length} load${supplier.openingBills.length === 1 ? "" : "s"}`}
            href="#opening-stock"
          />
        ) : null}
        <StatCard
          label="Everything they billed us"
          value={formatCurrency(totalPurchased)}
          hint={`${supplier.purchases.length} supplier bill${supplier.purchases.length === 1 ? "" : "s"}`}
          href="#supplier-bills"
        />
        <StatCard
          label="Payment"
          value={formatCurrency(totalPaid)}
          tone="success"
          href="#supplier-bills"
        />
        <StatCard
          label="Value owing"
          value={formatValueOwingMinus(totalOwed)}
          tone={totalOwed > 0 ? "warning" : "neutral"}
          href="#supplier-bills"
        />
        <StatCard
          label="Value owing"
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

      {supplier.openingBills.length ? (
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
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-muted-foreground bg-muted/40 text-xs uppercase tracking-wider">
              <tr className="border-b border-border">
                <th className="px-5 py-3">Bill number</th>
                <th className="px-3 py-3">Shop</th>
                <th className="px-3 py-3 text-right">Invoice value</th>
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
                const bal = purchaseBalance(row.totalAmount, row.paidAmount, row.returnedAmount)

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
