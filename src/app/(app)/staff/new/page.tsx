import { redirect } from "next/navigation"
import { UserRole } from "@prisma/client"
import { createStaff } from "@/app/actions/finance"
import { getBranches } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { FormScreen } from "@/components/shared"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import { Select } from "@/components/ui/select"
import { canManageStaff, isShopOwner, ROLE_LABELS } from "@/lib/rbac"
import { requireUser } from "@/lib/session"

export default async function AddStaffPage() {
  const me = await requireUser()
  if (!(await canManageStaff(me.role))) redirect("/staff")
  const branches = await getBranches()
  const owner = isShopOwner(me.role)
  const roles = (Object.keys(ROLE_LABELS) as UserRole[]).filter((role) => owner || role !== "SUPER_ADMIN")
  const activeShops = branches.filter((branch) => branch.isActive)

  return (
    <FormScreen title="Add a staff member" description="They sign in with this email and must change the first password straight away." backHref="/staff">
      <ActionForm action={createStaff} submit="Create staff login" successMessage="Staff login created." successHref="/staff" className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Full name">
            <Input name="name" placeholder="Blessing Adeyemi" required autoFocus />
          </FormField>
          <FormField label="Work email">
            <Input name="email" type="email" placeholder="name@abutwins.com" required autoComplete="off" />
          </FormField>
          <FormField label="First password" hint="They must change it after they sign in." className="sm:col-span-2">
            <PasswordInput name="password" required autoComplete="new-password" />
          </FormField>
          <FormField label="Job">
            <Select name="role" defaultValue="SALES_EXECUTIVE">
              {roles.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Shop">
            <Select name="branchId">
              {owner ? <option value="">Head office / all shops</option> : null}
              {(owner ? activeShops : activeShops.filter((branch) => branch.id === me.branchId)).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </ActionForm>
    </FormScreen>
  )
}
