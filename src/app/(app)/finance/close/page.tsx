import { redirect } from "next/navigation"

/** Balance the till was taken out. Old links and bookmarks land on Money in & out. */
export default function DayClosePage() {
  redirect("/finance")
}
