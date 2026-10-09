import Link from "next/link"
import { Plus } from "lucide-react"
import { getSuppliers } from "@/app/actions/parties"
import { PageHeader } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { money } from "@/lib/utils"
import { SuppliersList } from "./suppliers-list"

export default async function SuppliersPage() {
  const raw = await getSuppliers()
  const suppliers = raw.map((supplier) => ({
    id: supplier.id,
    name: supplier.name,
    kind: supplier.kind,
    phone: supplier.phone,
    city: supplier.city,
    country: supplier.country,
    purchases: supplier.purchases.map((purchase) => ({
      id: purchase.id,
      invoiceNumber: purchase.invoiceNumber,
      totalAmount: money(purchase.totalAmount),
      paidAmount: money(purchase.paidAmount),
      returnedAmount: money(purchase.returnedAmount),
      status: purchase.status,
      createdAt: purchase.createdAt.toISOString(),
      branchCode: purchase.branch.code,
      branchName: purchase.branch.name,
    })),
    openingBills: supplier.openingBills.map((bill) => ({
      id: bill.id,
      invoiceNumber: bill.invoiceNumber,
      totalAmount: money(bill.totalAmount),
      createdAt: bill.createdAt.toISOString(),
      branchCode: bill.branch.code,
      branchName: bill.branch.name,
      units: bill._count.imeiRecords,
    })),
    creditBalance: money(supplier.creditBalance),
  }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppliers"
        description="Bought, paid, still owed, and they owe us."
        actions={
          <Button asChild>
            <Link href="/suppliers/new">
              <Plus className="mr-1.5 h-4 w-4" /> Add a supplier
            </Link>
          </Button>
        }
      />

      <SuppliersList suppliers={suppliers} />
    </div>
  )
}
