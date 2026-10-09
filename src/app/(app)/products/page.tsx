import Link from "next/link"
import { getProductLookups, getProducts } from "@/app/actions/catalog"
import { ProductPriceList, type PriceRow } from "@/app/(app)/products/price-list"
import { PageHeader } from "@/components/shared"
import { canAddItemName, canChangePrices, canHardDelete, canManageCatalog, canSeePriceListCost } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { toPriceRow } from "./to-price-row"

/**
 * The price list, and nothing else.
 *
 * Adding an item, pasting a sheet of items and setting warranty days used to be
 * three forms stacked in a narrow column beside this table, which squeezed the
 * table that everybody actually opens this screen for. Each form is its own
 * screen now, under the Phones & items fold.
 */
export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams
  const me = await requireUser()
  const [products, canEdit, lookups] = await Promise.all([
    getProducts(),
    canManageCatalog(me.role),
    getProductLookups(),
  ])
  const canRemove = canHardDelete(me.role)
  const canAddName = await canAddItemName(me.role)
  const canPrice = canChangePrices(me.role)
  const showCost = canSeePriceListCost(me.role)
  const rows: PriceRow[] = products.map((product) => toPriceRow(product, showCost))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Price list"
        description={
          canRemove
            ? "Names, cost, lowest price, and selling price. Tick lines to change prices, or use Change or remove on a line to edit any detail, reduce stock, or take an item off the active list."
            : canPrice && canEdit
              ? "Names, cost, lowest price, and selling price. Tick lines to change selling prices, or use Change on a line to edit its details or reduce stock. Only the CEO or the main admin can remove an item."
              : canPrice
                ? "Names, cost, lowest price, and selling price. Tick lines to change selling prices, or use Prices on a line to set its cost, lowest and selling price. A price you set applies in every shop."
                : canEdit
                  ? "Names, lowest price, and selling price. Use Change on a line to edit its details or reduce stock. The CEO, the main admin or a branch manager changes prices."
                  : "Names, lowest price, and selling price. The CEO, the main admin or a branch manager changes prices."
        }
      />
      {!canEdit && !canPrice ? (
        <div className="surface-card p-5 text-sm text-muted-foreground">
          {canAddName ? (
            <>
              Prices on this list are read-only for your job. You can add a new item name from{" "}
              <Link href="/products/new" className="font-medium text-primary hover:underline">
                Add one item
              </Link>
              ; the CEO, the main admin or a branch manager sets its prices.
            </>
          ) : (
            "This list is read-only for your job. The stock uploader adds names; the CEO, the main admin or a branch manager changes prices."
          )}
        </div>
      ) : null}
      <ProductPriceList
        products={rows}
        canEdit={canEdit}
        canPrice={canPrice}
        showCost={showCost}
        canRemove={canRemove}
        initialQuery={q}
        brandNames={lookups.brands.map((row) => row.name)}
        categoryNames={lookups.categories.map((row) => row.name)}
      />
    </div>
  )
}
