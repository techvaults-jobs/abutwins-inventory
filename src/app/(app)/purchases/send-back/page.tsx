import Link from "next/link"
import { getSupplierReturnCandidates } from "@/app/actions/ops"
import { FormScreen, SectionCard } from "@/components/shared"
import { SupplierReturnForm } from "../supplier-return-form"
import { requireUser } from "@/lib/session"
import { canSendToSupplier } from "@/lib/rbac"

export default async function SendBackToSupplierPage() {
  const [returnUnits, me] = await Promise.all([getSupplierReturnCandidates(), requireUser()])
  // Return outward is the Vault Manager's, shop Manager's, CEO's or main
  // admin's decision; everyone else sees what is waiting, read-only.
  const mayDecide = canSendToSupplier(me.role)
  return (
    <FormScreen
      title="Send back to supplier"
      description="Scan every phone going back onto a list, check it, then review and send. Scanning never sends on its own. The supplier and cost fill in from the bill."
      backHref="/purchases"
      aside={
        <SectionCard title="Waiting to go back" description={returnUnits.length ? `${returnUnits.length} phone${returnUnits.length === 1 ? "" : "s"}` : undefined}>
          {returnUnits.length ? (
            <ul className="space-y-2 text-sm">
              {returnUnits.slice(0, 20).map((row) => (
                <li key={row.id} className="min-w-0">
                  <p className="font-mono text-xs">{row.imei1}</p>
                  <p className="truncate text-muted-foreground">
                    {row.productName} · {row.shop}
                    {row.supplierName ? ` · ${row.supplierName}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No phone is waiting. You can still type or scan an In shop IMEI.</p>
          )}
          <div className="mt-4 border-t border-border pt-3">
            <Link
              href="/purchases/returns-history"
              className="text-sm font-medium text-primary hover:underline"
            >
              View full returns history →
            </Link>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Every unit ever sent back, grouped by supplier, with values and Excel export.
            </p>
          </div>
        </SectionCard>
      }
    >
      {mayDecide ? (
        <SupplierReturnForm />
      ) : (
        <p className="text-sm text-muted-foreground">
          Sending goods back to a supplier is decided by the Vault Manager, the shop Manager, the CEO or the main admin.
          The phones waiting to go back are listed here for you to see.
        </p>
      )}
    </FormScreen>
  )
}
