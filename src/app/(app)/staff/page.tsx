import Link from "next/link"
import { Plus } from "lucide-react"
import { setStaffActive } from "@/app/actions/access"
import { getStaff, resetStaffPassword, updateStaff } from "@/app/actions/finance"
import { getBranches } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { PageHeader } from "@/components/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PasswordInput } from "@/components/ui/password-input"
import { Select } from "@/components/ui/select"
import { canManageStaff, canHardDelete, isShopOwner, isSuperAdmin, ROLE_LABELS } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { UserRole } from "@prisma/client"

export default async function StaffPage() {
  const me = await requireUser()
  const [staff, branches] = await Promise.all([getStaff(), getBranches()])
  const canAdd = await canManageStaff(me.role)
  const admin = isSuperAdmin(me.role)
  const owner = isShopOwner(me.role)
  const ceo = canHardDelete(me.role)
  const roles = (Object.keys(ROLE_LABELS) as UserRole[]).filter((role) => owner || role !== "SUPER_ADMIN")
  const activeShops = branches.filter((branch) => branch.isActive)

  return (
    <div className="space-y-5">
        <PageHeader
          title="Staff"
          description="People, their shop, and their job."
          actions={
            canAdd ? (
              <Button asChild>
                <Link href="/staff/new">
                  <Plus className="mr-1.5 h-4 w-4" /> Add a staff member
                </Link>
              </Button>
            ) : null
          }
        />
        <div className="grid items-start gap-3 lg:grid-cols-2">
          {staff.map((user) => {
            const canEditThis =
              canAdd &&
              user.id !== me.id &&
              (owner || (user.branchId && me.branchId && user.branchId === me.branchId)) &&
              (owner || user.role !== "SUPER_ADMIN") &&
              (me.role === "CEO" || user.role !== "CEO")

            return (
              <div key={user.id} className="surface-card p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{user.name}</p>
                    <p className="text-sm text-muted-foreground">{user.email}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge>{ROLE_LABELS[user.role]}</Badge>
                      <span className="text-sm text-muted-foreground">{user.branch?.name ?? "All shops"}</span>
                      <span className="text-xs text-muted-foreground">{user.isActive ? "Active" : "Disabled"}</span>
                    </div>
                  </div>
                  {ceo && user.id !== me.id && (admin || user.role !== "SUPER_ADMIN") && (me.role === "CEO" || user.role !== "CEO") ? (
                    <ActionForm
                      action={setStaffActive}
                      submit={user.isActive ? "Disable" : "Restore"}
                      size="sm"
                      variant="outline"
                      buttonClassName=""
                      successMessage={user.isActive ? "Login disabled" : "Login restored"}
                      resetOnSuccess={false}
                    >
                      <input type="hidden" name="id" value={user.id} />
                      <input type="hidden" name="active" value={user.isActive ? "false" : "true"} />
                    </ActionForm>
                  ) : null}
                </div>

                {canEditThis ? (
                  <details className="mt-3 rounded-lg border border-border px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium">Edit job or move shop</summary>
                    <ActionForm
                      action={updateStaff}
                      className="mt-3 grid gap-3 sm:grid-cols-2"
                      submit="Save staff"
                      successMessage="Staff updated"
                      resetOnSuccess={false}
                      buttonClassName="mt-1 sm:col-span-2"
                    >
                      <input type="hidden" name="id" value={user.id} />
                      <label className="block text-xs text-muted-foreground sm:col-span-2">
                        Full name
                        <Input name="name" defaultValue={user.name ?? ""} required className="mt-1" />
                      </label>
                      <label className="block text-xs text-muted-foreground">
                        Job
                        <Select name="role" defaultValue={user.role} className="mt-1">
                          {roles.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABELS[role]}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label className="block text-xs text-muted-foreground">
                        Shop
                        <Select name="branchId" defaultValue={user.branchId ?? ""} className="mt-1">
                          {owner ? <option value="">Head office / all shops</option> : null}
                          {(owner ? activeShops : activeShops.filter((branch) => branch.id === me.branchId)).map(
                            (branch) => (
                              <option key={branch.id} value={branch.id}>
                                {branch.name}
                              </option>
                            )
                          )}
                        </Select>
                      </label>
                    </ActionForm>
                  </details>
                ) : null}
                {canEditThis ? (
                  <details className="mt-2 rounded-lg border border-border px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium">Reset password</summary>
                    <ActionForm
                      action={resetStaffPassword}
                      className="mt-3 space-y-2"
                      submit="Set temporary password"
                      successMessage="Temporary password set"
                      buttonClassName="mt-1"
                    >
                      <input type="hidden" name="id" value={user.id} />
                      <label className="block text-xs text-muted-foreground">
                        Temporary password (at least 8 letters or numbers)
                        <PasswordInput name="newPassword" required minLength={8} autoComplete="new-password" className="mt-1" />
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Tell them in person. They sign in with {user.email} and this password, then must choose their own.
                      </p>
                    </ActionForm>
                  </details>
                ) : null}
              </div>
            )
          })}
          {staff.length === 0 ? (
            <p className="rounded-lg lg:col-span-2 border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
              No staff to show.
            </p>
          ) : null}
        </div>
    </div>
  )
}
