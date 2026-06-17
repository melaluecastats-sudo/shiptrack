import { NextResponse } from 'next/server';
import crypto from 'crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SHEET_ID     = process.env.GOOGLE_SHEET_ID!;
const API_KEY      = process.env.GOOGLE_SHEETS_API_KEY!;

export async function POST(req: Request) {
  try {
    const body = await req.text();
    console.log('Shippo webhook received');
    console.log('Body preview:', body.slice(0, 800));

    const event = JSON.parse(body);
    if (!['transaction_created','label_created'].includes(event.event)) {
      return NextResponse.json({ received: true, event: event.event });
    }

    const txn = event.data;
    if (!txn) return NextResponse.json({ received: true, note: 'no data' });

    const tracking_number = txn.tracking_number || txn.tracking_number_provider || '';
    const carrier         = normalizeCarrier(txn.servicelevel?.token || txn.carrier_account || '');
    const tracking_url    = txn.tracking_url_provider || txn.tracking_url || '';

    const addrFrom = txn.shipment?.address_from || txn.address_from || {};
    const addrTo   = txn.shipment?.address_to   || txn.address_to   || {};

    const fromStreet = (addrFrom.street1 || '').toLowerCase().trim();
    const fromZip    = (addrFrom.zip     || '').trim();
    const toName     = addrTo.name || addrTo.company || '';
    const fromName   = addrFrom.name || addrFrom.company || '';

    console.log('From:', fromName, fromStreet, fromZip);
    console.log('To:', toName);

    if (!tracking_number) {
      return NextResponse.json({ received: true, note: 'no tracking number' });
    }

    let matchedName = toName || fromName || 'Shippo Label';

    if (fromZip) {
      try {
        const encoded = encodeURIComponent(`Account Logins!A2:R300`);
        const sheetRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encoded}?key=${API_KEY}`
        );
        const sheetData = await sheetRes.json();
        const rows: string[][] = sheetData.values || [];
        for (const row of rows) {
          const shipTo = (row[10] || '').toLowerCase();
          if (shipTo.includes(fromZip) || shipTo.includes(fromStreet)) {
            matchedName = row[2] || matchedName;
            console.log('Matched mailbox:', matchedName);
            break;
          }
        }
      } catch(e) {
        console.log('Sheet lookup failed:', e);
      }
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/shipments`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        tracking_number,
        carrier,
        tracking_url,
        shipment_direction: 'outbound',
        current_status: 'Label Created',
        customer_name: matchedName,
        description: 'Shippo Label — Mailbox to Warehouse',
        sync_source: 'shippo',
        updated_at: new Date().toISOString(),
      })
    });

    const resText = await res.text();
    console.log('Supabase response:', res.status, resText.slice(0, 200));

    if (!res.ok) return NextResponse.json({ error: resText }, { status: 500 });

    return NextResponse.json({ received: true, tracking_number, customer_name: matchedName });

  } catch (e: any) {
    console.error('Shippo webhook error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

function normalizeCarrier(token: string): string {
  if (!token) return 'Unknown';
  const t = token.toLowerCase();
  if (t.includes('ups'))   return 'UPS';
  if (t.includes('usps'))  return 'USPS';
  if (t.includes('fedex')) return 'FedEx';
  if (t.includes('dhl'))   return 'DHL';
  return token.toUpperCase().split('_')[0];
}
