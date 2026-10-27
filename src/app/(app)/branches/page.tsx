import Link from "next/link"
import { Plus } from "lucide-react"
import { deleteBranch, getBranches, toggleBranch, updateBranch } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { PageHeader } from "@/components/shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { isShopOwner } from "@/lib/rbac"
import { requireUser } from "@/lib/session"

async function toggle(formData: FormData) {
  "use server"
  await toggleBranch(String(formData.get("id")))
}

function ShopCard({
  branch,
  canEdit,
}: {
  branch: Awaited<ReturnType<typeof getBranches>>[number]
  canEdit: boolean
}) {
  return (
    <div className="surface-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">
            {branch.name}
            {branch.isHq ? " · HQ" : ""}
          </p>
          <p className="text-sm text-muted-foreground">
            {branch.code} · {branch.address}
          </p>
          {(branch.phone || branch.email) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {[branch.phone, branch.email].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <Badge variant={!branch.isActive ? "danger" : branch.isHq ? "info" : "success"}>
          {!branch.isActive ? "Closed" : branch.isHq ? "Head office" : "Open"}
        </Badge>
      </div>
      <p className="mt-4 text-sm text-muted-foreground">
        {branch._count.users} staff · {branch._count.sales} sales · {branch._count.imeiRecords} phones
      </p>
      {canEdit ? (
        <div className="mt-3 space-y-3">
          <form action={toggle}>
            <input type="hidden" name="id" value={branch.id} />
            <Button size="sm" variant="outline">
              {branch.isActive ? "Close this shop" : "Open this shop"}
            </Button>
          </form>
          <details className="rounded-lg border border-border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Edit shop details</summary>
            <ActionForm
              action={updateBranch}
              className="mt-3 space-y-2"
              submit="Save shop details"
              successMessage="Branch details updated"
              resetOnSuccess={false}
              buttonClassName="mt-2"
            >
              <input type="hidden" name="id" value={branch.id} />
              <label className="block text-xs text-muted-foreground">
                Shop name
                <Input name="name" defaultValue={branch.name} required className="mt-1" />
              </label>
              <label className="block text-xs text-muted-foreground">
                Short code
                <Input name="code" defaultValue={branch.code} required className="mt-1" />
              </label>
              <label className="block text-xs text-muted-foreground">
                Address
                <Input name="address" defaultValue={branch.address} required className="mt-1" />
              </label>
              <label className="block text-xs text-muted-foreground">
                Phone
                <Input name="phone" defaultValue={branch.phone ?? ""} className="mt-1" />
              </label>
              <label className="block text-xs text-muted-foreground">
                Email
                <Input name="email" defaultValue={branch.email ?? ""} className="mt-1" />
              </label>
            </ActionForm>
          </details>
          <ActionForm
            action={deleteBranch}
            submit="Delete this shop"
            variant="destructive"
            successMessage="Shop deleted"
            confirmModal={{
              title: `Delete ${branch.name} for good?`,
              description:
                "Only a shop with no staff, sales, phones or supplier bills can be deleted. A shop that has traded is closed instead, so its records stay.",
              confirmLabel: "Delete shop",
              tone: "danger",
            }}
          >
            <input type="hidden" name="id" value={branch.id} />
          </ActionForm>
        </div>
      ) : null}
    </div>
  )
}

export default async function BranchesPage() {
  const [me, branches] = await Promise.all([requireUser(), getBranches()])
  const open = branches.filter((branch) => branch.isActive)
  const closed = branches.filter((branch) => !branch.isActive)
  const admin = isShopOwner(me.role)
  return (
    <div className="space-y-5">
        <PageHeader
          title="Shops"
          description="Open or close a shop. Each shop keeps its own records."
          actions={
            admin ? (
              <Button asChild>
                <Link href="/branches/new">
                  <Plus className="mr-1.5 h-4 w-4" /> Open a shop
                </Link>
              </Button>
            ) : null
          }
        />
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {open.map((branch) => (
            <ShopCard key={branch.id} branch={branch} canEdit={admin} />
          ))}
        </div>
        {admin && closed.length ? (
          <div className="mt-8">
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Closed shops</h3>
            <p className="mb-3 text-sm text-muted-foreground">
              Old sales stay. Closed shops do not show on Sell now.
            </p>
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {closed.map((branch) => (
                <ShopCard key={branch.id} branch={branch} canEdit />
              ))}
            </div>
          </div>
        ) : null}
    </div>
  )
}
