import Link from "next/link"
import { Plus } from "lucide-react"
import { getSuppliers } from "@/app/actions/parties"
import { PageHeader } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { money } from "@/lib/utils"
import { linkPeriod } from "@/lib/lagos-day"
import { SuppliersList } from "./suppliers-list"

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; date?: string }>
}) {
  // The client asked to pick any period on the supplier accounts, for
  // analysis. A period keeps the bills dated in it; what was paid and sent
  // back on them, and so their balance, is what stands on them today.
  const period = linkPeriod(await searchParams)
  const raw = await getSuppliers()
  const suppliers = raw.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
    kind: supplier.kind,
    phone: supplier.phone,
    city: supplier.city,
    country: supplier.country,
    purchases: supplier.purchases.filter((purchase) => period.holds(purchase.createdAt)).map((purchase) => ({
      id: purchase.id,
      invoiceNumber: purchase.invoiceNumber,
      totalAmount: money(purchase.totalAmount),
      paidAmount: money(purchase.paidAmount),
      returnedAmount: money(purchase.returnedAmount),
      shippingFee: money(purchase.shippingFee),
      status: purchase.status,
      createdAt: purchase.createdAt.toISOString(),
      branchCode: purchase.branch.code,
      branchName: purchase.branch.name,
    })),
    openingBills: supplier.openingBills.filter((bill) => period.holds(bill.createdAt)).map((bill) => ({
      id: bill.id,
      invoiceNumber: bill.invoiceNumber,
      totalAmount: money(bill.totalAmount),
      createdAt: bill.createdAt.toISOString(),
      branchCode: bill.branch.code,
      branchName: bill.branch.name,
      units: bill._count.imeiRecords,
    })),
    isOpeningStock: supplier.isOpeningStock,
    // Phones added without a bill, and send-back credit not on a bill, carry
    // no bill date: they belong to All time only.
    unbilledOpening: period.window ? { units: 0, value: 0 } : supplier.unbilledOpening,
    creditBalance: period.window ? 0 : money(supplier.creditBalance),
  }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppliers"
        description={period.window ? `Bills dated ${period.label}: bought, paid, still owed, and they owe us.` : "Bought, paid, still owed, and they owe us."}
        actions={
          <Button asChild>
            <Link href="/suppliers/new">
              <Plus className="mr-1.5 h-4 w-4" /> Add a supplier
            </Link>
          </Button>
        }
      />

      <SuppliersList
        suppliers={suppliers}
        period={{ range: period.range, from: period.from, date: period.date, label: period.label, all: !period.window }}
      />
    </div>
  )
}
