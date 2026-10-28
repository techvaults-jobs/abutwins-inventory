import { saveSetting } from "@/app/actions/finance"
import { ActionForm } from "@/components/action-form"
import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"

export type SettingRow = { id: string; key: string; value: string; description: string | null }

export const settingLabels: Record<string, string> = {
  "company.name": "Shop name on invoices",
  "company.product": "System name",
  "company.phone": "Phone on invoices",
  "company.address": "Address on invoices",
  "company.email": "Email on invoices",
  "company.currency": "Currency",
  "sales.allow_below_minimum": "Let any seller go below the lowest allowed price?",
  "sales.block_until_day_closed": "Stop selling until yesterday's till is counted?",
  "incoming.dual_control": "Need a second person before received goods can be sold?",
  "inventory.low_stock_threshold": "Warn me when an item drops to this many",
  "sales.warranty_days": "Warranty days for a new item",
}

/**
 * One card per setting. Shared by Shop details and Selling rules, which are the
 * same grid over two different slices of the same table.
 */
export function SettingCards({ settings, canEdit }: { settings: SettingRow[]; canEdit: boolean }) {
  if (settings.length === 0) {
    return <div className="surface-card p-5 text-sm text-muted-foreground">Nothing to set here yet.</div>
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {settings.map((setting) => (
        <div key={setting.id} className="surface-card p-5">
          <p className="text-sm font-medium">{settingLabels[setting.key] ?? setting.key}</p>
          <p className="mb-3 text-xs text-muted-foreground">{setting.description}</p>
          {canEdit ? (
            <ActionForm action={saveSetting} submit="Update" className="space-y-3">
              <input type="hidden" name="key" value={setting.key} />
              {setting.key === "sales.allow_below_minimum" ||
              setting.key === "sales.block_until_day_closed" ||
              setting.key === "incoming.dual_control" ? (
                <Select name="value" defaultValue={setting.value}>
                  {setting.key === "sales.allow_below_minimum" ? (
                    <>
                      <option value="false">No. Only the CEO or Super Admin may go under it</option>
                      <option value="true">Yes. Any seller may go under it, and must say why</option>
                    </>
                  ) : setting.key === "sales.block_until_day_closed" ? (
                    <>
                      <option value="false">No. Remind the shop, but keep selling</option>
                      <option value="true">Yes. No new sale until the day is counted</option>
                    </>
                  ) : (
                    <>
                      <option value="true">Yes. First person checks; second person must say yes</option>
                      <option value="false">No. One person can put goods on the shelf alone</option>
                    </>
                  )}
                </Select>
              ) : (
                <Input name="value" defaultValue={setting.value} />
              )}
              {setting.key === "sales.allow_below_minimum" ? (
                <p className="text-xs text-muted-foreground">
                  On Sell now, each item&apos;s lowest allowed price is the floor. Sellers may price a deal
                  anywhere from that figure up, so a reseller price or a bulk discount needs nobody&apos;s
                  permission. There is no percentage limit. Going under the floor, or under what an item
                  cost us, always needs a reason and shows up on Price changes. With this set to No, the
                  CEO or Super Admin approves those prices on the seller&apos;s till with their own password.
                  With Yes, any seller may do it alone. The sale always records the price that was charged.
                </p>
              ) : null}
            </ActionForm>
          ) : (
            <p className="text-sm font-medium">{setting.value}</p>
          )}
        </div>
      ))}
    </div>
  )
}

/** Everything printed on a receipt belongs to Shop details; the rest are rules. */
export function isCompanySetting(key: string) {
  return key.startsWith("company.")
}
