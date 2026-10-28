const VIEW_HREFS = [
  "/dashboard",
  "/owner",
  "/products",
  "/uploads",
  "/imei",
  "/inventory",
  "/incoming",
  "/sales",
  "/pos",
  "/purchases",
  "/customers",
  "/suppliers",
  "/transfers",
  "/neighbor-fills",
  "/returns",
  "/swaps",
  "/repairs",
  "/reconciliation",
  "/finance",
  "/expenses",
  "/approvals",
  "/branches",
  "/staff/access",
  "/staff",
  "/profits",
  "/reports",
  "/audit",
  "/notifications",
  "/settings",
] as const

export function pathIsAllowed(pathname: string, allowedHrefs: string[]) {
  if (pathname === "/account" || pathname.startsWith("/account/")) return true
  if (pathname === "/help" || pathname.startsWith("/help/")) return true
  if (pathname === "/audit/books" || pathname.startsWith("/audit/books/")) {
    // hrefsForKeys adds this only for people who can see both the audit and the money.
    return allowedHrefs.includes("/audit/books")
  }
  // Opening stock correction: Upload stock staff and owners who already have that door.
  if (pathname === "/opening-stock" || pathname.startsWith("/opening-stock/")) {
    return allowedHrefs.includes("/uploads") || allowedHrefs.includes("/opening-stock")
  }
  const view = VIEW_HREFS
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((href) => pathname === href || pathname.startsWith(`${href}/`))
  if (!view) return false
  return allowedHrefs.includes(view)
}
