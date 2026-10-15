import { createSupplier, getBranches } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { FormField, FormSection } from "@/components/form-field"
import { FormScreen } from "@/components/shared"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"

export default async function AddSupplierPage() {
  const branches = await getBranches()
  const activeShops = branches.filter((branch) => branch.isActive)
  return (
    <FormScreen title="Add a supplier" description="One name and one phone for one house. A second copy of the same house is refused." backHref="/suppliers">
      <ActionForm action={createSupplier} submit="Save this supplier" successMessage="Supplier saved." successHref="/suppliers" className="space-y-6">
        <FormSection title="The house">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Kind of supplier" className="sm:col-span-2">
              <Select name="kind" defaultValue="SUPPLIER">
                <option value="SUPPLIER">Supplier of cartons</option>
                <option value="NEIGHBOR">Neighbouring shop we fill from</option>
              </Select>
            </FormField>
            <FormField label="Name">
              <Input name="name" required autoFocus />
            </FormField>
            <FormField label="Phone">
              <Input name="phone" type="tel" inputMode="tel" required />
            </FormField>
            <FormField label="Country (optional)">
              <Input name="country" placeholder="China, UAE, Nigeria" />
            </FormField>
            <FormField label="City or market (optional)">
              <Input name="city" placeholder="Shenzhen, Alaba, Computer Village" />
            </FormField>
            <FormField label="Contact person (optional)">
              <Input name="contactPerson" />
            </FormField>
            <FormField label="Email (optional)">
              <Input name="email" type="email" />
            </FormField>
            <FormField label="Address (optional)" className="sm:col-span-2">
              <Input name="address" />
            </FormField>
          </div>
        </FormSection>
        <FormSection title="What we already owe them">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Shop for the opening balance">
              <Select name="branchId" defaultValue={activeShops[0]?.id}>
                {activeShops.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Opening balance" hint="What stood before this software. A minus in front (−1400000): we owed them. No sign: they owed us. Leave at zero to start clean. It can be changed later on the supplier's page.">
              <Input name="openingBalance" type="number" step="0.01" inputMode="decimal" placeholder="0" />
            </FormField>
          </div>
        </FormSection>
      </ActionForm>
    </FormScreen>
  )
}
