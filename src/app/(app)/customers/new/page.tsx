import { createCustomer, getBranches } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { FormField, FormSection } from "@/components/form-field"
import { FormScreen } from "@/components/shared"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"

export default async function AddCustomerPage() {
  const branches = await getBranches()
  return (
    <FormScreen title="Add a customer" description="One name and one phone for one buyer. Used on sales, credit and returns." backHref="/customers">
      <ActionForm action={createCustomer} submit="Save this customer" successMessage="Customer saved." successHref="/customers" className="space-y-6">
        <FormSection title="Who they are">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Full name">
              <Input name="name" required autoFocus />
            </FormField>
            <FormField label="Phone">
              <Input name="phone" type="tel" inputMode="tel" required />
            </FormField>
            <FormField label="Email (optional)">
              <Input name="email" type="email" />
            </FormField>
            <FormField label="Shop">
              <Select name="branchId" required>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Address (optional)" className="sm:col-span-2">
              <Input name="address" />
            </FormField>
          </div>
        </FormSection>
        <FormSection title="Money">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Opening balance they owe us" hint="Money this buyer already owed before this software. Leave at zero if they start clean. It can be added or corrected later on the customer's page.">
              <Input name="openingBalance" type="number" min={0} step="0.01" inputMode="decimal" placeholder="0" />
            </FormField>
            <FormField label="Credit limit" hint="The most they may owe at once. Zero means no credit.">
              <Input name="creditLimit" type="number" min={0} step="0.01" inputMode="decimal" placeholder="0" />
            </FormField>
          </div>
        </FormSection>
      </ActionForm>
    </FormScreen>
  )
}
