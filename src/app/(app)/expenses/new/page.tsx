import { redirect } from "next/navigation"
import { createExpense, getFinance } from "@/app/actions/finance"
import { getBranches } from "@/app/actions/parties"
import { ActionForm } from "@/components/action-form"
import { FormField } from "@/components/form-field"
import { FormScreen } from "@/components/shared"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { canManageFinance } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { cashHeldForBills, shopCashOnHand } from "@/lib/shop-cash"
import { formatCurrency } from "@/lib/utils"

const CATEGORIES = [
  ["TRANSPORT", "Transport"],
  ["FUEL", "Fuel"],
  ["RENT", "Rent"],
  ["UTILITIES", "Light bill"],
  ["REPAIRS", "Repairs"],
  ["SALARY", "Salary"],
  ["MARKETING", "Marketing"],
  ["MISCELLANEOUS", "Other shop bill"],
] as const

export default async function AskForShopBillPage() {
  const me = await requireUser()
  if (!(await canManageFinance(me.role))) redirect("/expenses")
  const branches = await getBranches()
  const shopId = me.branchId || branches[0]?.id
  // The same figures the till check uses when the bill is saved, so the
  // amount offered here is the amount that will be let through.
  const [till, pendingWaiting] = shopId
    ? await Promise.all([shopCashOnHand(shopId), cashHeldForBills(shopId)])
    : [null, 0]
  // Only with no shop at all does it fall back to the all-shops cash balance.
  const finance = till ? null : await getFinance()
  const cashBalance = till ? till.available : finance!.cashAccount.balance
  const held = till ? pendingWaiting : finance!.cashHeldForBills
  const cashReady = Math.max(0, cashBalance - held)

  return (
    <FormScreen
      title="Ask for a shop bill"
      description="A manager must say yes before money leaves."
      backHref="/expenses"
    >
      <div
        className={`mb-5 rounded-lg px-4 py-3 text-sm ${cashReady > 0 ? "bg-muted/60 text-muted-foreground" : "bg-warning-soft text-warning"}`}
      >
        Cash in the till now: <span className="font-semibold tabular-nums text-foreground">{formatCurrency(cashBalance)}</span>
        {held > 0 ? (
          <>
            {" "}· {formatCurrency(held)} held for bills waiting for yes · Free for this bill:{" "}
            <span className="font-semibold tabular-nums text-foreground">{formatCurrency(cashReady)}</span>
          </>
        ) : null}
        .
        {cashReady <= 0
          ? " There is no cash to take out. Collect a cash sale first, or pay from the bank."
          : " A cash bill cannot be more than this."}
      </div>
      <ActionForm action={createExpense} submit="Save this shop bill" successMessage="Shop bill saved. Waiting for a manager." successHref="/expenses" className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Shop">
            <Select name="branchId" required defaultValue={shopId || undefined}>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="What kind of bill">
            <Select name="category" defaultValue="MISCELLANEOUS">
              {CATEGORIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Amount (₦)">
            <Input name="amount" type="number" inputMode="decimal" min={0} required max={cashReady > 0 ? cashReady : undefined} autoFocus />
          </FormField>
          <FormField label="What this bill is for">
            <Input name="description" placeholder="Generator fuel for Saturday" required />
          </FormField>
        </div>
      </ActionForm>
    </FormScreen>
  )
}
