import { redirect } from "next/navigation"
import { getUnnamedSupplierPayments } from "@/app/actions/finance"
import { PageHeader } from "@/components/shared"
import { NameBanksView } from "./name-banks-view"

export const dynamic = "force-dynamic"

/**
 * Supplier payments made before a transfer had to say which bank it left
 * from. The accountant names the bank here, so each account on Money in and
 * out carries the payments that really left it.
 */
export default async function SupplierBanksPage() {
  const data = await getUnnamedSupplierPayments()
  if (!data) redirect("/finance")
  return (
    <div className="space-y-6">
      <PageHeader
        backHref="/finance"
        title="Name the bank for supplier payments"
        description="Past payments to suppliers that say no bank. Pick the account each one left from."
      />
      <NameBanksView rows={data.rows} banks={data.banks} total={data.total} />
    </div>
  )
}
