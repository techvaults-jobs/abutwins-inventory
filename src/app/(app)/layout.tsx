import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { getCurrentUser } from "@/lib/session"
import { prisma } from "@/lib/prisma"
import { AppFrame } from "@/components/layout/frame"
import { LiveRefresh } from "@/components/live-refresh"
import { firstAllowedHref, getAllowedKeys, hrefsForKeys, pathIsAllowed } from "@/lib/permissions"
import { writeAudit } from "@/lib/audit"
import { getViewShopOptions } from "@/app/actions/view-shop"
import { isShopOwner } from "@/lib/roles"
import { settleDoneAlerts } from "@/lib/settled-alerts"

const WATCHED = ["/audit", "/settings", "/staff", "/staff/access", "/finance", "/reports", "/profits"]

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect("/login")

  // Alerts whose work someone already finished are put away first, so the bell
  // never says a decided return or a paid invoice is still waiting.
  await settleDoneAlerts(user.id).catch(() => {})

  const [unread, shops] = await Promise.all([
    prisma.notification.count({ where: { userId: user.id, status: "UNREAD" } }),
    // Only head office gets a shop selector. For everyone else this is null and
    // no control is drawn.
    getViewShopOptions(),
  ])
  const keys = await getAllowedKeys(user.role)
  const allowedHrefs = hrefsForKeys(keys)
  if (allowedHrefs.length === 0) redirect("/login")

  // Counts beside menu items: work waiting for a yes (price approvals only for
  // the CEO and main admin, who answer them) and unread alerts.
  const [waitingApprovals, waitingPrices] = keys.has("view.approvals")
    ? await Promise.all([
        prisma.approval.count({ where: { status: "PENDING" } }),
        isShopOwner(user.role) ? prisma.priceRequest.count({ where: { status: "PENDING" } }) : Promise.resolve(0),
      ])
    : [0, 0]
  const badges: Record<string, number> = {
    "/approvals": waitingApprovals + waitingPrices,
    "/notifications": unread,
  }

  const pathname = (await headers()).get("x-pathname") || ""
  let refused = false

  if (pathname && pathname !== "/account" && pathname !== "/help") {
    refused = !pathIsAllowed(pathname, allowedHrefs)
    try {
      if (refused) {
        await writeAudit({
          userId: user.id,
          action: "DENIED",
          entityType: "Access",
          entityId: pathname,
          newValue: JSON.stringify({ role: user.role }),
          branchId: user.branchId,
          success: false,
          risk: "HIGH",
          path: pathname,
        })
      } else if (WATCHED.some((href) => pathname === href || pathname.startsWith(`${href}/`))) {
        await writeAudit({
          userId: user.id,
          action: "VIEW",
          entityType: "Screen",
          entityId: pathname,
          branchId: user.branchId,
          path: pathname,
          risk: "LOW",
        })
      }
    } catch {
      // never block the shop if the trail cannot write
    }
  }

  // Outside the try on purpose. redirect() works by throwing, so a catch around
  // it swallows the redirect and the screen is drawn after all. Send them to a
  // screen their job does have instead of an empty one.
  if (refused) redirect(firstAllowedHref(keys))

  return (
    <AppFrame unread={unread} badges={badges} shops={shops} user={{ name: user.name, role: user.role, mustChangePassword: user.mustChangePassword }} allowedHrefs={allowedHrefs}>
      <LiveRefresh />
      {children}
    </AppFrame>
  )
}
