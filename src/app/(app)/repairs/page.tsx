import { money } from "@/lib/utils"
import { productSpecLine } from "@/lib/product-specs"
import Link from "next/link"
import { Plus } from "lucide-react"
import { getRepairs } from "@/app/actions/ops"
import { PageHeader } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { can } from "@/lib/permissions"
import { requireUser } from "@/lib/session"
import { RepairsList } from "./repairs-list"

export default async function RepairsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams
  const user = await requireUser()
  const canOpen = await can(user.role, "action.repair")
  const rows = await getRepairs()
  return (
    <div className="space-y-5">
        <PageHeader
          title="Repairs"
          description="Take the phone, find the fault, fix it, give it back."
          actions={
            canOpen ? (
              <Button asChild>
                <Link href="/repairs/new">
                  <Plus className="mr-1.5 h-4 w-4" /> Open a repair
                </Link>
              </Button>
            ) : null
          }
        />
        <RepairsList
          initialStatus={status}
          // Only what the list shows. Passing the whole row sent the staff
          // member's login record, password hash included, to the browser.
          rows={rows.map((row) => ({
            id: row.id,
            repairNumber: row.repairNumber,
            status: row.status,
            issue: row.issue,
            diagnosis: row.diagnosis,
            repairCost: row.repairCost != null ? money(row.repairCost) : null,
            createdAt: row.createdAt,
            completedAt: row.completedAt,
            imei: { id: row.imei.id, imei1: row.imei.imei1, product: { name: row.imei.product.name, specs: productSpecLine(row.imei.product) } },
            customer: row.customer ? { name: row.customer.name } : null,
          }))}
        />
    </div>
  )
}
