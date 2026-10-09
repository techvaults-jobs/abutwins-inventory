import { createProduct, getProductLookups } from "@/app/actions/catalog"
import { ActionForm } from "@/components/action-form"
import { FormField, FormSection } from "@/components/form-field"
import { FormScreen, SectionCard } from "@/components/shared"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { SHOP_CONDITION_OPTIONS } from "@/lib/conditions"
import { TRACKING_OPTIONS } from "@/lib/unit-identity"
import { canAddItemName, setsStartingPrices } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { CatalogLocked } from "../catalog-locked"
import { ShopScopeFields } from "../shop-scope-fields"

const SUGGESTED_CATEGORIES = ["Phones", "Laptops", "Accessories", "Screen"]

/** Register one product name, with a brand, onto the list. */
export default async function NewProductPage() {
  const me = await requireUser()
  const [canAdd, canPrice] = await Promise.all([canAddItemName(me.role), setsStartingPrices(me.role)])
  if (!canAdd) return <CatalogLocked title="Add one item" />

  const lookups = await getProductLookups()
  const categoryChoices = [
    ...SUGGESTED_CATEGORIES,
    ...lookups.categories.map((row) => row.name).filter((name) => !SUGGESTED_CATEGORIES.includes(name)),
  ]

  return (
    <FormScreen
      backHref="/products"
      title="Add one item"
      description="Type the real product name, the same way you say it in the shop: iPhone 13, MacBook Pro M3, Type-C charger cord. Then pick the category that name belongs to."
      aside={
        <SectionCard title="What this does">
          <ul className="space-y-3 text-sm text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Product name</span> is the name staff pick later. Use the
              real model: iPhone 13, MacBook Pro M3, Galaxy S24, Type-C charger cord. Do not glue brand, storage, or
              How it looks into that name unless that is how the shop already says it.
            </li>
            <li>
              <span className="font-medium text-foreground">Category</span> groups those names: Phones, Laptops,
              Accessories, Screen. Type a new one if you need it. Brand is Apple, Tecno, and the rest.
            </li>
            <li>
              <span className="font-medium text-foreground">All shops or one shop</span> decides where the name first
              appears. All shops is the usual choice so every branch can pick it.
            </li>
            <li>
              <span className="font-medium text-foreground">This is not stock.</span> Saving a name does not put a unit
              on the shelf. Use Upload stock or One phone at a time for units.
            </li>
          </ul>
        </SectionCard>
      }
    >
      <ActionForm action={createProduct} submit="Save this product name" className="space-y-6">
        <FormSection title="The item">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Product name" className="sm:col-span-2">
              <Input name="name" placeholder="iPhone 13, MacBook Pro M3, or Type-C charger cord" required />
            </FormField>
            <FormField label="Brand name">
              <Input name="brandName" list="brand-names" placeholder="Apple, Tecno, or Generic" required />
              <datalist id="brand-names">
                {lookups.brands.map((brand) => (
                  <option key={brand.id} value={brand.name} />
                ))}
              </datalist>
            </FormField>
            <FormField label="Category">
              <Input name="categoryName" list="category-names" placeholder="Phones, Laptops, Accessories, or Screen" required />
              <datalist id="category-names">
                {categoryChoices.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </FormField>
            <FormField
              label="How we count it"
              hint="Tablets often have a serial number and no IMEI. You can still pick IMEI or serial on each unit when it is received."
            >
              <Select name="tracking" defaultValue="IMEI">
                {TRACKING_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="How it looks">
              <Select name="condition" defaultValue="BRAND_NEW">
                {SHOP_CONDITION_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <ShopScopeFields shops={lookups.branches.map(({ id, name, code }) => ({ id, name, code }))} />
        </FormSection>

        <FormSection title="Details (optional)">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Colour">
              <Input name="color" placeholder="Blue" />
            </FormField>
            <FormField label="Storage size">
              <Input name="storage" placeholder="128GB" />
            </FormField>
            <FormField label="Memory (RAM)">
              <Input name="ram" placeholder="8GB" />
            </FormField>
            <FormField label="Item code" hint="Leave empty and the system will make one." className="sm:col-span-3">
              <Input name="sku" />
            </FormField>
          </div>
        </FormSection>

        <FormSection title={canPrice ? "Prices (₦)" : "Warranty and note"}>
          {canPrice ? null : (
            <p className="mb-4 rounded-lg bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
              You add the name. The CEO, the main admin or your branch manager sets its cost, lowest and selling
              price, and they are told the moment you save. Until then the item cannot be sold at the till.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            {canPrice ? (
              <>
                <FormField label="Cost price" hint="What one unit cost us.">
                  <Input name="costPrice" type="number" inputMode="decimal" min={0} step="0.01" />
                </FormField>
                <FormField label="Lowest price" hint="Staff cannot sell below it. Empty means the selling price.">
                  <Input name="minimumPrice" type="number" inputMode="decimal" min={0} step="0.01" />
                </FormField>
                <FormField label="Selling price" hint="With a selling price the item sells at once.">
                  <Input name="sellingPrice" type="number" inputMode="decimal" min={0} step="0.01" />
                </FormField>
              </>
            ) : null}
            <FormField label="Warranty days" hint="0 means no warranty. Cashiers can add days on Sell now.">
              <Input name="warrantyDays" type="number" min={0} defaultValue={0} />
            </FormField>
            <FormField label="Short note (optional)" className="sm:col-span-2">
              <Textarea name="description" rows={2} placeholder="Anything staff should know about this item" />
            </FormField>
          </div>
        </FormSection>
      </ActionForm>
    </FormScreen>
  )
}
