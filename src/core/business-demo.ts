/**
 * "Load business demo" data (bundled inline, never fetched): a CRM export and
 * a billing export that never agree. Realistic mess: duplicate customers,
 * casing and whitespace variants, mixed date formats, currency strings, nulls,
 * and billing emails that differ in casing from the CRM.
 */
export const BUSINESS_CRM_CSV = `Customer Name,Email,Region,Plan,Customer Since,Monthly Revenue
Acme Corp,jane.doe@acme.com,North America,Enterprise,2025-01-15,"$4,200.00"
acme corp ,omar.khan@acme.com,North America,Pro,03/22/2025,"$1,200.00"
ACME Corp,li.wei@acme.com,APAC,Pro,"Jun 5, 2025","$1,150.00"
Globex Inc,h.simpson@globex.com,North America,Enterprise,2025-02-03,"$5,600.00"
Initech,peter.g@initech.com,North America,Starter,04/10/2025,$300.00
Umbrella Ltd,a.wesker@umbrella.co.uk,EMEA,Enterprise,2025-05-19,"$7,800.00"
Hooli,gavin@hooli.com,North America,pro,"Jul 1, 2025","$2,100.00"
Stark Industries,tony@stark.io,North America,Enterprise,2025-01-28,"$9,500.00"
Wayne Enterprises,bruce@wayne.com,North America,Enterprise,02/14/2025,"$8,900.00"
Wonka Foods,willy@wonka.com,emea,Pro,2025-08-08,"$1,750.00"
Soylent Co,m.sol@soylent.com,EMEA,Starter,2025-09-12,$450.00
Cyberdyne,miles@cyberdyne.com,APAC,Pro,10/05/2025,"$1,600.00"
Tyrell Corp,e.tyrell@tyrell.com,APAC,Enterprise,2025-03-30,"$6,300.00"
Vandelay Imports,art.v@vandelay.com,North America,Starter,"Nov 11, 2025",
Pied Piper,richard@piedpiper.com,North America,Pro,2025-06-21,"$1,900.00"
Dunder Mifflin,m.scott@dundermifflin.com,North America,Starter,12/01/2025,$520.00
Oscorp,n.osborn@oscorp.com,EMEA,Pro,2025-04-04,N/A
Massive Dynamic,w.bishop@massivedynamic.com,EMEA,Enterprise,2025-07-22,"$7,200.00"
Gringotts,b.griphook@gringotts.co.uk,EMEA,Pro,"Aug 30, 2025","$2,400.00"
Prestige Worldwide,b.stepbro@prestige.com,APAC,,2025-10-17,$380.00
Globex Inc,h.simpson@globex.com,North America,Enterprise,2025-02-03,"$5,600.00"
Cyberdyne,miles@cyberdyne.com,APAC,Pro,10/05/2025,"$1,600.00"
`;

export const BUSINESS_BILLING_CSV = `client_name,email,invoice_date,amount,status,region
Acme Corporation,jane.doe@acme.com,2026-01-03,3990.00,Paid,North America
Acme Corporation,li.wei@acme.com,2026-01-03,1092.50,paid,APAC
Initech LLC,peter.g@initech.com,2026-01-06,285.00,Overdue,North America
Hooli Inc,gavin@hooli.com,2026-01-09,1995.00,Paid,North America
Wayne Enterprises LLC,Bruce@Wayne.Com,2026-01-09,8455.00,paid,North America
Cyberdyne Systems,miles@cyberdyne.com,2026-01-12,1520.00,Overdue,APAC
Massive Dynamic Inc,w.bishop@massivedynamic.com,2026-01-15,6840.00,paid,Emea
Pied Piper Inc,richard@piedpiper.com,2026-01-15,1805.00,Paid,North America
Acme Corporation,omar.khan@acme.com,2026-02-08,1176.00,Paid,North America
Globex Incorporated,h.simpson@globex.com,2026-02-08,5488.00,Overdue,North America
Umbrella Limited,a.wesker@umbrella.co.uk,2026-02-11,7644.00,Paid,Emea
Stark Industries Inc,tony@stark.io,2026-02-14,9310.00,Paid,North America
Wonka Foods Ltd,willy@wonka.com,2026-02-14,1715.00,Overdue,Emea
Tyrell Corporation,e.tyrell@tyrell.com,2026-02-17,6174.00,Paid,APAC
Dunder Mifflin Paper Co,m.scott@dundermifflin.com,2026-02-20,509.60,Paid,North America
Gringotts Bank,B.Griphook@Gringotts.Co.Uk,2026-02-20,2352.00,Overdue,Emea
Acme Corporation,jane.doe@acme.com,2026-03-10,4242.00,Paid,North America
Acme Corporation,li.wei@acme.com,2026-03-13,1161.50,Paid,APAC
Initech LLC,peter.g@initech.com,2026-03-13,303.00,Paid,North America
Hooli Inc,gavin@hooli.com,2026-03-16,2121.00,Paid,North America
Cyberdyne Systems,miles@cyberdyne.com,2026-03-19,1616.00,Paid,APAC
Wayne Enterprises LLC,bruce@wayne.com,2026-03-19,8989.00,Paid,North America
Pied Piper Inc,richard@piedpiper.com,2026-03-22,1919.00,Paid,North America
Massive Dynamic Inc,w.bishop@massivedynamic.com,2026-03-25,7272.00,Paid,Emea
Dunder Mifflin Paper Co,m.scott@dundermifflin.com,2026-04-03,540.80,Paid,North America
Gringotts Bank,b.griphook@gringotts.co.uk,2026-04-06,2496.00,Pending,Emea
Acme Corporation,omar.khan@acme.com,2026-04-15,1248.00,Paid,North America
Globex Incorporated,H.Simpson@Globex.Com,2026-04-18,5824.00,Pending,North America
Umbrella Limited,a.wesker@umbrella.co.uk,2026-04-18,8112.00,Paid,Emea
Stark Industries Inc,tony@stark.io,2026-04-21,9880.00,Paid,North America
Tyrell Corporation,e.tyrell@tyrell.com,2026-04-24,6552.00,Paid,APAC
Wonka Foods Ltd,willy@wonka.com,2026-04-24,1820.00,Pending,Emea
Cyberdyne Systems,Miles@Cyberdyne.Com,2026-05-05,1712.00,paid,APAC
Pied Piper Inc,richard@piedpiper.com,2026-05-05,2033.00,Paid,North America
Massive Dynamic Inc,w.bishop@massivedynamic.com,2026-05-08,7704.00,Pending,Emea
Acme Corporation,jane.doe@acme.com,2026-05-17,4494.00,Paid,North America
Acme Corporation,LI.WEI@ACME.COM,2026-05-20,1230.50,Pending,APAC
Hooli Inc,gavin@hooli.com,2026-05-23,2247.00,Paid,North America
Initech LLC,peter.g@initech.com,2026-05-23,321.00,paid,North America
Wayne Enterprises LLC,bruce@wayne.com,2026-05-26,9523.00,Pending,North America
Stark Industries Inc,tony@stark.io,2026-06-04,10450.00,Pending,North America
Umbrella Limited,a.wesker@umbrella.co.uk,2026-06-04,8580.00,Overdue,Emea
Wonka Foods Ltd,WILLY@WONKA.COM,2026-06-07,1925.00,paid,Emea
Dunder Mifflin Paper Co,m.scott@dundermifflin.com,2026-06-10,572.00,Pending,North America
Tyrell Corporation,e.tyrell@tyrell.com,2026-06-10,6930.00,Overdue,APAC
Gringotts Bank,b.griphook@gringotts.co.uk,2026-06-13,2640.00,paid,Emea
Acme Corporation,Omar.Khan@Acme.Com,2026-06-22,1320.00,Pending,North America
Globex Incorporated,h.simpson@globex.com,2026-06-25,6160.00,paid,North America
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
