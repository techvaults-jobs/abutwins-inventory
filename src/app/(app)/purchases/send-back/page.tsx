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
      description="Scan or type each phone going back, one after the other. Check the list, then review and send. Nothing goes until you confirm."
      backHref="/purchases"
      aside={
        <SectionCard title="Waiting to go back" description={returnUnits.length ? `${returnUnits.length} phone${returnUnits.length === 1 ? "" : "s"}` : undefined}>
          {mayDecide ? (
            <ol className="list-decimal space-y-1.5 pl-4 text-sm text-muted-foreground">
              <li>Scan or type every phone going back. Each one joins the list.</li>
              <li>Check the list against the phones in front of you. Remove any that should stay.</li>
              <li>Review and confirm. Only then do the phones leave stock.</li>
              {returnUnits.length ? <li>Faulty and returned phones waiting to go back can be added with one tap from Waiting to go back.</li> : null}
            </ol>
          ) : returnUnits.length ? (
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
        <SupplierReturnForm userId={me.id} waiting={returnUnits} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Sending goods back to a supplier is decided by the Vault Manager, the shop Manager, the CEO or the main admin.
          The phones waiting to go back are listed here for you to see.
        </p>
      )}
    </FormScreen>
  )
}
