/**
 * "Load business demo" data (bundled inline, never fetched): a CRM export and
 * a billing export that never agree. Realistic mess: duplicate customers,
 * casing and whitespace variants, mixed date formats, currency strings, nulls,
 * and billing emails that differ in casing from the CRM.
 */
export const BUSINESS_CRM_CSV = `Customer Name,Email,Region,Plan,Customer Since,Monthly Revenue
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
Crestview Worldwide,ben.stephens@crestview.example,APAC,,2025-10-17,$380.00
Bluepeak Logistics,harper.simmons@bluepeak.example,North America,Enterprise,2025-02-03,"$5,600.00"
Quantum Freight,mike.davies@quantumfreight.example,APAC,Pro,10/05/2025,"$1,600.00"
`;

export const BUSINESS_BILLING_CSV = `client_name,email,invoice_date,amount,status,region
Northwind Analytics Ltd,jane.doe@northwind-analytics.example,2026-01-03,3990.00,Paid,North America
Northwind Analytics Ltd,li.wei@northwind-analytics.example,2026-01-03,1092.50,paid,APAC
Cedar and Pine Health LLC,paul.green@cedarpine.example,2026-01-06,285.00,Overdue,North America
Lumen Software Inc,gavin.hale@lumensoft.example,2026-01-09,1995.00,Paid,North America
Redwood Capital LLC,Beth.Rowan@Redwoodcap.Example,2026-01-09,8455.00,paid,North America
Quantum Freight Systems,mike.davies@quantumfreight.example,2026-01-12,1520.00,Overdue,APAC
Pinecrest Cloud Inc,ruth.hendry@pinecrest.example,2026-01-15,1805.00,Paid,North America
Summit Dynamics Inc,walter.bell@summitdyn.example,2026-01-15,6840.00,paid,EMEA
Bluepeak Logistics Inc,harper.simmons@bluepeak.example,2026-02-08,5488.00,Overdue,North America
Northwind Analytics Ltd,omar.khan@northwind-analytics.example,2026-02-08,1176.00,Paid,North America
Harborline Foods Limited,alan.weston@harborline.example,2026-02-11,7644.00,Paid,EMEA
Ironbridge Manufacturing Co,tom.ainsley@ironbridge.example,2026-02-14,9310.00,Paid,North America
Sweetwater Foods Ltd,will.baker@sweetwater.example,2026-02-14,1715.00,Overdue,EMEA
Silverline Biotech Corporation,eva.turner@silverline.example,2026-02-17,6174.00,Paid,APAC
Granite Bank plc,Bill.Grant@Granitebank.Example,2026-02-20,2352.00,Overdue,EMEA
Millbrook Paper Co,mark.stone@millbrook.example,2026-02-20,509.60,Paid,North America
Northwind Analytics Ltd,jane.doe@northwind-analytics.example,2026-03-10,4242.00,Paid,North America
Cedar and Pine Health LLC,paul.green@cedarpine.example,2026-03-13,303.00,Paid,North America
Northwind Analytics Ltd,li.wei@northwind-analytics.example,2026-03-13,1161.50,Paid,APAC
Lumen Software Inc,gavin.hale@lumensoft.example,2026-03-16,2121.00,Paid,North America
Quantum Freight Systems,mike.davies@quantumfreight.example,2026-03-19,1616.00,Paid,APAC
Redwood Capital LLC,beth.rowan@redwoodcap.example,2026-03-19,8989.00,Paid,North America
Pinecrest Cloud Inc,ruth.hendry@pinecrest.example,2026-03-22,1919.00,Paid,North America
Summit Dynamics Inc,walter.bell@summitdyn.example,2026-03-25,7272.00,Paid,EMEA
Millbrook Paper Co,mark.stone@millbrook.example,2026-04-03,540.80,Paid,North America
Granite Bank plc,bill.grant@granitebank.example,2026-04-06,2496.00,Pending,EMEA
Northwind Analytics Ltd,omar.khan@northwind-analytics.example,2026-04-15,1248.00,Paid,North America
Bluepeak Logistics Inc,Harper.Simmons@Bluepeak.Example,2026-04-18,5824.00,Pending,North America
Harborline Foods Limited,alan.weston@harborline.example,2026-04-18,8112.00,Paid,EMEA
Ironbridge Manufacturing Co,tom.ainsley@ironbridge.example,2026-04-21,9880.00,Paid,North America
Silverline Biotech Corporation,eva.turner@silverline.example,2026-04-24,6552.00,Paid,APAC
Sweetwater Foods Ltd,will.baker@sweetwater.example,2026-04-24,1820.00,Pending,EMEA
Pinecrest Cloud Inc,ruth.hendry@pinecrest.example,2026-05-05,2033.00,Paid,North America
Quantum Freight Systems,Mike.Davies@Quantumfreight.Example,2026-05-05,1712.00,paid,APAC
Summit Dynamics Inc,walter.bell@summitdyn.example,2026-05-08,7704.00,Pending,EMEA
Northwind Analytics Ltd,jane.doe@northwind-analytics.example,2026-05-17,4494.00,Paid,North America
Northwind Analytics Ltd,LI.WEI@NORTHWIND-ANALYTICS.EXAMPLE,2026-05-20,1230.50,Pending,APAC
Cedar and Pine Health LLC,paul.green@cedarpine.example,2026-05-23,321.00,paid,North America
Lumen Software Inc,gavin.hale@lumensoft.example,2026-05-23,2247.00,Paid,North America
Redwood Capital LLC,beth.rowan@redwoodcap.example,2026-05-26,9523.00,Pending,North America
Harborline Foods Limited,alan.weston@harborline.example,2026-06-04,8580.00,Overdue,EMEA
Ironbridge Manufacturing Co,tom.ainsley@ironbridge.example,2026-06-04,10450.00,Pending,North America
Sweetwater Foods Ltd,WILL.BAKER@SWEETWATER.EXAMPLE,2026-06-07,1925.00,paid,EMEA
Millbrook Paper Co,mark.stone@millbrook.example,2026-06-10,572.00,Pending,North America
Silverline Biotech Corporation,eva.turner@silverline.example,2026-06-10,6930.00,Overdue,APAC
Granite Bank plc,bill.grant@granitebank.example,2026-06-13,2640.00,paid,EMEA
Northwind Analytics Ltd,Omar.Khan@Northwind-Analytics.Example,2026-06-22,1320.00,Pending,North America
Bluepeak Logistics Inc,harper.simmons@bluepeak.example,2026-06-25,6160.00,paid,North America
`;

/** The two bundled files, in display order. */
export const BUSINESS_DEMO_FILES: readonly { fileName: string; csv: string }[] = [
  { fileName: "crm_customers.csv", csv: BUSINESS_CRM_CSV },
  { fileName: "billing_invoices.csv", csv: BUSINESS_BILLING_CSV },
];

/** Materialize the bundled files as `File` objects for the intake pipeline. */
export async function loadBusinessFiles(): Promise<File[]> {
  return BUSINESS_DEMO_FILES.map(
    ({ fileName, csv }) => new File([csv], fileName, { type: "text/csv" })
  );
}
