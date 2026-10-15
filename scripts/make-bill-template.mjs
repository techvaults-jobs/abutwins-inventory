// Builds public/templates/supplier-bill-template.xlsx, the sheet staff
// download on Upload stock and Book goods coming to fill a bill from Excel.
//   node scripts/make-bill-template.mjs
import { writeFileSync } from "node:fs"
import XLSX from "xlsx"

const HEADER = [
  "PRODUCT NAME",
  "BRAND",
  "CATEGORY",
  "CONDITION",
  "SPECIFICATION",
  "TRACKING",
  "QTY/IMEI/SERIAL NO",
  "UNIT COST PRICE",
  "LOWEST SELLING PRICE",
  "STANDARD SELLING PRICE",
]

const tab = (rows) => {
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  sheet["!cols"] = HEADER.map((name) => ({ wch: Math.max(14, name.length + 2) }))
  return sheet
}

const guide = [
  ["HOW TO FILL THIS SHEET"],
  [],
  ["1. Put the stock on the PHONES, LAPTOPS or ACCESSORIES tab. Keep the header row exactly as it is."],
  ["2. Phones: ONE ROW FOR EACH PHONE, with its IMEI in QTY/IMEI/SERIAL NO. Laptops: one row each, with the serial."],
  ["3. Accessories: one row per item, with HOW MANY in QTY/IMEI/SERIAL NO."],
  ["4. CONDITION: Brand New, Brand New (Locked), Brand New (N/A), UK, UK (Locked), Open Box, Standard or Faulty."],
  ["5. SPECIFICATION: the storage, such as 128GB, 256GB or 1TB. TRACKING: IMEI, SERIAL or NONE."],
  ["6. UNIT COST PRICE is what ONE unit cost us. Numbers only; commas are fine, no ₦ needed."],
  ["7. BRAND must already be on the brand list (Phones & items, Brands)."],
  ["8. Do not add other tabs with names and IMEIs to tick. A tab without UNIT COST PRICE is left out."],
  ["9. On the system: Upload stock (or Book goods coming), then Fill this bill from an Excel sheet, then Choose the sheet."],
  [],
  ["EXAMPLE ROWS (do not copy these numbers; they are made up)"],
  HEADER,
  ["IPHONE 16", "APPLE", "PHONE", "BRAND NEW", "128GB", "IMEI", "350000000000001", "790,800", "820,800", "820,800"],
  ["IPHONE 16", "APPLE", "PHONE", "BRAND NEW", "128GB", "IMEI", "350000000000002", "790,800", "820,800", "820,800"],
  ["MACBOOK AIR M2", "APPLE", "LAPTOP", "UK", "256GB", "SERIAL", "C02XX0000001", "650,000", "700,000", "720,000"],
  ["20W CHARGER", "APPLE", "ACCESSORIES", "BRAND NEW", "", "NONE", "25", "5,000", "8,000", "9,000"],
]

const book = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(book, tab([HEADER]), "PHONES")
XLSX.utils.book_append_sheet(book, tab([HEADER]), "LAPTOPS")
XLSX.utils.book_append_sheet(book, tab([HEADER]), "ACCESSORIES")
const help = XLSX.utils.aoa_to_sheet(guide)
help["!cols"] = [{ wch: 28 }, ...HEADER.slice(1).map(() => ({ wch: 16 }))]
XLSX.utils.book_append_sheet(book, help, "HOW TO FILL")
writeFileSync(new URL("../public/templates/supplier-bill-template.xlsx", import.meta.url), XLSX.write(book, { type: "buffer", bookType: "xlsx" }))
console.log("Wrote public/templates/supplier-bill-template.xlsx")
