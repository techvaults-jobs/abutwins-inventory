import Link from "next/link"
import { Plus } from "lucide-react"
import { getExpenses } from "@/app/actions/finance"
import { PageHeader } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { canManageFinance, isShopOwner } from "@/lib/rbac"
import { requireUser } from "@/lib/session"
import { money } from "@/lib/utils"
import { ExpensesList } from "./expenses-list"

export default async function ExpensesPage() {
  const me = await requireUser()
  const [expenses, canPost] = await Promise.all([getExpenses(), canManageFinance(me.role)])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Shop expenses"
        description="Write the bill. A manager must say yes before money leaves. Cash bills cannot exceed cash in the till."
        actions={
          canPost ? (
            <Button asChild>
              <Link href="/expenses/new">
                <Plus className="mr-1.5 h-4 w-4" /> Ask for a shop bill
              </Link>
            </Button>
          ) : null
        }
      />
      <ExpensesList
        canFix={isShopOwner(me.role)}
        expenses={expenses.map((row) => ({
          id: row.id,
          description: row.description,
          expenseNumber: row.expenseNumber,
          category: row.category,
          amount: money(row.amount),
          when: (row.createdAt ?? row.date).toISOString(),
          approvedAt: row.approvedAt?.toISOString() ?? null,
          saidNo: row.saidNo,
          shop: row.branch.name ?? row.branch.code,
        }))}
      />
    </div>
  )
}
