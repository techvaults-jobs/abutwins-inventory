"use client"

import { TableDownload } from "@/components/table-download"

/** The supplier's account (every bill, then the totals) as Excel or CSV, built on the server page. */
export function SupplierBillsDownload({ filename, rows }: { filename: string; rows: Array<Array<string | number>> }) {
  return <TableDownload filename={filename} rows={() => rows} />
}
