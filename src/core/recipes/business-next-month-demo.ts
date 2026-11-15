/**
 * "Next month's business files" demo data (bundled inline, never fetched).
 *
 * Month two of the business story: the same CRM export (`crm_customers.csv`)
 * plus the April 2026 billing export (`billing_invoices_2026_04.csv`). Same
 * headers and the same kinds of mess as the March business demo (casing
 * variants, a whitespace issue, mixed date formats, currency strings, a missing
 * revenue, mixed Paid/paid, billing emails in other casings, invented
 * `.example` names), with new rows: 2 new customers, 2 duplicate CRM rows and
 * new April invoices.
 *
 * That lets the recipe story run on the business data: stitch the March files,
 * save a recipe, reset the lab, load these files, apply the recipe. The billing
 * file has a different name, so the recipe maps it by its column schema.
 */

export const BUSINESS_NEXT_MONTH_CRM_CSV = `Customer Name,Email,Region,Plan,Customer Since,Monthly Revenue
Northwind Analytics,jane.doe@northwind-analytics.example,North America,Enterprise,2025-01-15,"$4,200.00"
northwind analytics ,omar.khan@northwind-analytics.example,North America,Pro,03/22/2025,"$1,200.00"
NORTHWIND Analytics,li.wei@northwind-analytics.example,APAC,Pro,"Jun 5, 2025","$1,150.00"
Bluepeak Logistics,harper.simmons@bluepeak.example,North America,Enterprise,2025-02-03,"$5,600.00"
Cedar & Pine Health,paul.green@cedarpine.example,North America,Starter,04/10/2025,$300.00
Harborline Foods,alan.weston@harborline.example,EMEA,Enterprise,2025-05-19,"$7,800.00"
Lumen Software,gavin.hale@lumensoft.example,North America,pro,"Jul 1, 2025","$2,100.00"
Ironbridge Manufacturing,tom.ainsley@ironbridge.example,North America,Enterprise,2025-01-28,"$9,500.00"
Redwood Capital,beth.rowan@redwoodcap.example,North America,Enterprise,02/14/2025,"$8,900.00"
Sweetwater Foods,will.baker@sweetwater.example,emea,Pro,2025-08-08,"$1,750.00"
Greenfield Grocers,maria.soto@greenfield.example,EMEA,Starter,2025-09-12,$450.00
Quantum Freight,mike.davies@quantumfreight.example,APAC,Pro,10/05/2025,"$1,600.00"
Silverline Biotech,eva.turner@silverline.example,APAC,Enterprise,2025-03-30,"$6,300.00"
Marlow Imports,arthur.vale@marlow.example,North America,Starter,"Nov 11, 2025",
Pinecrest Cloud,ruth.hendry@pinecrest.example,North America,Pro,2025-06-21,"$1,900.00"
Millbrook Paper,mark.stone@millbrook.example,North America,Starter,12/01/2025,$520.00
Orchard Labs,nina.owens@orchardlabs.example,EMEA,Pro,2025-04-04,N/A
Summit Dynamics,walter.bell@summitdyn.example,EMEA,Enterprise,2025-07-22,"$7,200.00"
Granite Bank,bill.grant@granitebank.example,EMEA,Pro,"Aug 30, 2025","$2,400.00"
Crestview Worldwide,ben.stephens@crestview.example,APAC,Starter,2025-10-17,$380.00
Tidewater Shipping,rosa.lindqvist@tidewater.example,emea,Starter,2026-03-12,$320.00
Alder Pharmacy,kenji.mori@alderpharmacy.example,APAC,pro,"Mar 28, 2026","$2,750.00"
Harborline Foods,alan.weston@harborline.example,EMEA,Enterprise,2025-05-19,"$7,800.00"
Redwood Capital,beth.rowan@redwoodcap.example,North America,Enterprise,02/14/2025,"$8,900.00"
`;

export const BUSINESS_NEXT_MONTH_BILLING_CSV = `client_name,email,invoice_date,amount,status,region
Northwind Analytics Ltd,jane.doe@northwind-analytics.example,2026-04-02,4200.00,Paid,North America
Northwind Analytics Ltd,omar.khan@northwind-analytics.example,2026-04-02,1176.00,paid,North America
Northwind Analytics Ltd,LI.WEI@NORTHWIND-ANALYTICS.EXAMPLE,2026-04-03,1150.00,Paid,APAC
Bluepeak Logistics Inc,harper.simmons@bluepeak.example,2026-04-06,5488.00,Pending,North America
Cedar and Pine Health LLC,paul.green@cedarpine.example,2026-04-06,300.00,Paid,North America
Harborline Foods Limited,alan.weston@harborline.example,2026-04-08,7644.00,Paid,EMEA
Lumen Software Inc,gavin.hale@lumensoft.example,2026-04-08,2100.00,paid,North America
Ironbridge Manufacturing Co,Tom.Ainsley@Ironbridge.Example,2026-04-09,9310.00,Paid,North America
Redwood Capital LLC,beth.rowan@redwoodcap.example,2026-04-09,8900.00,Overdue,North America
Sweetwater Foods Ltd,will.baker@sweetwater.example,2026-04-10,1750.00,Paid,EMEA
Greenfield Grocers,maria.soto@greenfield.example,2026-04-10,450.00,paid,EMEA
Quantum Freight Systems,mike.davies@quantumfreight.example,2026-04-13,1600.00,Paid,APAC
Silverline Biotech Corporation,eva.turner@silverline.example,2026-04-13,6300.00,Pending,APAC
Marlow Imports,arthur.vale@marlow.example,2026-04-14,520.00,Paid,North America
Pinecrest Cloud Inc,ruth.hendry@pinecrest.example,2026-04-14,1900.00,Overdue,North America
Summit Dynamics Inc,Walter.Bell@Summitdyn.Example,2026-04-15,7200.00,Paid,EMEA
Granite Bank plc,bill.grant@granitebank.example,2026-04-16,2400.00,paid,EMEA
Tidewater Shipping Co,rosa.lindqvist@tidewater.example,2026-04-20,3200.00,Paid,EMEA
Alder Pharmacy Group,kenji.mori@alderpharmacy.example,2026-04-21,2750.00,Pending,APAC
Tidewater Shipping Co,rosa.lindqvist@tidewater.example,2026-04-27,1100.00,paid,EMEA
Northwind Analytics Ltd,Jane.Doe@Northwind-Analytics.Example,2026-04-28,4242.00,Paid,North America
Millbrook Paper Co,mark.stone@millbrook.example,2026-04-29,540.80,Overdue,North America
Orchard Labs,nina.owens@orchardlabs.example,2026-04-29,1300.00,Paid,EMEA
Crestview Worldwide,ben.stephens@crestview.example,2026-04-30,380.00,paid,APAC
`;

/** The two bundled files, in display order. */
export const BUSINESS_NEXT_MONTH_FILES: readonly { fileName: string; csv: string }[] = [
  { fileName: "crm_customers.csv", csv: BUSINESS_NEXT_MONTH_CRM_CSV },
  { fileName: "billing_invoices_2026_04.csv", csv: BUSINESS_NEXT_MONTH_BILLING_CSV },
];

/** Materialize the bundled files as `File` objects for the intake pipeline. */
export async function loadBusinessNextMonthFiles(): Promise<File[]> {
  return BUSINESS_NEXT_MONTH_FILES.map(
    ({ fileName, csv }) => new File([csv], fileName, { type: "text/csv" })
  );
}
