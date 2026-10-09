"use client"

import { useState } from "react"
import { jsPDF } from "jspdf"
import { Button } from "@/components/ui/button"
import { formatPdfMoney } from "@/lib/books-pack"
import { formatLagosStamp } from "@/lib/lagos-day"
import { letterheadFromCompany } from "@/lib/letterhead"
import { drawPdfLetterhead, drawPdfPaperFooter, loadLogoDataUrl } from "@/lib/pdf-letterhead"
import type { ReportsPack } from "@/lib/reports-pack"
import { reportsKpis } from "@/lib/reports-pack"
import { groupOwedHouses } from "@/lib/purchase-money"

const NAVY: [number, number, number] = [0, 27, 206]
const INK: [number, number, number] = [15, 23, 42]
const MUTED: [number, number, number] = [100, 116, 139]
const LINE: [number, number, number] = [226, 232, 240]
const PAPER: [number, number, number] = [248, 250, 252]

export function ReportsPdfButton({ data }: { data: ReportsPack }) {
  const [busy, setBusy] = useState(false)

  async function download() {
    setBusy(true)
    try {
      const brand = letterheadFromCompany(data.company)
      const mark = await loadLogoDataUrl(brand.logoSrc)
      const doc = new jsPDF({ unit: "mm", format: "a4" })
      const pageW = 210
      const pageH = 297
      const left = 12
      const right = pageW - 12
      const width = right - left
      let y = 0
      let page = 1

      function footer() {
        drawPdfPaperFooter(doc, brand, page, data.statementRef)
      }

      function letterhead(full: boolean) {
        y = drawPdfLetterhead(doc, brand, {
          title: "Management report",
          subtitle: data.statementRef,
          meta: full
            ? [
                `Scope: ${data.scope}`,
                `Period: ${data.periodLabel}`,
                `Prepared by ${data.preparedBy}`,
                `Lagos ${formatLagosStamp(new Date(data.preparedAt))}`,
              ]
            : undefined,
          logo: mark,
          full,
        })
      }

      function ensure(space: number) {
        if (y + space < pageH - 16) return
        footer()
        doc.addPage()
        page += 1
        letterhead(false)
      }

      function section(title: string) {
        ensure(10)
        doc.setFillColor(...NAVY)
        doc.rect(left, y, width, 6.2, "F")
        doc.setTextColor(255, 255, 255)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.text(title.toUpperCase(), left + 2, y + 4.2)
        y += 9
      }

      function row(label: string, value: string, tint?: [number, number, number]) {
        ensure(6.5)
        if (tint) {
          doc.setFillColor(...tint)
          doc.rect(left, y - 3.2, width, 6, "F")
        }
        doc.setTextColor(...INK)
        doc.setFont("helvetica", "normal")
        doc.setFontSize(8)
        doc.text(label, left + 1, y)
        doc.setFont("helvetica", "bold")
        doc.text(value, right - 1, y, { align: "right" })
        y += 5.6
      }

      letterhead(true)

      const kpis = reportsKpis(data)
      kpis.forEach((item, index) => {
        const col = index % 4
        const rowIndex = Math.floor(index / 4)
        const boxW = width / 4 - 1.5
        const x = left + col * (width / 4)
        const boxY = y + rowIndex * 15
        doc.setDrawColor(...LINE)
        doc.setFillColor(255, 255, 255)
        doc.roundedRect(x, boxY, boxW, 13.5, 1, 1, "FD")
        doc.setTextColor(...MUTED)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(6)
        doc.text(item.label.toUpperCase(), x + 2, boxY + 4.2)
        doc.setTextColor(...NAVY)
        doc.setFontSize(9)
        doc.text(item.money ? formatPdfMoney(item.value) : String(item.value), x + 2, boxY + 10)
      })
      y += 34

      section("Sales by shop")
      // Total Cost goes in for the people who see cost; the columns close up
      // to make room.
      const withCost = data.stockBasis === "cost"
      const col = withCost
        ? { sales: left + 76, revenue: left + 112, cost: left + 146 }
        : { sales: left + 92, revenue: left + 138, cost: 0 }
      doc.setTextColor(...MUTED)
      doc.setFontSize(7)
      doc.text("Branch", left + 1, y)
      doc.text("Sales", col.sales, y, { align: "right" })
      doc.text("Total Sales", col.revenue, y, { align: "right" })
      if (withCost) doc.text("Total Cost", col.cost, y, { align: "right" })
      doc.text("Payments Received", right - 1, y, { align: "right" })
      y += 5
      if (data.byShop.length === 0) {
        row("No completed sales in this period", "")
      } else {
        data.byShop.forEach((item, index) => {
          ensure(6.5)
          if (index % 2) {
            doc.setFillColor(...PAPER)
            doc.rect(left, y - 3.2, width, 6, "F")
          }
          doc.setTextColor(...INK)
          doc.setFont("helvetica", "normal")
          doc.setFontSize(8)
          doc.text(item.name, left + 1, y)
          doc.text(String(item.tickets), col.sales, y, { align: "right" })
          doc.setFont("helvetica", "bold")
          doc.text(formatPdfMoney(item.revenue), col.revenue, y, { align: "right" })
          if (withCost) doc.text(formatPdfMoney(item.cost), col.cost, y, { align: "right" })
          doc.text(formatPdfMoney(item.collected), right - 1, y, { align: "right" })
          y += 5.6
        })
      }

      section("Customers who still owe us")
      if (data.debtors.length === 0) {
        row("Nobody owes us money right now", "")
      } else {
        data.debtors.forEach((item, index) => {
          row(`${item.name}  ·  ${item.shop}`, formatPdfMoney(item.amount), index % 2 ? PAPER : undefined)
        })
      }

      section("Still owed to suppliers")
      if (data.creditors.length === 0) {
        row("Nothing is owed to suppliers", "")
      } else {
        const houses = groupOwedHouses(data.creditors)
        houses.forEach((house, houseIndex) => {
          row(house.name, formatPdfMoney(house.owed), houseIndex % 2 ? PAPER : undefined)
          house.bills.forEach((item) => {
            row(`  ${item.invoice}  ·  ${item.shop}`, formatPdfMoney(item.owed), houseIndex % 2 ? PAPER : undefined)
          })
        })
      }

      section("Suppliers who owe us")
      if ((data.supplierCredits ?? []).length === 0) {
        row("No supplier owes us after send-backs", "")
      } else {
        const houses = groupOwedHouses(data.supplierCredits ?? [])
        houses.forEach((house, houseIndex) => {
          row(house.name, formatPdfMoney(house.owed), houseIndex % 2 ? PAPER : undefined)
          house.bills.forEach((item) => {
            row(`  ${item.invoice}  ·  ${item.shop}`, formatPdfMoney(item.owed), houseIndex % 2 ? PAPER : undefined)
          })
        })
      }

      section("Returns to suppliers")
      if (!(data.supplierReturns ?? []).length) {
        row("Nothing was sent back to a supplier in this period", "")
      } else {
        ;(data.supplierReturns ?? []).forEach((house, houseIndex) => {
          const tint = houseIndex % 2 ? PAPER : undefined
          row(`${house.supplier}  ·  ${house.units} unit${house.units === 1 ? "" : "s"}`, formatPdfMoney(house.value), tint)
          house.lines.forEach((line) => {
            row(`  ${line.reference}  ·  ${line.item}  ·  ${line.imei}  ·  ${line.shop}`, formatPdfMoney(line.value), tint)
          })
        })
      }

      section("Low stock warning")
      if (data.lowStock.length === 0) {
        row("No items below the low-stock warning", "")
      } else {
        data.lowStock.forEach((item, index) => {
          row(`${item.product}  ·  ${item.shop}`, `${item.quantity} / min ${item.min}`, index % 2 ? PAPER : undefined)
        })
      }

      y += 4
      doc.setFontSize(7)
      doc.setTextColor(...MUTED)
      doc.text("Software by Techvaults Limited. This paper does not change any sale.", left, y)

      footer()
      doc.save(`${data.statementRef}.pdf`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button type="button" onClick={download} disabled={busy} className="print:hidden">
      {busy ? "Getting the PDF ready" : "Download PDF"}
    </Button>
  )
}
