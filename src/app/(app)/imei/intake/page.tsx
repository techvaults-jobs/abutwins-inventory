import { getImeiStatusCounts } from "@/app/actions/imei"
import { getProducts } from "@/app/actions/catalog"
import { getBranches, getSuppliers } from "@/app/actions/parties"
import { ImeiIntakeForm } from "@/app/(app)/imei/intake-form"
import { PageHeader, SectionCard, StatCard, StatGrid } from "@/components/shared"
import { formatCondition } from "@/lib/status"
import { canChangeCost } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { money } from "@/lib/utils"

/**
 * Stock intake on its own screen.
 *
 * It used to be a narrow card beside the IMEI table, so the form was cramped and
 * the table was cramped, and the two had nothing to do with each other: one is
 * for looking a phone up, the other is for putting one on the shelf.
 */
export default async function ImeiIntakePage() {
  // The form carries cost, so only whoever may change cost (CEO, main admin, branch manager) types prices on it.
  const canPrice = canChangeCost((await requireUser()).role)
  const [counts, branches, suppliers, products] = await Promise.all([
    getImeiStatusCounts(),
    getBranches(),
    getSuppliers(),
    getProducts(),
  ])

  return (
    <div className="space-y-6">
      <PageHeader
        title="One phone at a time"
        description="Put a phone in your hands onto the shelf. Set cost, lowest sell, and selling price on the same save."
      />

      <StatGrid>
        <StatCard label="In shop now" value={counts.byStatus.IN_STOCK ?? 0} tone="success" href="/imei?status=IN_STOCK" />
        <StatCard label="On the way" value={counts.byStatus.INCOMING ?? 0} tone="primary" href="/imei?status=INCOMING" />
        <StatCard label="Damaged" value={counts.byStatus.FAULTY ?? 0} tone="danger" href="/imei?status=FAULTY" />
        <StatCard label="Every phone ever" value={counts.total} href="/imei" />
      </StatGrid>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
        <SectionCard title="Receive one phone">
          <ImeiIntakeForm
            products={products.map((product) => ({
              id: product.id,
              name: [product.name, product.storage, formatCondition(product.condition), product.color]
                .filter(Boolean)
                .join(" · "),
              tracking: product.tracking,
              costPrice: canPrice ? money(product.costPrice) : 0,
              minimumPrice: money(product.minimumPrice),
              sellingPrice: money(product.sellingPrice),
              stockByBranch: product.inventory.map((row) => ({
                branchId: row.branchId,
                quantity: row.quantity,
              })),
            }))}
            branches={branches.map((branch) => ({ id: branch.id, name: branch.name }))}
            suppliers={suppliers.map((supplier) => ({ id: supplier.id, name: supplier.name }))}
            canPrice={canPrice}
          />
        </SectionCard>

        <SectionCard title="When to use this instead of Upload stock">
          <ul className="space-y-3 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">One phone in your hand:</span> this screen. A swap device, a
              phone back from a repair, a single unit a supplier dropped off. Fill cost, lowest sell, and selling price
              so the price list stays true. A phone is always quantity 1.
            </li>
            <li>
              <span className="font-medium text-foreground">A cord or other no-number item:</span> pick that item, type
              how many pieces, and the same prices. Quantity is for those lines only.
            </li>
            <li>
              <span className="font-medium text-foreground">A whole carton with a bill:</span> use{" "}
              <span className="font-medium text-foreground">Upload stock → Supplier bill</span>, so what you owe the
              supplier is recorded with it. This screen updates item prices. It does not post a supplier bill.
            </li>
            <li>
              <span className="font-medium text-foreground">A phone that is already on the system:</span> nothing
              breaks. The record that is already there is left as it is.
            </li>
          </ul>
        </SectionCard>
      </div>
    </div>
  )
}
