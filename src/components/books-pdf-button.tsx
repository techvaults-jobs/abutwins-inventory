"use client"

import { useState } from "react"
import { jsPDF } from "jspdf"
import type { BooksCheck } from "@/app/actions/books-check"
import { Button } from "@/components/ui/button"
import { booksCompareRows, booksMoneyLines, booksPeriodLabel, booksRangeTitle, formatPdfMoney, formatPdfMove } from "@/lib/books-pack"
import { letterheadFromCompany } from "@/lib/letterhead"
import { formatLagosStamp } from "@/lib/lagos-day"
import { drawPdfLetterhead, drawPdfPaperFooter, loadLogoDataUrl } from "@/lib/pdf-letterhead"
import { formatDateTime } from "@/lib/utils"

const NAVY: [number, number, number] = [0, 27, 206]
const INK: [number, number, number] = [15, 23, 42]
const MUTED: [number, number, number] = [100, 116, 139]
const LINE: [number, number, number] = [226, 232, 240]
const PAPER: [number, number, number] = [248, 250, 252]

export function BooksPdfButton({ data }: { data: BooksCheck }) {
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

      const period = booksPeriodLabel(data.range, data.from, data.to)
      const compared = booksPeriodLabel(data.range, data.priorFrom, data.priorTo)

      function footer() {
        drawPdfPaperFooter(doc, brand, page, data.statementRef)
      }

      function letterhead(full: boolean) {
        y = drawPdfLetterhead(doc, brand, {
          title: "Money report",
          subtitle: data.statementRef,
          meta: full
            ? [
                `${data.shopName} · ${data.shopCode}`,
                `This time: ${period}`,
                `Compared with: ${compared}`,
                `${booksRangeTitle(data.range)} · Lagos ${formatLagosStamp(new Date(data.preparedAt))}`,
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
        ensure(12)
        doc.setFillColor(...NAVY)
        doc.rect(left, y, width, 6.5, "F")
        doc.setTextColor(255, 255, 255)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.text(title.toUpperCase(), left + 2, y + 4.4)
        y += 9
      }

      function row(label: string, a: string, b?: string, c?: string, tint?: [number, number, number]) {
        ensure(7)
        if (tint) {
          doc.setFillColor(...tint)
          doc.rect(left, y - 3.4, width, 6.2, "F")
        }
        doc.setTextColor(...INK)
        doc.setFont("helvetica", "normal")
        doc.setFontSize(8)
        doc.text(label, left + 1, y)
        doc.setFont("helvetica", "bold")
        if (c != null && b != null) {
          doc.text(a, left + 92, y, { align: "right" })
          doc.setFont("helvetica", "normal")
          doc.setTextColor(...MUTED)
          doc.text(b, left + 138, y, { align: "right" })
          doc.setTextColor(...INK)
          doc.setFont("helvetica", "bold")
          doc.text(c, right - 1, y, { align: "right" })
        } else {
          doc.text(a, right - 1, y, { align: "right" })
        }
        y += 6
      }

      letterhead(true)

      const verdictFill = data.openCount ? [255, 241, 242] as [number, number, number] : [236, 253, 245] as [number, number, number]
      doc.setFillColor(...verdictFill)
      doc.roundedRect(left, y, width, 16, 1.5, 1.5, "F")
      doc.setFont("helvetica", "bold")
      doc.setFontSize(8)
      doc.setTextColor(...NAVY)
      doc.text(data.openCount ? `WHAT THE BOOKS SAY  ·  ${data.openCount} TO FIX` : "WHAT THE BOOKS SAY  ·  ALL CLEAR", left + 3, y + 5)
      doc.setFont("helvetica", "normal")
      doc.setTextColor(...INK)
      const verdict = doc.splitTextToSize(data.verdict, width - 6)
      doc.text(verdict, left + 3, y + 10)
      y += 20

      const boxes = [
        ["SALES", String(data.salesCount)],
        ["COLLECTED", formatPdfMoney(data.methodSum)],
        ["POSTED", formatPdfMoney(data.revenue)],
        ["MONEY OUT", formatPdfMoney(data.moneyOut)],
      ]
      boxes.forEach(([label, value], index) => {
        const x = left + index * (width / 4)
        doc.setFillColor(255, 255, 255)
        doc.setDrawColor(...LINE)
        doc.roundedRect(x, y, width / 4 - 2, 14, 1, 1, "FD")
        doc.setTextColor(...MUTED)
        doc.setFontSize(6.5)
        doc.setFont("helvetica", "bold")
        doc.text(label, x + 2, y + 4.5)
        doc.setTextColor(...NAVY)
        doc.setFontSize(9)
        doc.text(value, x + 2, y + 10.5)
      })
      y += 18

      section("This period against the other")
      doc.setTextColor(...MUTED)
      doc.setFontSize(7)
      doc.text("Line", left + 1, y)
      doc.text("This period", left + 92, y, { align: "right" })
      doc.text("Other period", left + 138, y, { align: "right" })
      doc.text("Difference", right - 1, y, { align: "right" })
      y += 5
      booksCompareRows(data).forEach((item, index) => {
        const now = item.money ? formatPdfMoney(item.now) : String(item.now)
        const then = item.money ? formatPdfMoney(item.then) : String(item.then)
        const move = formatPdfMove(item.change, item.money)
        row(item.label, now, then, move, index % 2 ? PAPER : undefined)
      })

      section("Money summary")
      booksMoneyLines(data).forEach((item, index) => {
        row(item.label, formatPdfMoney(item.value), undefined, undefined, item.total ? [232, 237, 255] : index % 2 ? PAPER : undefined)
      })

      section("Checks")
      data.papers.forEach((item, index) => {
        ensure(14)
        doc.setFillColor(item.ok ? 236 : 255, item.ok ? 253 : 241, item.ok ? 245 : 242)
        doc.roundedRect(left, y - 3, width, 12, 1, 1, "F")
        doc.setTextColor(...INK)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.text(`${index + 1}. ${item.label}`, left + 2, y + 1)
        doc.setTextColor(item.ok ? 5 : 190, item.ok ? 150 : 18, item.ok ? 105 : 60)
        doc.text(item.ok ? "CLEAR" : "FLAG", right - 2, y + 1, { align: "right" })
        doc.setFont("helvetica", "normal")
        doc.setTextColor(...MUTED)
        doc.setFontSize(7)
        doc.text(doc.splitTextToSize(item.detail, width - 28), left + 2, y + 6)
        y += 13
      })

      section("Payments received by staff")
      if (data.byStaff.length === 0) {
        row("No sales in this period", "")
      } else {
        data.byStaff.forEach((item, index) => {
          row(`${item.name}  ·  ${item.count} sale${item.count === 1 ? "" : "s"}`, formatPdfMoney(item.collected), undefined, undefined, index % 2 ? PAPER : undefined)
        })
      }

      section("Still owed")
      row("Customers still owe, in total", formatPdfMoney(data.customersOwe))
      row("Still owed to suppliers", formatPdfMoney(data.supplierOwed))
      row("Suppliers who owe us", formatPdfMoney(data.supplierCredit))
      row("Sales with no customer name", String(data.walkIns))
      row("Cash sales", formatPdfMoney(data.expectedCash), undefined, undefined, PAPER)

      section("Sales")
      if (data.invoices.length === 0) {
        row("No sales in this period", "")
      } else {
        data.invoices.forEach((item, index) => {
          row(
            `${item.invoice}  ${item.customer}`,
            item.method,
            formatDateTime(item.when),
            formatPdfMoney(item.paid),
            index % 2 ? PAPER : undefined
          )
        })
      }

      section("IMEI vs shop count")
      if (data.imeiRows.length === 0) {
        row("No phones or laptops on the IMEI list for this shop", "")
      } else {
        data.imeiRows.forEach((item, index) => {
          row(item.product, `${item.shopQty} / ${item.imeis}`, undefined, item.delta === 0 ? "Matched" : String(item.delta), index % 2 ? PAPER : undefined)
        })
      }

      ensure(42)
      y += 4
      section("Sign-off")
      const boxesW = (width - 8) / 3
      ;["Prepared by (Internal Auditor)", "Verified by (Financial Accountant)", "Approved by (Managing Director)"].forEach((title, index) => {
        const x = left + index * (boxesW + 4)
        doc.setTextColor(...MUTED)
        doc.setFontSize(7)
        doc.setFont("helvetica", "bold")
        doc.text(title.toUpperCase(), x, y)
        doc.setTextColor(...INK)
        doc.setFont("helvetica", "normal")
        doc.setFontSize(9)
        doc.text(index === 0 ? data.preparedBy || "Staff" : " ", x, y + 6)
        doc.setDrawColor(...NAVY)
        doc.line(x, y + 22, x + boxesW, y + 22)
        doc.setTextColor(...MUTED)
        doc.setFontSize(7)
        doc.text("Signature and date", x, y + 26)
      })
      y += 32
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
