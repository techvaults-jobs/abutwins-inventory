import { getSettings } from "@/app/actions/finance"
import { PageHeader } from "@/components/shared"
import { can } from "@/lib/permissions"
import { requireUser } from "@/lib/session"
import { SettingCards, isCompanySetting } from "../setting-cards"

/** The rules the shop runs on: price floor, low stock warning, warranty. */
export default async function SettingsRulesPage() {
  const [me, settings] = await Promise.all([requireUser(), getSettings()])
  const canEdit = await can(me.role, "action.settings")

  return (
    <div className="space-y-6">
      <PageHeader
        title="Selling rules"
        description="Lowest price, low-stock warning, and warranty days."
      />
      {!canEdit ? (
        <div className="surface-card p-5 text-sm text-muted-foreground">
          These rules are read-only for your job. Only Super Admin can change them.
        </div>
      ) : null}
      <SettingCards settings={settings.filter((row) => !isCompanySetting(row.key) && row.key !== "sales.block_until_day_closed")} canEdit={canEdit} />
    </div>
  )
}
