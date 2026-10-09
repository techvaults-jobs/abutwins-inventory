import {
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  Building2,
  ClipboardCheck,
  DatabaseBackup,
  Factory,
  FolderTree,
  FileSpreadsheet,
  Gauge,
  GitBranch,
  LayoutDashboard,
  ListOrdered,
  Lock,
  Package,
  PackagePlus,
  PlusCircle,
  Receipt,
  Repeat2,
  Scale,
  ScanLine,
  ScrollText,
  History,
  Settings,
  Shield,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  SlidersHorizontal,
  Store,
  Tags,
  TrendingUp,
  Truck,
  Undo2,
  Upload,
  UserRoundCog,
  Users,
  Wallet,
  Wrench,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

/**
 * One section of a bigger screen, living on its own route.
 *
 * Screens like Upload stock used to stack four unrelated jobs on one page and
 * staff scrolled past three of them to reach the one they came for. Each job is
 * its own route now, and the routes show up twice: folded under the parent in
 * the sidebar, and as a tab strip at the top of the screen.
 */
export type NavChild = {
  name: string
  href: string
  icon?: LucideIcon
  /** One line under the tab, so the split is self-explaining. */
  hint?: string
}

export type NavItem = {
  name: string
  href: string
  icon: LucideIcon
  children?: NavChild[]
}

export type NavGroup = {
  label: string
  items: NavItem[]
}

/**
 * Six areas, in the order a shop day runs: what needs doing today, selling,
 * stock, money, keeping watch, and setting up. Every page is still here; the
 * menu only shows the ones a job may open, and Ctrl K reaches any of them.
 */
export const navGroups: NavGroup[] = [
  {
    label: "Today",
    items: [
      { name: "Home", href: "/dashboard", icon: LayoutDashboard },
      { name: "Sell now", href: "/pos", icon: Store },
      { name: "Balance the till", href: "/finance/close", icon: ClipboardCheck },
      { name: "Needs approval", href: "/approvals", icon: BadgeCheck },
    ],
  },
  {
    label: "Sell",
    items: [
      { name: "Sales", href: "/sales", icon: ShoppingCart },
      {
        name: "Returns",
        href: "/returns",
        icon: Undo2,
        children: [
          { name: "All returns", href: "/returns", icon: Undo2, hint: "Waiting, approved and done" },
          { name: "Log a return", href: "/returns/new", icon: PlusCircle, hint: "By IMEI, or by invoice for pieces" },
        ],
      },
      {
        name: "Swap Deal",
        href: "/swaps",
        icon: Repeat2,
        children: [
          { name: "All swap deals", href: "/swaps", icon: Repeat2, hint: "Waiting, approved and done" },
          { name: "Start a swap", href: "/swaps/new", icon: PlusCircle, hint: "Customer's phone in, shop phone out" },
        ],
      },
      {
        name: "Repairs",
        href: "/repairs",
        icon: Wrench,
        children: [
          { name: "All repairs", href: "/repairs", icon: Wrench, hint: "Every job on the bench" },
          { name: "Open a repair", href: "/repairs/new", icon: PlusCircle, hint: "Scan the phone, say what is wrong" },
        ],
      },
      {
        name: "Customers & money owed",
        href: "/customers",
        icon: Users,
        children: [
          { name: "All customers", href: "/customers", icon: Users, hint: "Who bought, paid and still owes" },
          { name: "Add a customer", href: "/customers/new", icon: PlusCircle, hint: "One name and one phone for one buyer" },
        ],
      },
    ],
  },
  {
    label: "Stock",
    items: [
      { name: "Shop stock", href: "/inventory", icon: Boxes },
      {
        name: "Phones & items",
        href: "/products",
        icon: Smartphone,
        children: [
          { name: "Price list", href: "/products", icon: Tags, hint: "Names, cost, lowest price, and selling price" },
          { name: "Item activity", href: "/products/activity", icon: History, hint: "One item's whole life: booked in, sold, moved, returned" },
          { name: "Brands", href: "/products/brands", icon: Factory, hint: "Samsung, Tecno, Apple and the rest" },
          { name: "Categories", href: "/products/categories", icon: FolderTree, hint: "Kinds of items and the reseller markup" },
          { name: "Add one item", href: "/products/new", icon: PlusCircle, hint: "Register one product name and brand" },
          { name: "Add from a sheet", href: "/products/bulk", icon: FileSpreadsheet, hint: "Upload a list of product names" },
          { name: "Warranty days", href: "/products/warranty", icon: ShieldCheck, hint: "Default warranty days on an item" },
        ],
      },
      {
        name: "Phone numbers (IMEI)",
        href: "/imei",
        icon: ScanLine,
        children: [
          { name: "All phone numbers", href: "/imei", icon: ScanLine, hint: "Find any phone by IMEI and see its life" },
          { name: "One phone at a time", href: "/imei/intake", icon: PackagePlus, hint: "Put one phone already in your hand onto the shelf" },
        ],
      },
      {
        name: "Upload stock",
        href: "/uploads",
        icon: Upload,
        children: [
          {
            name: "Supplier bill",
            href: "/uploads",
            icon: PackagePlus,
            hint: "Add phones one by one or many on one supplier bill",
          },
          {
            name: "Many at once (Excel)",
            href: "/uploads/opening-stock",
            icon: FileSpreadsheet,
            hint: "Put a whole shop on the system from one Excel file",
          },
          {
            name: "Old Excel sheets",
            href: "/uploads/sheets",
            icon: ListOrdered,
            hint: "Step-by-step sheets for items, stock, IMEIs, and customers",
          },
        ],
      },
      {
        name: "Supplier bills & goods",
        href: "/purchases",
        icon: Truck,
        children: [
          { name: "Supplier bills", href: "/purchases", icon: Truck, hint: "Every supplier bill, paid and owed" },
          { name: "Book expected goods", href: "/purchases/new", icon: PlusCircle, hint: "A supplier carton on its way" },
          { name: "Send back to supplier", href: "/purchases/send-back", icon: Undo2, hint: "Phones going back to the supplier" },
        ],
      },
      {
        name: "Goods on the way",
        href: "/incoming",
        icon: Package,
        children: [
          { name: "On the way", href: "/incoming", icon: Package, hint: "Left the supplier, not in the shop yet" },
          { name: "Book goods coming", href: "/incoming/new", icon: PlusCircle, hint: "Scan IMEIs or type pieces still coming" },
        ],
      },
      {
        name: "Shop to shop",
        href: "/transfers",
        icon: ArrowLeftRight,
        children: [
          { name: "All transfers", href: "/transfers", icon: ArrowLeftRight, hint: "Waiting, accepted and rejected" },
          { name: "Start a transfer", href: "/transfers/new", icon: PlusCircle, hint: "Send stock to another Abu Twins shop" },
        ],
      },
      { name: "Stock count", href: "/reconciliation", icon: ClipboardCheck },
      { name: "Opening stock", href: "/opening-stock", icon: Lock },
    ],
  },
  {
    label: "Money",
    items: [
      { name: "Money in & out", href: "/finance", icon: Wallet },
      {
        name: "Shop expenses",
        href: "/expenses",
        icon: Receipt,
        children: [
          { name: "All shop bills", href: "/expenses", icon: Receipt, hint: "Waiting and approved" },
          { name: "Ask for a shop bill", href: "/expenses/new", icon: PlusCircle, hint: "A manager says yes before money leaves" },
        ],
      },
      {
        name: "Suppliers",
        href: "/suppliers",
        icon: Factory,
        children: [
          { name: "All suppliers", href: "/suppliers", icon: Factory, hint: "Bought, paid and still owed" },
          { name: "Add a supplier", href: "/suppliers/new", icon: PlusCircle, hint: "One name and one phone for one house" },
        ],
      },
      { name: "Profit", href: "/profits", icon: TrendingUp },
      { name: "Reports", href: "/reports", icon: BarChart3 },
      { name: "Check the books", href: "/audit/books", icon: Scale },
    ],
  },
  {
    label: "Oversight",
    items: [
      { name: "Business today", href: "/owner", icon: Gauge },
      { name: "Who did what", href: "/audit", icon: ScrollText },
      { name: "Alerts", href: "/notifications", icon: Bell },
    ],
  },
  {
    label: "Setup",
    items: [
      {
        name: "Shops",
        href: "/branches",
        icon: GitBranch,
        children: [
          { name: "All shops", href: "/branches", icon: GitBranch, hint: "Open and closed shops" },
          { name: "Open a shop", href: "/branches/new", icon: PlusCircle, hint: "A new shop with its own stock and money" },
        ],
      },
      {
        name: "Staff",
        href: "/staff",
        icon: UserRoundCog,
        children: [
          { name: "All staff", href: "/staff", icon: UserRoundCog, hint: "People, their shop and their job" },
          { name: "Add a staff member", href: "/staff/new", icon: PlusCircle, hint: "A new login for one person" },
          { name: "Who can see what", href: "/staff/access", icon: Shield, hint: "Which screens each job opens" },
        ],
      },
      {
        name: "Settings",
        href: "/settings",
        icon: Settings,
        children: [
          { name: "Shop details", href: "/settings", icon: Building2, hint: "Shop name, phone, and address on invoices" },
          { name: "Selling rules", href: "/settings/rules", icon: SlidersHorizontal, hint: "Lowest price, low stock, and warranty days" },
          { name: "Shop backup", href: "/settings/backup", icon: DatabaseBackup, hint: "Download a copy of the shop records" },
        ],
      },
      { name: "How to use this", href: "/help", icon: BookOpen },
    ],
  },
]

/** Flat list of every destination, parents and children alike. */
export const navDestinations = navGroups.flatMap((group) =>
  group.items.flatMap((item) => [
    { name: item.name, href: item.href, parent: null as string | null },
    ...(item.children ?? [])
      .filter((child) => child.href !== item.href)
      .map((child) => ({ name: child.name, href: child.href, parent: item.name })),
  ])
)

/** True when `pathname` sits on this item or anywhere under it. */
export function isOnItem(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * The children strip to draw above a screen, or null when the screen is not
 * part of a split area. Child order decides tab order.
 */
export function childrenForPath(pathname: string): { parent: NavItem; children: NavChild[] } | null {
  for (const group of navGroups) {
    for (const item of group.items) {
      if (!item.children?.length) continue
      if (isOnItem(pathname, item.href) || item.children.some((child) => isOnItem(pathname, child.href))) {
        return { parent: item, children: item.children }
      }
    }
  }
  return null
}
