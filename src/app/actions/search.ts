"use server"

import { prisma } from "@/lib/prisma"
import { getAllowedKeys } from "@/lib/permissions"
import { requireUser } from "@/lib/session"
import { canSeeAllBranches } from "@/lib/rbac"

export async function globalSearch(query: string) {
  const user = await requireUser()
  const q = query.trim()
  if (q.length < 2) return []

  const views = await getAllowedKeys(user.role)
  const allBranches = await canSeeAllBranches(user.role)
  const branchFilter = user.branchId && !allBranches
    ? { branchId: user.branchId }
    : {}

  const [imeis, customers, sales, products, purchases, transfers, repairs] = await Promise.all([
    views.has("view.imei") ? prisma.imeiRecord.findMany({
      where: {
        ...branchFilter,
        OR: [
          { imei1: { contains: q, mode: "insensitive" } },
          { imei2: { contains: q, mode: "insensitive" } },
          { serialNumber: { contains: q, mode: "insensitive" } },
        ],
      },
      include: { product: true, branch: true, purchase: { select: { invoiceNumber: true } } },
      take: 6,
    }) : [],
    views.has("view.customers") ? prisma.customer.findMany({
      where: {
        ...branchFilter,
        OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q, mode: "insensitive" } }],
      },
      take: 5,
    }) : [],
    views.has("view.sales") ? prisma.sale.findMany({
      where: {
        ...branchFilter,
        OR: [{ invoiceNumber: { contains: q, mode: "insensitive" } }],
      },
      include: { customer: true },
      take: 5,
    }) : [],
    views.has("view.products") ? prisma.product.findMany({
      where: {
        OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }],
      },
      take: 5,
    }) : [],
    views.has("view.purchases") ? prisma.purchase.findMany({
      where: {
        ...branchFilter,
        OR: [
          { invoiceNumber: { contains: q, mode: "insensitive" } },
          { supplier: { name: { contains: q, mode: "insensitive" } } },
          { items: { some: { product: { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] } } } },
          {
            imeiRecords: {
              some: {
                OR: [
                  { imei1: { contains: q, mode: "insensitive" } },
                  { imei2: { contains: q, mode: "insensitive" } },
                  { serialNumber: { contains: q, mode: "insensitive" } },
                ],
              },
            },
          },
        ],
      },
      include: { supplier: true, items: { include: { product: true } } },
      take: 6,
    }) : [],
    views.has("view.transfers") ? prisma.stockTransfer.findMany({
      where: {
        transferNumber: { contains: q, mode: "insensitive" },
        ...(user.branchId && !allBranches
          ? { OR: [{ fromBranchId: user.branchId }, { toBranchId: user.branchId }] }
          : {}),
      },
      take: 4,
    }) : [],
    views.has("view.repairs") ? prisma.repair.findMany({
      where: {
        ...branchFilter,
        OR: [{ repairNumber: { contains: q, mode: "insensitive" } }, { imei: { imei1: { contains: q, mode: "insensitive" } } }],
      },
      include: { imei: true },
      take: 4,
    }) : [],
  ])

  return [
    ...imeis.map((item) => ({
      kind: "IMEI",
      id: item.id,
      title: item.imei1,
      hint: `${item.product.name} · ${item.branch.code}${item.purchase ? ` · bill ${item.purchase.invoiceNumber}` : ""}`,
      href: `/imei/${item.id}`,
    })),
    ...customers.map((item) => ({
      kind: "Customer",
      id: item.id,
      title: item.name,
      hint: item.phone,
      href: `/customers/${item.id}`,
    })),
    ...sales.map((item) => ({
      kind: "Invoice",
      id: item.id,
      title: item.invoiceNumber,
      hint: item.customer?.name ?? "Walk-in",
      href: `/sales/${item.id}`,
    })),
    ...products.map((item) => ({
      kind: "Product",
      id: item.id,
      title: item.name,
      hint: item.sku,
      href: "/products",
    })),
    ...purchases.map((item) => ({
      kind: "Supplier bill",
      id: item.id,
      title: item.invoiceNumber,
      hint: `${item.supplier.name}${item.items[0] ? ` · ${item.items[0].product.name}` : ""}`,
      href: `/purchases/${item.id}`,
    })),
    ...transfers.map((item) => ({
      kind: "Transfer",
      id: item.id,
      title: item.transferNumber,
      hint: item.status,
      href: "/transfers",
    })),
    ...repairs.map((item) => ({
      kind: "Repair",
      id: item.id,
      title: item.repairNumber,
      hint: item.imei.imei1,
      href: "/repairs",
    })),
  ]
}
