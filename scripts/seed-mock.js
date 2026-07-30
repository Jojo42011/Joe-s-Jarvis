#!/usr/bin/env node
/**
 * Seed obviously-fake demo data so Joe can check whether Jarvis really reaches
 * every part of the system — leads, calls, inbox, invoices, materials, spend
 * and calendar — by asking about records whose answers are known in advance.
 *
 * This writes into the LIVE database, so every row it creates is tagged and
 * removable:
 *   • leads.referred_by = 'MOCK'
 *   • vapi_calls.assistant_id = 'MOCK'
 *   • email_items.gmail_id LIKE 'MOCK-%'
 *   • suppliers.notes / material_orders.notes / spend_items.purpose start 'MOCK'
 *   • calendar_events.event_id LIKE 'MOCK-%'
 *   • lead_payments rows hang off mock leads only
 *
 *   node scripts/seed-mock.js         seed
 *   node scripts/seed-mock.js --clear remove every mock row, touching nothing else
 */
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const DB_PATH = process.env.DB_PATH || '/data/jarvis.db';
const db = new Database(DB_PATH);
const clear = process.argv.includes('--clear');

const iso = (daysAgo, hour) => {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  if (hour != null) d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

function clearMock() {
  const ids = db.prepare("SELECT id FROM leads WHERE referred_by = 'MOCK'").all().map((r) => r.id);
  if (ids.length) {
    const list = ids.join(',');
    db.exec(`DELETE FROM material_order_items WHERE order_id IN (SELECT id FROM material_orders WHERE lead_id IN (${list}))`);
    db.exec(`DELETE FROM material_orders WHERE lead_id IN (${list})`);
    db.exec(`DELETE FROM lead_payments WHERE lead_id IN (${list})`);
    db.exec(`DELETE FROM lead_activities WHERE lead_id IN (${list})`);
    db.exec(`DELETE FROM lead_estimate_items WHERE lead_id IN (${list})`);
    db.exec(`DELETE FROM leads WHERE id IN (${list})`);
  }
  db.exec("DELETE FROM material_order_items WHERE order_id IN (SELECT id FROM material_orders WHERE notes LIKE 'MOCK%')");
  db.exec("DELETE FROM material_orders WHERE notes LIKE 'MOCK%'");
  db.exec("DELETE FROM vapi_calls WHERE assistant_id = 'MOCK'");
  db.exec("DELETE FROM email_items WHERE gmail_id LIKE 'MOCK-%'");
  db.exec("DELETE FROM suppliers WHERE notes LIKE 'MOCK%'");
  db.exec("DELETE FROM spend_items WHERE purpose LIKE 'MOCK%'");
  db.exec("DELETE FROM calendar_events WHERE event_id LIKE 'MOCK-%'");
  console.log('Mock data removed. Real records untouched.');
}

if (clear) { clearMock(); process.exit(0); }

// Idempotent: re-running replaces the mock set rather than duplicating it.
clearMock();

/* ── Leads / CRM ──────────────────────────────────────────────────────── */
const insLead = db.prepare(`
  INSERT INTO leads (name, phone, email, address, project_type, budget, timeline,
                     called, booked, created_at, source, message, pipeline, notes,
                     tier, build_stage, project_value_cents, referred_by)
  VALUES (@name,@phone,@email,@address,@project_type,@budget,@timeline,
          @called,@booked,@created_at,@source,@message,@pipeline,@notes,
          @tier,@build_stage,@project_value_cents,'MOCK')`);

const LEADS = [
  { name:'Marcus Yoder', phone:'+13305550142', email:'myoder@example.com',
    address:'4821 Township Rd 367, Millersburg, OH', project_type:'paver patio + fire pit',
    budget:'$20-25k', timeline:'this spring', called:1, booked:1, created_at:iso(21),
    source:'sofia', message:'Wants a 600 sq ft paver patio with a built-in fire pit off the back door.',
    pipeline:'in_progress', notes:'Picked Unilock Brussels Block, charcoal. Dog gets out — keep the gate shut.',
    tier:'standard', build_stage:'hardscape', project_value_cents:2340000 },

  { name:'Deb Hostetler', phone:'+13305550187', email:'deb.hostetler@example.com',
    address:'112 S Washington St, Millersburg, OH', project_type:'retaining wall',
    budget:'$15k', timeline:'before August', called:1, booked:1, created_at:iso(14),
    source:'referral', message:'Hillside behind the house is washing out after every storm.',
    pipeline:'booked', notes:'Referred by Marcus Yoder. Needs the wall engineered — over 4 ft.',
    tier:'luxury', build_stage:'excavation', project_value_cents:1875000 },

  { name:'Ray Schlabach', phone:'+13305550163', email:'rschlabach@example.com',
    address:'7739 State Route 39, Berlin, OH', project_type:'full landscape design',
    budget:'unsure', timeline:'fall', called:1, booked:0, created_at:iso(9),
    source:'website', message:'New build, bare dirt lot, wants the whole front and back done.',
    pipeline:'quoted', notes:'Quote went out 6 days ago, no answer yet. Follow up Monday.',
    tier:'luxury', build_stage:'design', project_value_cents:4120000 },

  { name:'Linda Troyer', phone:'+13305550119', email:'ltroyer@example.com',
    address:'265 N Clay St, Millersburg, OH', project_type:'mulch + bed cleanup',
    budget:'$2k', timeline:'ASAP', called:1, booked:0, created_at:iso(4),
    source:'ads', message:'Beds are a mess, wants them edged and mulched before a graduation party.',
    pipeline:'contacted', notes:'Party is the 15th — hard deadline.',
    tier:'standard', build_stage:'not_started', project_value_cents:210000 },

  { name:'Curtis Mast', phone:'+13305550198', email:'cmast@example.com',
    address:'9012 Co Rd 201, Fredericksburg, OH', project_type:'driveway excavation',
    budget:'$8-10k', timeline:'no rush', called:0, booked:0, created_at:iso(2),
    source:'sofia', message:'Gravel drive keeps washing out, asking about regrading and new base.',
    pipeline:'new', notes:'', tier:'standard', build_stage:'not_started', project_value_cents:0 },

  { name:'Janet Weaver', phone:'+13305550176', email:'jweaver@example.com',
    address:'588 Massillon Rd, Millersburg, OH', project_type:'walkway',
    budget:'$5k', timeline:'summer', called:0, booked:0, created_at:iso(1),
    source:'website', message:'Front walk is cracked and heaving, wants it replaced in flagstone.',
    pipeline:'new', notes:'', tier:'standard', build_stage:'not_started', project_value_cents:0 },
];
const leadIds = {};
for (const l of LEADS) leadIds[l.name] = insLead.run(l).lastInsertRowid;

/* Timeline activity on the two active jobs. */
const act = db.prepare(
  'INSERT INTO lead_activities (lead_id, type, direction, subject, body, created_at) VALUES (?,?,?,?,?,?)');
act.run(leadIds['Marcus Yoder'], 'note', 'system', 'Excavation complete',
  'Excavation finished and base compacted. Pavers start Tuesday.', iso(3));
act.run(leadIds['Marcus Yoder'], 'call', 'in', 'Seat wall question',
  'Marcus called asking to add a seat wall to the patio — quoted about $3,200 extra.', iso(2));
act.run(leadIds['Deb Hostetler'], 'note', 'system', 'Permit submitted',
  'Engineer stamped the wall drawing. Permit submitted to the county.', iso(5));
act.run(leadIds['Ray Schlabach'], 'email', 'out', 'Design proposal sent',
  'Full landscape design proposal emailed — $41,200. No response yet.', iso(6));

/* ── Sofia's call log (phones tab) ───────────────────────────────────── */
const insCall = db.prepare(`
  INSERT INTO vapi_calls (assistant_id, direction, number, customer_name, duration_sec,
                          connected, booked, ended_reason, started_at, summary, transcript)
  VALUES ('MOCK',@direction,@number,@customer_name,@duration_sec,@connected,@booked,
          @ended_reason,@started_at,@summary,@transcript)`);
[
  { direction:'inbound', number:'+13305550142', customer_name:'Marcus Yoder', duration_sec:214,
    connected:1, booked:1, ended_reason:'customer-ended-call', started_at:iso(2, 10),
    summary:'Marcus asked about adding a seat wall to the patio. Quoted roughly $3,200 extra. He wants to think it over and call back Friday.',
    transcript:'Sofia: Totally Outdoors, this is Sofia. / Marcus: Hey, it is Marcus Yoder...' },
  { direction:'inbound', number:'+13305550198', customer_name:'Curtis Mast', duration_sec:167,
    connected:1, booked:0, ended_reason:'customer-ended-call', started_at:iso(2, 14),
    summary:'New caller. Gravel driveway washing out on Co Rd 201. Wants regrading and a new stone base. No rush on timing. Asked for a ballpark — Sofia booked an estimate instead.',
    transcript:'Sofia: Totally Outdoors, this is Sofia. / Curtis: Yeah, my driveway keeps washing out...' },
  { direction:'inbound', number:'+13305550119', customer_name:'Linda Troyer', duration_sec:98,
    connected:1, booked:0, ended_reason:'customer-ended-call', started_at:iso(1, 9),
    summary:'Linda chasing the mulch quote. Graduation party is the 15th and she needs the beds done before then. Sounded impatient.',
    transcript:'Linda: I called last week about the mulch...' },
  { direction:'inbound', number:'+13305550204', customer_name:null, duration_sec:31,
    connected:1, booked:0, ended_reason:'customer-ended-call', started_at:iso(1, 15),
    summary:'Solar panel sales call. Not a customer.',
    transcript:'Caller: Am I speaking with the homeowner...' },
  { direction:'outbound', number:'+13305550163', customer_name:'Ray Schlabach', duration_sec:0,
    connected:0, booked:0, ended_reason:'no-answer', started_at:iso(1, 11),
    summary:'Follow-up on the landscape design quote. No answer, no voicemail left.', transcript:'' },
  { direction:'inbound', number:'+13305550176', customer_name:'Janet Weaver', duration_sec:143,
    connected:1, booked:0, ended_reason:'customer-ended-call', started_at:iso(0, 8),
    summary:'Janet on Massillon Rd wants her cracked front walk replaced in flagstone. Asked whether Joe does flagstone — Sofia confirmed and took her details.',
    transcript:'Janet: Do you all do flagstone walkways?' },
].forEach((c) => insCall.run(c));

/* ── Inbox (clearly tagged so real mail is untouched) ────────────────── */
const acct = (db.prepare('SELECT email FROM google_accounts LIMIT 1').get() || {}).email
  || 'totallyoutdoors@gmail.com';
const insEmail = db.prepare(`
  INSERT INTO email_items (account_email, gmail_id, thread_id, from_addr, to_addr, subject,
                           snippet, received_at, is_unread, priority, category, needs_reply,
                           summary, draft_reply, draft_status, triaged)
  VALUES (@acct,@gmail_id,@gmail_id,@from_addr,@acct,@subject,@snippet,@received_at,
          @is_unread,@priority,@category,@needs_reply,@summary,@draft_reply,@draft_status,1)`);
[
  { gmail_id:'MOCK-1', from_addr:'deb.hostetler@example.com', subject:'Retaining wall — permit question',
    snippet:'Joe, the county called and said they need the engineer stamp resubmitted with the site plan attached. Can you send that over? Also, are we still on for starting the 12th?',
    received_at:iso(1, 8), is_unread:1, priority:1, category:'customer', needs_reply:1,
    summary:'Deb needs the engineer stamp resubmitted with the site plan, and is confirming the 12th start date.',
    draft_reply:'Hi Deb — I will get the stamped drawing and site plan back over to the county this morning. We are still good for the 12th.',
    draft_status:'pending' },
  { gmail_id:'MOCK-2', from_addr:'sales@holmeslumber.example.com', subject:'Your quote #4471 — Unilock pavers',
    snippet:'Thanks for the inquiry. Brussels Block in charcoal is $4.85/sq ft, and we have 14 pallets in stock. Price holds for 30 days.',
    received_at:iso(2, 13), is_unread:0, priority:2, category:'supplier', needs_reply:0,
    summary:'Holmes Lumber quoted Brussels Block charcoal at $4.85/sq ft, 14 pallets in stock, price good 30 days.',
    draft_reply:null, draft_status:null },
  { gmail_id:'MOCK-3', from_addr:'rschlabach@example.com', subject:'Re: Landscape design proposal',
    snippet:'Hi Joe, we looked over the proposal. The number is higher than we expected. Is there a way to phase it so we do the front this year and the back next spring?',
    received_at:iso(3, 16), is_unread:1, priority:1, category:'customer', needs_reply:1,
    summary:'Ray wants to phase the $41,200 design — front yard this year, back next spring — because the total is over his expectation.',
    draft_reply:'Ray — absolutely, we can phase it. Front yard this season comes to about $24,000, with the back next spring at current pricing.',
    draft_status:'pending' },
  { gmail_id:'MOCK-4', from_addr:'ltroyer@example.com', subject:'Mulch — when can you come?',
    snippet:'Joe, following up again. The party is the 15th. I need to know if you can get to us before then or I will have to find someone else.',
    received_at:iso(0, 7), is_unread:1, priority:1, category:'customer', needs_reply:1,
    summary:'Linda Troyer is about to go elsewhere — needs mulch and bed cleanup before her party on the 15th.',
    draft_reply:null, draft_status:null },
].forEach((e) => insEmail.run({ ...e, acct }));

/* ── Money: invoices (money tab) ─────────────────────────────────────── */
const insPay = db.prepare(`
  INSERT INTO lead_payments (lead_id, label, amount_cents, method, status, paid_at,
                             invoice_no, invoice_sent_at, payment_url)
  VALUES (@lead_id,@label,@amount_cents,@method,@status,@paid_at,@invoice_no,@invoice_sent_at,@payment_url)`);
[
  { lead_id:leadIds['Marcus Yoder'], label:'Deposit (30%)', amount_cents:702000, method:'check',
    status:'paid', paid_at:iso(18), invoice_no:'INV-2026-0101', invoice_sent_at:iso(20), payment_url:null },
  { lead_id:leadIds['Marcus Yoder'], label:'Excavation complete', amount_cents:585000, method:null,
    status:'pending', paid_at:null, invoice_no:'INV-2026-0114', invoice_sent_at:iso(3), payment_url:null },
  { lead_id:leadIds['Deb Hostetler'], label:'Deposit (30%)', amount_cents:562500, method:null,
    status:'pending', paid_at:null, invoice_no:'INV-2026-0117', invoice_sent_at:null, payment_url:null },
  { lead_id:leadIds['Deb Hostetler'], label:'Design + engineering', amount_cents:120000, method:'card',
    status:'paid', paid_at:iso(11), invoice_no:'INV-2026-0109', invoice_sent_at:iso(12), payment_url:null },
].forEach((p) => insPay.run(p));

/* ── Materials: suppliers + purchase orders ──────────────────────────── */
const insSup = db.prepare(
  "INSERT INTO suppliers (name, category, contact_name, phone, email, notes) VALUES (?,?,?,?,?,'MOCK demo supplier')");
const supHolmes = insSup.run('Holmes Lumber & Stone', 'hardscape', 'Dwight Miller', '+13306740100', 'sales@holmeslumber.example.com').lastInsertRowid;
const supBerlin = insSup.run('Berlin Aggregate', 'aggregate', 'Ruth Mast', '+13308930155', 'orders@berlinaggregate.example.com').lastInsertRowid;
insSup.run('Walnut Creek Nursery', 'nursery', 'Ivan Yoder', '+13308520188', 'ivan@wcnursery.example.com');

const insPo = db.prepare(`
  INSERT INTO material_orders (lead_id, supplier_id, po_number, status, needed_by, needed_by_stage, notes)
  VALUES (@lead_id,@supplier_id,@po_number,@status,@needed_by,@needed_by_stage,'MOCK demo order')`);
const insPoItem = db.prepare(
  'INSERT INTO material_order_items (order_id, label, qty, unit, unit_price_cents) VALUES (?,?,?,?,?)');

const po1 = insPo.run({ lead_id:leadIds['Marcus Yoder'], supplier_id:supHolmes, po_number:'PO-0041',
  status:'ordered', needed_by:iso(-4).slice(0,10), needed_by_stage:'hardscape' }).lastInsertRowid;
insPoItem.run(po1, 'Unilock Brussels Block — charcoal', 14, 'pallet', 48500);
insPoItem.run(po1, 'Polymeric sand', 12, 'bag', 2400);

const po2 = insPo.run({ lead_id:leadIds['Deb Hostetler'], supplier_id:supBerlin, po_number:'PO-0042',
  status:'draft', needed_by:iso(-7).slice(0,10), needed_by_stage:'excavation' }).lastInsertRowid;
insPoItem.run(po2, '#57 limestone', 22, 'ton', 3200);
insPoItem.run(po2, 'Geogrid reinforcement', 400, 'sq ft', 180);

/* ── Spend ───────────────────────────────────────────────────────────── */
const insSpend = db.prepare(
  'INSERT INTO spend_items (name, kind, cost_cents, cycle, purpose, lead_source, active) VALUES (?,?,?,?,?,?,1)');
insSpend.run('Google Ads — Holmes County', 'ad', 90000, 'monthly', 'MOCK — local search ads for patios and walls', 'ads');
insSpend.run('Angi Leads', 'service', 45000, 'monthly', 'MOCK — lead marketplace subscription', 'ads');
insSpend.run('QuickBooks', 'subscription', 9900, 'monthly', 'MOCK — bookkeeping and invoicing', null);
insSpend.run('Equipment insurance', 'service', 31000, 'monthly', 'MOCK — skid steer and mini-ex coverage', null);

/* ── Calendar ────────────────────────────────────────────────────────── */
const insEv = db.prepare(`
  INSERT INTO calendar_events (account_email, event_id, summary, description, location,
                               start_time, end_time, status)
  VALUES (?,?,?,?,?,?,?,'confirmed')`);
const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
insEv.run(acct, 'MOCK-E1', 'Site visit — Janet Weaver (flagstone walk)', 'Measure the front walk, price flagstone options.', '588 Massillon Rd, Millersburg, OH', at(13), at(14));
insEv.run(acct, 'MOCK-E2', 'Pavers delivered — Yoder patio', 'Holmes Lumber dropping 14 pallets. Someone needs to be on site.', '4821 Township Rd 367, Millersburg, OH', at(15), at(16));
const tm = (h) => { const d = new Date(Date.now() + 86400_000); d.setHours(h, 0, 0, 0); return d.toISOString(); };
insEv.run(acct, 'MOCK-E3', 'Estimate — Curtis Mast (driveway)', 'Regrade and new base, Co Rd 201.', '9012 Co Rd 201, Fredericksburg, OH', tm(10), tm(11));

console.log(`Seeded mock data into ${DB_PATH}:`);
console.log(`  ${LEADS.length} leads · 6 calls · 4 emails · 4 invoices · 3 suppliers · 2 POs · 4 spend items · 3 calendar events`);
console.log('Remove it all with: node scripts/seed-mock.js --clear');
