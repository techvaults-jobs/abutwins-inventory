"use client"

import { toast } from "sonner"
import { exportShopBackup } from "@/app/actions/account"
import { Button } from "@/components/ui/button"
import { watDayKey } from "@/lib/lagos-day"

export function BackupButton() {
  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-12"
      onClick={async () => {
        const result = await exportShopBackup()
        if (result.error || !result.backup) {
          toast.error(result.error ?? "The backup did not work.")
          return
        }
        const blob = new Blob([JSON.stringify(result.backup, null, 2)], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.href = url
        link.download = `abutwins-backup-${watDayKey()}.json`
        link.click()
        URL.revokeObjectURL(url)
        toast.success("Backup downloaded. Keep it somewhere else, not on this computer.")
      }}
    >
      Download shop backup
    </Button>
  )
}
