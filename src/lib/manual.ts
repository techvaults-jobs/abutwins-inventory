import type { UserRole } from "@prisma/client"
import { navGroups } from "@/components/layout/nav"
import { canChangePrices, ROLE_LABELS } from "@/lib/roles"

export type ManualSection = {
  id: string
  href?: string
  title: string
  group: string
  what: string
  doThis: string[]
  watch: string[]
  cannot: string[]
  lookup: string[]
}

export type RoleManual = {
  role: UserRole
  roleLabel: string
  job: string
  shops: string
  pages: string[]
  actions: string[]
  sections: ManualSection[]
}

const ROLE_JOB: Record<UserRole, { job: string; shops: string }> = {
  SUPER_ADMIN: {
    job: "You can open every page except Profit, and change prices, undo a true money mistake, tick Who can see what, change Settings, and open or close a shop. Profit and what items cost us are for the CEO and the books desk (Accountant and Auditor). Nobody can secretly rewrite an old invoice.",
    shops: "You see every shop.",
  },
  CEO: {
    job: "You own the business with the main admin. You open every page and see profit, margins and what items cost us; the Accountant and Auditor see them too. You change prices, cost included, on the Prices panel on Business today or the price list; the main admin and branch managers can too, and you are alerted when they change a cost. You can correct money, staff, shops, settings, prices and Who can see what. Nobody can secretly rewrite an old invoice.",
    shops: "You see every shop.",
  },
  AUDITOR: {
    job: "You oversee every shop page with admin-style oversight. You read sales, stock, repairs, money, Profit and what items cost us, so you can check prices, below-cost sales and stock value. You can post money and pay suppliers. You cannot sell, open repairs, load stock, approve shop work, or change Who can see what.",
    shops: "You see every shop.",
  },
  ACCOUNTANT: {
    job: "You work the money and books pages: sales lists, customers, suppliers, Money in and out, Check the books, Reports, and Profit, with what items cost us. You see profit and cost but do not change prices. You can post money and pay suppliers. You do not see Sell now, Upload stock, repairs, or other floor jobs on the left menu.",
    shops: "You see every shop.",
  },
  BRANCH_MANAGER: {
    job: "You run one shop: sell, receive, upload stock one by one or many from Excel, transfer, approve shop work, and add staff for that shop. You add new item names with their cost, lowest and selling price, so they sell at once, and you change prices on the price list. A price you set applies in every shop, and the CEO is told when you change a cost.",
    shops: "You see your shop only, unless the main admin later ticks See every shop.",
  },
  VAULT_MANAGER: {
    job: "You book goods before they arrive, receive phones, upload stock one by one or many from Excel, and send stock to a shop. You do not take till money.",
    shops: "You work in the shop the main admin set on your login.",
  },
  STOCK_UPLOADER: {
    job: "You put stock on the shelf from Upload stock. Use Supplier bill for one phone after another, Many at once (Excel) for a whole shop sheet, or One phone at a time when there is no bill. You do not sell, you do not post cash payments, and you do not approve anything.",
    shops: "You load for every shop. Each bill names which shop the goods sit in.",
  },
  CASHIER: {
    job: "You sell, collect money, close the day, record a return, write shop expenses, and call people who still owe us. You do not book incoming goods or change prices.",
    shops: "You work in the shop the main admin set on your login.",
  },
  SALES_EXECUTIVE: {
    job: "You sell, close the day, and record a return for a phone this shop sold. You can see customers, who still owes us, shop expenses, and items. A return takes effect as soon as you save it: the item comes back into stock with no approval.",
    shops: "You work in the shop the main admin set on your login.",
  },
  ENGINEER: {
    job: "You take phones for repair and move a repair from step to step. You can record a return that needs workshop work.",
    shops: "You work in the shop the main admin set on your login.",
  },
}

const PAGES: Array<
  Omit<ManualSection, "group"> & { href: string; needAction?: string }
> = [
  {
    id: "home",
    href: "/dashboard",
    title: "Home",
    what: "The first picture of the day. Sales, expenses, money collected, work that still needs a person, and IMEI versus shop count. The count table stays on the page even when every row says Match.",
    doThis: [
      "Read Do these next at the top. Click a card to jump to that work.",
      "If a day is not closed, open it and count the till before anyone sells.",
      "Read IMEI vs shop count. Match means the unique list and the shelf number agree. A gap means count stock. Do not type a new number by hand.",
      "A waiting sale sitting too long goes to Sell now. A vanished waiting sale goes to Who did what.",
    ],
    watch: [
      "Unclosed days lock Sell now for everyone, including the main admin.",
      "A gap on IMEI vs shop count is unproven stock until someone counts.",
    ],
    cannot: ["Home does not change an invoice or a stock number."],
    lookup: ["home", "do these next", "imei check", "match", "gap"],
  },
  {
    id: "uploads",
    href: "/uploads",
    title: "Upload stock",
    needAction: "action.upload",
    what: "Put stock on the shelf with a supplier trail. Supplier bill is for a carton with paid or not paid. Many at once (Excel) is opening stock value only: it is not a bill to pay. One phone at a time is a phone already in your hand with no bill.",
    doThis: [
      "Upload stock is three screens. Pick the one you need from the tab strip at the top, or from the Upload stock fold in the menu.",
      "SUPPLIER BILL, for a new carton: pick the shop, the supplier (or add a new one), and whether it is paid.",
      "Under What is on this bill, type the product name in the search bar and pick it. Only the name fills the item column. Then pick How the phone looks (Brand New, Brand New (Locked), Brand New (N/A), UK, UK (Locked), Open Box, Standard, or Faulty) and storage (32GB, 64GB, 128GB, 256GB, 1TB, or 2TB), the same way you fill cost and how many.",
      "Add each IMEI, serial, or piece count under that same bill. Scanning only fills the box. Press Upload this stock when the line is ready.",
      "OPENING STOCK SHEET, for a full shop count: fill the opening stock Excel one shop at a time, pick or add the supplier, and upload. There is no paid or unpaid on that sheet.",
      "PHONES: one row per phone with the IMEI. LAPTOPS: one row per laptop with the serial. ACCESSORIES and SCREEN: how many pieces.",
      "Open Correct and close opening stock to count the shelf, then close it. After that, new cartons use Supplier bill.",
      "Found a wrong price or count after closing? The CEO or Super Admin opens Correct and close opening stock, types why, and taps Reopen opening stock. Fix the lines, then close it again. The shop keeps selling the whole time, and anything already sold stays sold.",
      "Loaded onto the wrong shop? On Correct and close opening stock, tick the items, or tick a whole category, and click Remove ticked. The CEO or main admin can remove the whole shop's opening stock at the bottom. Then load the file onto the right shop.",
      "OLD EXCEL & CSV: use this only when the item list is already on the system and you are topping up from a plain sheet.",
    ],
    watch: [
      "Nothing from Excel is saved until the whole file has been read. One bad line means nothing is loaded.",
      "Sending the same phone twice is safe. A repeated IMEI or serial is counted once. A phone already on the system is left alone and is not doubled. Staff can edit later on Correct and close opening stock or Phones and items.",
      "While a sheet or bill is uploading, a full-screen Abu Twins wait names the shop and shows a percent bar. Keep the page open until it finishes.",
      "Unpaid supplier bills appear on Finance as still owed. Opening stock never appears as money owed.",
      "Booking phones in also raises the shelf count, so Shop stock and Phone numbers (IMEI) agree from the start.",
      "A new supplier name or phone that is already on the books is refused. Pick the name already on the list.",
    ],
    cannot: [
      "Do not invent an IMEI because the box is missing.",
      "This does not sell anything. Marking paid on upload does not write a cash or bank entry. Accounts still own the money trail when they pay later.",
    ],
    lookup: ["upload", "excel", "opening stock", "sheets", "csv", "supplier bill", "phones", "accessories", "screen", "laptops", "imei", "bulk", "import", "manual", "one at a time", "serial", "add one", "supplier", "paid", "invoice", "PO", "submission value", "item name", "search", "condition", "storage"],
  },
  {
    id: "products",
    href: "/products",
    title: "Phones & items",
    needAction: "action.catalog",
    what: "The list of things Abu Twins sells. Each line has a name, item code, cost, lowest price, selling price, and tracking: IMEI, serial, or no number.",
    doThis: [
      "Search by item code or model.",
      "If you can add items, set cost, lowest price, and selling price. Pick the tracking that matches the thing: phones use IMEI, some accessories use serial, cords use no number.",
      "Adding items has its own screens under Phones & items: Add one item for a single model, Add from a sheet for a long list. Type the real product name (iPhone 13, MacBook Pro M3) and the brand, then the category (Phones, Laptops, Accessories, Screen). Pick All shops or one shop. A sheet can be names, brands, and categories only. This does not put stock on the shelf.",
      "To change many selling prices at once, tick any mix of phones and accessories on the price list, type each new selling price, then click Update selected prices.",
      "On a price list line, click Change or remove. Change details edits the name and prices. Reduce stock takes pieces off the shelf, or writes off phone IMEIs by scanning them. Remove item hides or deletes the name.",
      "Warranty days live on their own screen, Phones & items then Warranty days. Keep defaults at 0. Cashiers type days on Sell now.",
    ],
    watch: [
      "One list keeps names and prices the same in every shop.",
      "The person who loads stock or a branch manager adds new items. The CEO, the main admin or a branch manager changes prices, cost included; the price setters, the Accountant and the Auditor see what items cost. Anyone else reads the list but cannot change it.",
      "This is not a carton sale. You still sell by the unit. Bulk here means many prices in one save.",
      "A phone marked Damaged is not for Sell now. On All phones, use Set Good (sellable) or Set Damaged when it must change.",
    ],
    cannot: ["This page does not sell a phone. Use Sell now."],
    lookup: ["product", "price", "sku", "item code", "upload", "bulk", "warranty", "add one item", "update selected prices"],
  },
  {
    id: "imei",
    href: "/imei",
    title: "Phone numbers (IMEI)",
    needAction: "action.intake",
    what: "The life of each unique phone or serial item. Search the number. See Coming, In shop, Sold, Returned, or in repair.",
    doThis: [
      "Type an IMEI or serial in the search, or leave it empty and search.",
      "Open a number to see the shop, the invoice, the buyer, and the warranty days left.",
      "If you can receive goods, use One phone at a time to add a phone that is already in your hands. It sits under Phone IMEIs in the menu.",
      "On One phone at a time, pick how the phone looks: Brand New, Brand New (Locked), Brand New (N/A), UK, UK (Locked), Open Box, Standard, or Faulty. Pick a supplier from the list, or choose Add new supplier.",
      "Fill cost, lowest sell, and selling price. They update that item on the price list. A phone is always quantity 1. A no-number item lets you type how many pieces.",
      "Scan or type the IMEI. That only fills the number. Fill the item, prices, how it looks, and the supplier, then press Add phone to shop.",
      "For a carton with a bill, or many phones at once from Excel, use Upload stock.",
    ],
    watch: [
      "Coming phones are not for sale on Sell now.",
      "The same IMEI cannot live two lives. The system stops a copy.",
      "Scanning does not save. Press Add phone to shop when the rest of the fields are ready.",
      "Battery health is not asked when you add a phone.",
      "If How the phone looks is Damaged, the phone is booked as Damaged. It does not go on sellable In shop stock, and Sell now will refuse it until someone Sets Good (sellable).",
      "This screen updates item prices. It does not post a supplier bill. Use Upload stock for a carton you owe money on.",
    ],
    cannot: ["You cannot sell from this page. You cannot invent an IMEI that is not on a box."],
    lookup: ["imei", "serial", "coming", "in shop", "sold"],
  },
  {
    id: "inventory",
    href: "/inventory",
    title: "Shop stock",
    what: "The shelf view. In shop is what you may sell. Coming is booked and not here yet. For phones you also see how many IMEIs sit in that shop.",
    doThis: [
      "Find the item and the shop.",
      "Read In shop and Coming as two different numbers.",
      "If IMEIs in shop and In shop do not match, go to stock count or Home. Do not type a new shelf number by hand.",
    ],
    watch: ["Coming does not add to In shop until someone confirms arrival."],
    cannot: ["This page does not move a phone to another Abu Twins shop. Use Shop to shop."],
    lookup: ["stock", "shelf", "in shop", "coming", "quantity"],
  },
  {
    id: "incoming",
    href: "/incoming",
    title: "Goods on the way",
    needAction: "action.incoming",
    what: "Book a supplier carton before it reaches Ibadan. Phones go in as IMEIs. Cords go in as a piece count. The list stays Coming until someone says they have arrived. This is not Shop to shop.",
    doThis: [
      "Pick the shop the carton is going to.",
      "Add phone lines with one IMEI per line, at least 14 digits. Add no-number items with a piece count.",
      "Save. Shop stock Coming goes up. Sell now still cannot find those IMEIs.",
      "When the rider arrives, mark They have arrived. In shop goes up. Then cashiers can sell.",
      "The main admin or the CEO can show a hidden list to staff who have this page.",
    ],
    watch: [
      "If you mix Coming with In shop, cashiers will sell phones that are still on the road.",
      "The same IMEI cannot be booked twice.",
    ],
    cannot: ["A cashier who cannot book goods will not see the add form."],
    lookup: ["incoming", "coming", "book", "arrived", "carton"],
  },
  {
    id: "sales",
    href: "/sales",
    title: "Sales",
    needAction: "action.sell",
    what: "Every invoice. The list shows Branch, Customer, Sales, Paid, Balance, and Payment method in their own columns. Balance is paid minus sales, so a buyer who still owes shows a negative balance. Totals at the top and foot of the list follow the days you pick. Open one bill to collect remaining money, attach a buyer name, or print. The invoice itself cannot be edited.",
    doThis: [
      "Tap Today, Last 7 days, or Last 30 days, or pick First day and Last day for any stretch you need.",
      "Read Sales value, Payments received, and Balance at the top. They must match the rows below.",
      "Open an invoice. Read the note that this sale cannot be changed.",
      "Print the invoice. The paper has the blue header and the ab mark.",
      "If money is still due and a buyer is attached, collect the rest. That adds a payment line. Old lines stay.",
      "If the sale was a walk-in, attach a real name before anyone starts a return.",
    ],
    watch: [
      "If staff can change yesterday's sale, the day's cash never matches.",
      "Balance negative means the buyer still owes on that bill.",
    ],
    cannot: ["You cannot change items, IMEIs, or prices on an old invoice."],
    lookup: ["invoice", "print", "collect", "walk-in", "balance", "sales report"],
  },
  {
    id: "pos",
    href: "/pos",
    title: "Sell now",
    needAction: "action.sell",
    what: "The till. One box to scan or type IMEI, serial, phone name, brand, category, or a piece item. Pick the buyer, take Cash or Bank (into a named bank account from Money in and out), or Credit sales, and finish. On credit sales you can still type money received now and say if it was Cash or Bank. What is left is credit sales. The system makes an invoice.",
    doThis: [
      "If you see Count the till, close that day first. Complete sale stays locked until you do, even for the main admin.",
      "Confirm you are in the shop you are standing in.",
      "In the one Scan or type box, scan the IMEI or type a name, serial, brand, category, or piece item, then Enter. Use camera if the browser allows it. Coming phones will not appear.",
      "For a pouch or charger cord, type how many in Pieces. Any whole number from 1 up is allowed while you type. Complete sale still needs enough on hand in this shop.",
      "Pick a named customer, or add one. A sale with no name must be paid in full.",
      "For a full payment, pick Cash or Bank. Amount paid always matches the sale total, including after you raise a price. If Bank, pick which shop bank account received the full amount, then finish.",
      "For a part payment, pick Credit sales. Type Cash received now and Bank received now (one, the other, or both). If any bank money came in, pick the shop bank account. What is left stays Credit sales on the Sales list.",
      "If the network goes off and the till is not locked, finish the sale anyway. It stays on this phone as a waiting sale and goes to the shop system when the network comes back.",
    ],
    watch: [
      "A waiting sale shows a banner on every signed-in page until it is sent.",
      "After two hours The main admin, the CEO, and the records checker get an alert.",
      "If someone wipes a waiting sale off the device, Who did what records it as vanished.",
      "The floor is the item's lowest allowed price, not the price the till offers first. You may price a deal anywhere from the floor up, and raise it for a walk-in buyer. There is no percentage limit: any price can be charged. Going under the floor, or under what the item cost us, needs a reason and the CEO or Super Admin. If they are not the one selling, tap Complete sale, then Send for approval: the CEO and the main admin see it on their screens at once, with your prices and reasons, and the first to answer decides. Keep working while you wait; the till tells you the answer and, once approved, you tap Complete sale. Change a price after they approve and it needs approving again. A request nobody answers lapses after 30 minutes. Every price that leaves the standard one shows on Profit, under Price changes, with who approved it.",
    ],
    cannot: ["You cannot sell a Coming phone. You cannot force a live sale while an older day with sales is still open."],
    lookup: ["sell", "till", "pos", "scan", "parked", "offline", "complete sale"],
  },
  {
    id: "close",
    href: "/finance/close",
    title: "Close the day",
    what: "Close every past day that had sales so Sell now can open. If cash came into the till, count it and type cash remitted. If the day was only Bank, close with no till count.",
    doThis: [
      "Open Close the day from the left, from the lock on Sell now, or from Home.",
      "Confirm the date is the unclosed day, not today, if yesterday still needs a close.",
      "Read cash expected and Bank received.",
      "If cash expected is more than zero, count the drawer and type cash remitted.",
      "If cash expected is zero, click Close the day. No till count is needed.",
      "Close this day. If another old day is still listed, close that one too.",
    ],
    watch: [
      "Cash expected is only cash sales for that business day.",
      "Bank days still need a close, but not a till count.",
      "You cannot close the same shop day twice.",
      "Cashiers and sales people can close even if they cannot see the full Money in & out page.",
    ],
    cannot: ["Closing the day does not change any invoice."],
    lookup: ["close", "till", "count", "variance", "expected cash"],
  },
  {
    id: "purchases",
    href: "/purchases",
    title: "Goods from supplier",
    needAction: "action.intake",
    what: "Expected cartons from named suppliers in other countries and cities. This bill is the trail for missing products. You can see how many the supplier sent, how many were scanned, how many were sold on invoices (including today before close), and how many the system still says are In shop.",
    doThis: [
      "Pick the supplier, the shop that will receive, the item, how many, the cost, and the country or city the goods are coming from.",
      "Save. Open the bill. Book IMEIs as Coming if the carton is still on the road.",
      "When the boxes are on the counter, confirm they are in this shop. Then cashiers can sell.",
      "Search by IMEI, bill number, supplier, or product to open that carton trail.",
      "Before Close the day, read Sold today against Still in shop. If the shelf is short of Still in shop, count stock.",
      "Pay the supplier as a separate money step.",
      "If units must go back, open Send back to supplier and scan or type each IMEI, one after the other. Do not pick the supplier. The phone name, the house, and the cost fill in from that number. Check the list against the phones in front of you, then press Review and confirm. Nothing is sent until you confirm, and an unsent list stays on that device.",
    ],
    watch: [
      "This is not Iwo Road sending a phone to Bodija or Challenge. That is Shop to shop.",
      "This is not buying one unit from the shop next door for a customer. That is Buy from next door.",
      "Bills marked Loaded on Upload stock were put on the shelf from Upload stock. Units are already In shop.",
      "Never scanned versus the bill means those units were never given a number on this system.",
      "If Still in shop is higher than the shelf, a unit may have been sold without an invoice. Do not type a new shop number by hand.",
      "A send-back of phones from more than one house is refused. Start a new send-back for the next supplier.",
      "Sending phones back cuts what we still owe that house. If we do not owe them, they owe us. Opening stock does not change money owed.",
    ],
    cannot: ["This page does not invent a supplier. Add the supplier first. Neighbor shops are a different list kind."],
    lookup: ["purchase", "supplier bill", "expected", "china", "dubai", "send back", "missing", "sold today", "upload stock", "PO", "they owe us"],
  },
  {
    id: "customers",
    href: "/customers",
    title: "Customers & money owed",
    what: "Named buyers. See who still owes us after a credit sale. When you add someone who already owed money before this software, type Opening balance they owe us. A sale can be a walk-in, but a return cannot start until a real name is on the invoice.",
    doThis: [
      "Add a person with a full name, a phone, and the shop.",
      "If they already owe Abu Twins, type Opening balance they owe us. Leave it at zero if they start clean.",
      "For a customer already on the list, open their page and use Add or Change on Opening balance. Type the right figure and why. The difference goes on their account as its own line, so the old figure stays in the history. The CEO, the main admin, the Accountant and the Auditor can do this.",
      "Tap Still owing to see who to call for payment.",
      "Open a customer to see what they still owe and their invoices.",
      "If you can collect, post a payment on that person. Cash, bank, or both in one save.",
    ],
    watch: ["Do not invent dummy buyers for live cash. If it is not a real person, do not put them on the system."],
    cannot: ["A walk-in with no name cannot start a return."],
    lookup: ["customer", "buyer", "owing", "credit", "receivable"],
  },
  {
    id: "suppliers",
    href: "/suppliers",
    title: "Suppliers",
    what: "People and firms Abu Twins buys cartons from. Keep the country and city so expected goods have an origin. When you add a house Abu Twins already owed before this software, type Opening balance we still owe and pick the shop. Neighboring dealers you fill from can be marked Neighboring shop. Click a box at the top to see the houses behind that number. Click a house to drop down its bills. Invoice value, Payment, and Stock return sit on each bill. Balance shows + value owing when they owe Abu Twins, or - value owing when Abu Twins still owes them.",
    doThis: [
      "Click a box at the top to see the houses that make that number. Value owing with a minus shows houses we have not paid. Value owing with a plus shows houses with a surplus after stock return.",
      "Click a house name to drop down its bills, with invoice value, payment, stock return, and the balance. Copies of the same name sit under that one house.",
      "Add a supplier with a name, a phone, and where they ship from. If we already owed them, type Opening balance we still owe for the shop.",
      "If the house is already on the list, pick that name. Do not type it again.",
      "Open the full page if you need the carton trail bill by bill.",
    ],
    watch: [
      "One supplier list keeps pay-outs honest.",
      "The system refuses a second spelling of the same name, extra spaces, Ltd on the end, or a phone that already belongs to another house.",
    ],
    cannot: ["This page does not receive a carton. Use Goods on the way or Goods from supplier."],
    lookup: ["supplier", "creditor", "country", "dubai", "china", "house", "click the box", "value owing", "payment", "invoice value", "stock return"],
  },
  {
    id: "transfers",
    href: "/transfers",
    title: "Shop to shop (Stock Transfer)",
    needAction: "action.transfer",
    what: "Move phones and accessories that already belong to Abu Twins from one of our shops to another. Pick From (Branch) and To (Pick the branch). Find items, set Qty to send, read Cost value at unit cost, extract a sheet if you need it, then Submit. Stock stays In shop at the sending branch until the receiving branch accepts or rejects. The CEO or the main admin can accept or reject any transfer. The branch manager can only accept or reject transfers coming into their own shop. Goods intake staff can send a transfer but cannot accept or reject it on behalf of another shop.",
    doThis: [
      "Pick From (Branch) and To (Pick the branch).",
      "Find phones and piece items. Tick phones. Type Qty to send on cords and other no-number items.",
      "Read the Cost value total. Extract selection or stock as CSV or Excel if you need a packing sheet.",
      "Submit the transfer. The receiving branch sees Waiting for accept.",
      "The receiving shop's manager, the CEO or the main admin accepts or rejects. Only Accept moves stock.",
      "On Reject: type why you are rejecting it. The sending shop sees your reason and your name.",
    ],
    watch: [
      "Do not wait to pack by clearing In shop first. The sending In shop record stays until Accept.",
      "Reject leaves stock at the sending shop. The reason you write is shown to the sender.",
      "A phone on a waiting transfer cannot be sold until Accept or Reject.",
      "Goods intake staff can send transfers but cannot accept or reject on behalf of any shop.",
      "This is not goods from a supplier.",
    ],
    cannot: [
      "You cannot treat a shop-to-shop transfer as a sale or as a supplier carton.",
      "You cannot accept a transfer going to another shop if you are not that shop's manager, the CEO or the main admin.",
    ],
    lookup: ["transfer", "shop to shop", "stock transfer", "accept", "reject", "from branch", "to branch", "reason", "why rejected"],
  },
  {
    id: "returns",
    href: "/returns",
    title: "Returns",
    needAction: "action.return",
    what: "A buyer brings something back. Phones and laptops use the Phone or laptop tab — pick the sold device by IMEI. Accessories, cords, pouches, and other items without an IMEI number use the Other item by invoice tab — type the invoice number, pick the line, and say how many are coming back. Both paths ask for a return value, an outcome, and the condition of what came back. It takes effect the moment you save it: the item is back in this shop's stock, ready to sell, and the refund or replacement is settled. A manager can mark a broken one Damaged on its phone page, or pick another condition when logging it. No approval is needed.",
    doThis: [
      "For a phone or laptop: open the Phone or laptop tab. Pick the sold device from the list, or use Find sold IMEI if it is not there. Confirm the return item value.",
      "For a cord, pouch, or accessory: open the Other item by invoice tab. Type the invoice number and press Find. Pick the item line. If more than one piece is coming back, type how many.",
      "Pick why it is coming back: Faulty, Dissatisfaction / change of mind, or Replacement (wants another item).",
      "Pick what happens next: Replacement from our stock, or Refund. The Vault Manager, the shop Manager, the CEO and the main admin also see Repair, Credit note and Send back to the supplier.",
      "On Replace, pick the shop item going out and confirm its value. Read Receivable or Payable.",
      "If money goes back (a refund, or the difference we pay on a Replace), pick the bank account it leaves from.",
      "Save return. The item is back in stock straight away and the money is settled.",
    ],
    watch: [
      "Stock and money do not move while the return is Waiting.",
      "A return from the shop floor always comes back into the shop: a faulty item is kept in the shop as faulty, anything else goes back on the shelf. A manager decides what happens to a faulty item next.",
      "A walk-in sale is blocked until you attach a name on the invoice.",
      "Phones and laptops must use the IMEI tab. The invoice tab refuses lines that have an IMEI.",
      "Only completed sales appear when you type an invoice number.",
    ],
    cannot: [
      "You cannot rub out the old invoice.",
      "You cannot return more pieces than the invoice sold.",
      "Sending stock back to a supplier (return outward) is for the Vault Manager, the shop Manager, the CEO or the main admin, on Goods from supplier, Send back to supplier.",
      "Refunds are not paid in cash from the till.",
    ],
    lookup: ["return", "refund", "faulty", "replace", "receivable", "payable", "return value", "invoice", "accessory", "cord", "pouch", "non-imei", "item return"],
  },
  {
    id: "swaps",
    href: "/swaps",
    title: "Swap Deal",
    needAction: "action.swap",
    what: "A customer brings a phone or laptop and takes a shop device. You type swap-in value and shop-item value. The balance is Receivable or Payable. Save sends Needs approval. Stock hits and leaves only after yes. Then settle the money and print.",
    doThis: [
      "Pick or type the customer name and phone.",
      "Enter the customer device IMEI or serial number, and the shop device IMEI or serial going out.",
      "Type the swap-in value and the value of the shop item given out. Read Receivable or Payable.",
      "Save for approval. Wait for yes on Needs approval.",
      "After approval, stock has already moved. Collect or pay the balance and finish the invoice.",
    ],
    watch: [
      "Stock does not move while the Swap Deal is Waiting.",
      "A shop device on a waiting Swap Deal cannot be sold.",
    ],
    cannot: ["A swap without approval stays waiting. Stock does not leave or hit the shelf."],
    lookup: ["swap", "trade-in", "trade", "swap deal", "serial", "receivable", "payable"],
  },
  {
    id: "repairs",
    href: "/repairs",
    title: "Repairs",
    needAction: "action.repair",
    what: "Workshop work. Take a phone in, write the issue, move it from step to step, and set a cost when you know it.",
    doThis: [
      "Enter the IMEI and the issue.",
      "Move the repair to the next step as work happens.",
      "Add diagnosis and cost when you have them.",
    ],
    watch: ["A phone in repair is not In shop for sale."],
    cannot: ["This page does not complete a till sale."],
    lookup: ["repair", "workshop", "diagnosis"],
  },
  {
    id: "recon",
    href: "/reconciliation",
    title: "Stock count",
    needAction: "action.recon",
    what: "Count what is physically here and compare it with the system. Use this when Home IMEI vs shop count disagrees, or when a supplier bill says Still in shop but the shelf has fewer. Tap Count by category the same way as opening stock: Phones, Accessories, Screen, or Laptop. A manager must say yes before stock numbers change.",
    doThis: [
      "If a product looks missing, open Goods from supplier and search the IMEI or the bill first.",
      "Pick the shop. Tap a category chip if you are counting one group.",
      "Count the boxes and IMEIs in front of you.",
      "Enter what you counted.",
      "Wait for approval. Stock does not move until yes.",
    ],
    watch: [
      "If IMEI vs shop count disagrees, this is the honest fix. Do not type a new number on Shop stock.",
      "A supplier bill Still in shop gap may mean a sale without an invoice. Count. Do not guess.",
    ],
    cannot: ["A no leaves the count rejected. Numbers stay as they were."],
    lookup: ["count", "recon", "mismatch", "missing"],
  },
  {
    id: "finance",
    href: "/finance",
    title: "Money in & out",
    needAction: "action.finance",
    what: "Opening cash and named banks, money that moved, people who still owe us, and what Abu Twins still owes suppliers. Cashiers can open this list to call credit buyers. The main admin, the CEO, the accountant, or the records checker types the opening cash and adds each bank.",
    doThis: [
      "Read Money we started with. Opening cash is the till. Each bank has a name, an account number, and an opening balance.",
      "If you may set opening money, type opening cash for the shop and save. Add a bank with its account number and opening balance.",
      "Read Money in from sales, Money spent to run the shop, and what is left over.",
      "Open People who still owe us and call anyone with a balance.",
      "Open Close the day from here if the till still needs a count.",
    ],
    watch: [
      "Figures are in naira. They come from real invoices and approvals.",
      "Opening cash and opening banks are not opening stock. Opening stock is phones and pieces.",
    ],
    cannot: ["This page does not invent cash."],
    lookup: ["finance", "money in", "money out", "cash", "owe", "receivable"],
  },
  {
    id: "deposit",
    href: "/finance/deposit",
    title: "Move cash to bank",
    needAction: "action.deposit",
    what: "When cash piles up in a till, record the cash paid into the bank here. Cash in the till goes down and the bank account goes up by the same amount. It is our own money changing place, so it is not an expense and it does not touch profit.",
    doThis: [
      "Open Money in & out and click Move cash to bank.",
      "Pick the shop whose till the cash left, and the bank account it went into.",
      "Type the amount, the day it went into the bank, and the teller slip or transfer reference.",
      "Click Move this cash to the bank and say yes.",
    ],
    watch: [
      "You cannot move more than the cash in that till. Shop bills waiting for a yes are held back.",
      "The move shows on both ledgers: Cash to bank on Cash in the till, Cash from the till on Bank.",
      "Close the day still counts the cash taken that day; a deposit does not change it.",
    ],
    cannot: ["Only the CEO or the main admin can undo a deposit, and they must say why. The record stays, marked undone."],
    lookup: ["deposit", "bank", "lodge", "cash to bank", "move cash", "teller"],
  },
  {
    id: "profits",
    href: "/profits",
    title: "Profit",
    what: "Each sold phone shows its name with storage and condition, the cost price, the sell price, and the profit. You can extract the list to Excel.",
    doThis: [
      "Read profit from our own stock, shop bills, and what is left.",
      "On Sales from our own stock, read cost price next to each phone.",
      "Click Extract this list to pull the rows into Excel.",
      "Open Profit by shop if you can see more than one shop.",
    ],
    watch: ["Figures come from real invoices and approved expenses. The pack does not invent profit."],
    cannot: ["Only the CEO, the main admin, the Accountant and the Auditor open this page. It is not a box on Who can see what.", "This page does not change an invoice."],
    lookup: ["profit", "margin", "net", "cost price", "extract"],
  },
  {
    id: "books",
    href: "/audit/books",
    title: "Check the books",
    what: "The money paper for one shop, for one day or a stretch of days. Total payments received is cash plus bank from the payment lines. Credit sales is what is still owed on those invoices, not the full invoice. Opening stock is not in this money paper as a payable. This paper does not change any sale.",
    doThis: [
      "Pick the shop, how many days, and the last day.",
      "Tap one of the past days on the strip, or type an older date.",
      "Leave Put it beside empty and it uses the days before. Or pick another date yourself.",
      "Read Cash received and Bank received. They must add up to Total payments received.",
      "Read Credit sales as the remaining balance, then print or download.",
    ],
    watch: [
      "On the PDF, money is written as NGN because the naira sign does not print well.",
      "A red check means somebody must go and fix it. A green check is already settled.",
    ],
    cannot: ["This paper does not change a sale, a day close, or a stock number."],
    lookup: ["books", "statement", "compare", "pdf", "csv", "accountant"],
  },
  {
    id: "expenses",
    href: "/expenses",
    title: "Expenses",
    needAction: "action.finance",
    what: "Fuel, rent, salary, light bill. Staff ask. A manager says yes. Then money can leave from cash in the till. The till cannot go below zero.",
    doThis: [
      "Read cash in the till on the page.",
      "Create the expense with an amount at or under that cash, and a description.",
      "Wait on Waiting for yes.",
      "After yes, the pay-out shows in Money in & out and cash in the till drops.",
    ],
    watch: [
      "Money does not leave until yes.",
      "A bill bigger than cash in the till is refused. Collect a cash sale first, or pay from the bank.",
    ],
    cannot: ["A no leaves the expense rejected.", "You cannot take cash out when the till is empty."],
    lookup: ["expense", "fuel", "bill"],
  },
  {
    id: "approvals",
    href: "/approvals",
    title: "Waiting for yes",
    needAction: "action.approve",
    what: "The yes-or-no desk. Swaps, refunds, expenses, and stock counts wait here.",
    doThis: [
      "Open an item. Read who asked and why.",
      "Say yes or no.",
    ],
    watch: ["After yes, the original work can continue. After no, it stops."],
    cannot: ["A person without approve rights cannot see the yes button."],
    lookup: ["approve", "yes", "no", "waiting"],
  },
  {
    id: "branches",
    href: "/branches",
    title: "Shops",
    needAction: "action.settings",
    what: "Iwo Road is head office. Bodija and Challenge are the other two shops. Each shop keeps its own stock, sales, customers, and money, and staff there see only their own shop. The main admin or the CEO can open a new shop or close one. Closed shops stay in an owner list so old sales are not lost.",
    doThis: [
      "Confirm you see Iwo Road, Ibadan, Bodija, Ibadan, and Challenge, Ibadan.",
      "If you are the main admin or the CEO, you can open a new shop with a name, a short code, and an address.",
    ],
    watch: ["Only Iwo Road, Bodija and Challenge appear when you sell or book new goods."],
    cannot: ["Only the main admin or the CEO can open or close a shop."],
    lookup: ["shop", "branch", "iwo", "challenge"],
  },
  {
    id: "staff",
    href: "/staff",
    title: "Staff",
    needAction: "action.staff",
    what: "The people list. Add a person, pick their job, pick their shop, and give a first password. The main admin or the CEO can lock a login.",
    doThis: [
      "Add name, work email, job, and shop.",
      "Give a temporary password. They should change it after they sign in.",
      "Disable a person who leaves. Restore if they return.",
    ],
    watch: ["A person who leaves must not keep a key to the till."],
    cannot: ["Do not disable the only the main admin during a test."],
    lookup: ["staff", "user", "password", "disable"],
  },
  {
    id: "access",
    href: "/staff/access",
    title: "Who can see what",
    what: "Main admin and CEO. Tick the pages and the work for each job. The main admin and the CEO are not ticked here because they always keep the right to change the shop.",
    doThis: [
      "Open a job, such as Cashier.",
      "Tick or untick a page. Save only if you mean to change a live rule.",
    ],
    watch: ["A cashier who opens this address is sent away."],
    cannot: ["You cannot remove main admin or CEO rights here. That is by design."],
    lookup: ["access", "permission", "tick", "role"],
  },
  {
    id: "reports",
    href: "/reports",
    title: "Reports",
    what: "Sales, money collected, stock, swaps, returns, who still owes you, and which suppliers owe you after send-backs, for the day, week, or month you pick. Last period sits beside this period. Still owed to suppliers shows the house name and the amount. Click the house and the bills drop down. Suppliers who owe us is the surplus after phones went back. On the screen it is cards and tables. When you print or download it, you get a clean paper for the boss.",
    doThis: [
      "Pick One day, Last 7 days, or This month so far.",
      "Read this period next to last period.",
      "Read the cards and the shop-by-shop table.",
      "On Still owed to suppliers, read the house name and the amount. Click the house to open its bills.",
      "On Suppliers who owe us, read the surplus after send-backs.",
      "Download the PDF, or print it and save it as a PDF.",
      "Download sales as CSV if you want to open them in Excel.",
    ],
    watch: ["The buttons stay on the screen. They do not print on the paper."],
    cannot: ["Reports does not change any sale."],
    lookup: ["report", "pdf", "meeting"],
  },
  {
    id: "audit",
    href: "/audit",
    title: "Who did what",
    what: "The diary. Who did an important action, when, and what changed, in shop words. Nothing here is deleted. Waiting sales that sat or vanished are marked high risk.",
    doThis: [
      "Search a name, IMEI, or invoice.",
      "Filter by action, risk, or failed sign-in.",
      "Open the books banner if it is there.",
      "Download the diary as a file if you need a copy.",
    ],
    watch: ["There is no delete button. A vanished waiting sale is a high-risk row."],
    cannot: ["You cannot edit a past action."],
    lookup: ["audit", "trail", "who", "high risk", "login"],
  },
  {
    id: "alerts",
    href: "/notifications",
    title: "Alerts",
    what: "Short notices: low stock, a request waiting, a waiting sale sitting too long, or a waiting sale that vanished.",
    doThis: [
      "Open the bell or this page.",
      "A waiting sale sitting too long points to Sell now.",
      "A waiting sale that vanished points to Who did what.",
    ],
    watch: ["The main admin, the CEO, and the records checker get the parked-sale alerts."],
    cannot: ["An alert does not post money by itself."],
    lookup: ["alert", "bell", "low stock", "parked"],
  },
  {
    id: "settings",
    href: "/settings",
    title: "Settings",
    needAction: "action.settings",
    what: "Shop name, phone, address, and email that print on invoices, books, reports, and this manual. Also the low stock alert, default warranty days, and whether cashiers may sell below the lowest price. The main admin or the CEO can download a shop backup.",
    doThis: [
      "Settings is three screens. Shop details holds what prints on an invoice. Selling rules holds the lowest-price rule, the low stock warning, and warranty days. Backup is the download.",
      "Read the invoice header values on Shop details.",
      "Change them if you are the main admin or the CEO.",
      "The main admin or the CEO may download a shop backup on the Backup screen and keep that file off this computer.",
    ],
    watch: ["The next printed invoice and the next books PDF use these values. A backup does not include passwords."],
    cannot: ["A cashier cannot change Settings or download a shop backup."],
    lookup: ["settings", "shop details", "selling rules", "address", "phone", "lowest price", "backup"],
  },
  {
    id: "account",
    href: "/account",
    title: "Your login",
    what: "Your name, job, and password. Every signed-in person can open this.",
    doThis: [
      "Change your password after a first login or when the main admin asks.",
      "Sign out when you leave the till. The next screen is Sign in.",
    ],
    watch: [
      "Do not share your password in a group chat.",
      "Sign out should not show Home or a broken shop page before Sign in.",
    ],
    cannot: ["This page does not change another person's job. That is Staff."],
    lookup: ["password", "account", "sign out", "login"],
  },
]

function groupFor(href: string) {
  for (const group of navGroups) {
    if (group.items.some((item) => item.href === href)) return group.label
  }
  if (href === "/account") return "Every job"
  if (href === "/help") return "Every job"
  return "Shop"
}

function alwaysSections(keys: Set<string>): ManualSection[] {
  const extras: ManualSection[] = [
    {
      id: "search",
      title: "Find IMEI, invoice, supplier bill, or customer",
      group: "On every screen",
      what: "The search box on the top bar, or the search window from the keyboard. Type a phone number, an invoice number, a supplier bill, or a buyer name. An IMEI can also open the supplier carton that unit came from.",
      doThis: [
        "On a computer, click the search box or hold Control and K (Command and K on a Mac).",
        "On a phone, tap the search icon.",
        "Type the number or name and open the match.",
      ],
      watch: ["You only jump to records your job may open."],
      cannot: ["Search does not invent a buyer or an IMEI."],
      lookup: ["search", "find", "lookup", "control k"],
    },
    {
      id: "calculator",
      title: "Shop calculator",
      group: "On every screen",
      what: "A button on every signed-in page. Add, subtract, multiply, and divide. It does not post money and does not change an invoice.",
      doThis: [
        "Tap the calculator.",
        "Add the notes in the drawer or a line you want to check by hand.",
        "Close it. The page you were on does not change.",
      ],
      watch: ["It does not appear on a printed invoice or a printed books statement."],
      cannot: ["The calculator cannot complete a sale or a close."],
      lookup: ["calculator", "add", "math"],
    },
    {
      id: "menu",
      title: "The left menu",
      group: "On every screen",
      what: "The dark bar is your map. You only see pages your job may open. On a computer you can hide it if you need more room. That choice stays on this device. On a phone the menu is a drawer.",
      doThis: [
        "Use the menu button at the top to show or hide the bar.",
        "If a page is missing, The main admin has not given that page to your job.",
      ],
      watch: ["A missing page is not a broken computer."],
      cannot: ["Hiding the menu does not hide your rights. It only gives you room."],
      lookup: ["menu", "sidebar", "left"],
    },
  ]

  if (keys.has("action.sell") && keys.has("view.pos")) {
    extras.push({
      id: "offline",
      title: "When the network goes off",
      group: "On every screen",
      what: "If you opened the shop on this phone while the network was good, the phone keeps the last copy of phones, shop stock, sales, customers, and the till list. You can still look those lists up and still finish a sale. Waiting sales stay here. Refreshing the page is safe: you land on this phone copy, not a dead internet page. When the network comes back, waiting sales go in by themselves, one sale at a time. If one sale needs a fix, the others still send. You can also tap Send waiting work now.",
      doThis: [
        "Open Home, All phones, Shop stock, Sales or Sell now at least once while the network is good, so this phone can keep those lists.",
        "If the network goes off, stay in the app. The yellow banner means this phone is using the last copy. Scan an IMEI from that saved list and finish the sale.",
        "Use a customer already on this phone, or a walk-in who pays everything now. Do not make up a new buyer while the network is down.",
        "If you refresh and land on the You can still sell page, the last shop list is there. Sell from it, or send the parked work when the network comes back.",
        "When the yellow banner says the network is back, send the parked work.",
      ],
      watch: [
        "The list is the last In shop picture. Coming phones are not on it.",
        "A parked IMEI is removed from the list on this phone, so nobody sells it twice before the network comes back.",
        "A waiting sale that sits more than two hours alerts The main admin, the CEO, and the records checker.",
      ],
      cannot: [
        "You cannot park a new live sale while an older day with sales is still open.",
        "You cannot add a new customer name while the network is down.",
      ],
      lookup: ["offline", "line down", "parked", "banner", "refresh", "till is still here", "scan", "imei"],
    })
  }

  extras.push({
    id: "rules",
    title: "Rules that keep the shop honest",
    group: "Remember",
    what: "Money and phones must leave a name, a time, and a shop record. If it is not on the system, it did not happen.",
    doThis: [
      "A sale is a finished paper. You add a payment, a return, or a swap as a new step.",
      "Coming is not In shop. Do not promise a Coming phone as if it is on the shelf.",
      "A walk-in sale needs a name before a return.",
      "If a past business day had sales and is not closed, nobody starts a new live sale.",
    ],
    watch: ["Who did what is never wiped. Check the books does not change any invoice."],
    cannot: ["The system will not invent a buyer name or let staff secretly change an old invoice."],
    lookup: ["rules", "honest", "coming", "invoice"],
  })

  return extras
}

function canUsePage(href: string, allowedHrefs: string[]) {
  if (href === "/account" || href === "/help") return true
  return allowedHrefs.includes(href)
}

export function buildRoleManual(role: UserRole, keys: Set<string>, allowedHrefs: string[]): RoleManual {
  const brief = ROLE_JOB[role]
  const sections: ManualSection[] = [
    {
      id: "this-book",
      title: "How to use this book",
      group: "On every screen",
      what: "This page is the handbook for your job only. It lists the pages you can open and the work you can do. A cashier and a CEO see different books.",
      doThis: [
        "Type a word in Look up a page, button, or word. Matching sections stay on the screen.",
        "Use Print / Save PDF. The paper has the company mark, your job name, and a reference such as HB-CASHIER-20260907.",
        "Print includes the full book for this job even if you filtered the screen.",
      ],
      watch: ["If a page is not in this book, your job cannot open it. Ask the main admin if you need that page."],
      cannot: ["This book does not give you extra rights. It only explains what you already have."],
      lookup: ["help", "manual", "print", "handbook", "how to", "lookup"],
    },
  ]

  for (const page of PAGES) {
    if (!canUsePage(page.href, allowedHrefs)) continue
    const canAct = !page.needAction || role === "SUPER_ADMIN" || keys.has(page.needAction)
    sections.push({
      id: page.id,
      href: page.href,
      title: page.title,
      group: groupFor(page.href),
      what: page.what,
      doThis: canAct
        ? page.doThis
        : [
            "You can open this page and read it.",
            "You cannot post or change records here. The main admin has not given that work to your job.",
          ],
      watch: page.watch,
      cannot: canAct
        ? page.cannot
        : [...page.cannot, "If you need to post here, ask the main admin to tick the right work for your job."],
      lookup: page.lookup,
    })
  }

  sections.push(...alwaysSections(keys))

  const pages = sections.filter((row) => row.href).map((row) => row.title)
  const actions = [
    keys.has("action.sell") ? "Sell and collect money" : "",
    keys.has("action.catalog") || keys.has("action.add_item")
      ? canChangePrices(role)
        ? "Add items and set their prices"
        : keys.has("action.catalog")
          ? "Add items and their starting prices"
          : "Add new item names (the CEO, main admin or branch manager prices them)"
      : canChangePrices(role)
        ? "Change prices"
        : "",
    keys.has("action.intake") ? "Receive phones and supplier goods" : "",
    keys.has("action.incoming") ? "Book goods before they arrive" : "",
    keys.has("action.transfer") ? "Send and receive goods between shops" : "",
    keys.has("action.return") ? "Record returns" : "",
    keys.has("action.swap") ? "Record swaps" : "",
    keys.has("action.repair") ? "Handle repairs" : "",
    keys.has("action.recon") ? "Count stock" : "",
    keys.has("action.approve") ? "Approve or reject requests" : "",
    keys.has("action.finance") ? "Record expenses and pay suppliers" : "",
    keys.has("action.staff") ? "Add staff" : "",
    keys.has("action.settings") ? "Change shop settings" : "",
    keys.has("action.all_branches") ? "See every shop" : "",
    keys.has("action.override_floor") ? "Sell below the lowest allowed price" : "",
    role === "SUPER_ADMIN" ? "Undo a true money mistake" : "",
  ].filter(Boolean)

  return {
    role,
    roleLabel: ROLE_LABELS[role],
    job: brief.job,
    shops: brief.shops,
    pages,
    actions,
    sections,
  }
}

export function manualHaystack(section: ManualSection) {
  return [section.title, section.group, section.what, ...section.doThis, ...section.watch, ...section.cannot, ...section.lookup]
    .join(" ")
    .toLowerCase()
}
