"use client"

import { useMemo, useState } from "react"
import type { RoleManual } from "@/lib/manual"
import { manualHaystack } from "@/lib/manual"
import { Input } from "@/components/ui/input"

export function ManualLookup({ data }: { data: RoleManual }) {
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()

  const matches = useMemo(() => {
    if (!needle) return new Set(data.sections.map((row) => row.id))
    return new Set(data.sections.filter((row) => manualHaystack(row).includes(needle)).map((row) => row.id))
  }, [data.sections, needle])

  return (
    <div className="manual-lookup print:hidden">
      <label className="block text-sm">
        <span className="mb-1 block text-muted-foreground">Find a page, a button, or a word</span>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Try: waiting sale, IMEI, swap, return"
        />
      </label>
      {needle ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {matches.size} section{matches.size === 1 ? "" : "s"} match. Print still includes the full book for this job.
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Jump from the contents, or type a word. This book only covers pages your job can open.
        </p>
      )}
      <style>{`
        ${needle ? data.sections.filter((row) => !matches.has(row.id)).map((row) => `[data-manual-id="${row.id}"]{display:none}`).join("") : ""}
        @media print {
          .manual-section { display: block !important; }
        }
      `}</style>
    </div>
  )
}
