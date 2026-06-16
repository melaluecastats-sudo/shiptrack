import { NextResponse } from 'next/server';
import crypto from 'crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const WEBHOOK_SECRET = process.env.SHIPPO_WEBHOOK_SECRET!;

export async function POST(req: Request) {
  try {
    const body = await req.text();

    console.log('Shippo webhook received');
    console.log('Headers:', JSON.stringify(Object.fromEntries(req.headers.entries())));
    console.log('Body preview:', body.slice(0, 1500));

    if (WEBHOOK_SECRET) {
      const signature = req.headers.get('shippo-webhook-signature') ||
                        req.headers.get('x-shippo-signature') || '';
      const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
      const sigClean = signature.replace('sha256=','');
      if (hmac !== sigClean && hmac !== signature) {
        console.log('Signature mismatch. Expected:', hmac, 'Got:', signature);
      }
    }

    const event = JSON.parse(body);
    console.log('Event type:', event.event);

    if (!['transaction_created','label_created'].includes(event.event)) {
      return NextResponse.json({ received: true, event: event.event });
    }

    const txn = event.data;
    if (!txn) return NextResponse.json({ received: true, note: 'no data' });

    const tracking_number = txn.tracking_number || txn.tracking_number_provider || '';
    const carrier         = normalizeCarrier(txn.servicelevel?.token || txn.carrier_account || '');
    const to_name         = txn.shipment?.address_to?.name || txn.address_to?.name || '';
    const sender_name     = txn.shipment?.address_from?.name || txn.address_from?.name || '';
    const company         = txn.shipment?.address_from?.company || txn.address_from?.company || '';
    const tracking_url    = txn.tracking_url_provider || txn.tracking_url || '';

    if (!tracking_number) {
      return NextResponse.json({ received: true, note: 'no tracking number', txn_status: txn.status });
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
        customer_name: to_name || sender_name || company || 'Shippo Label',
        description: 'Shippo Label — Mailbox to Warehouse',
        sync_source: 'shippo',
        updated_at: new Date().toISOString(),
      })
    });

    const resText = await res.text();
    console.log('Supabase response:', res.status, resText.slice(0,200));

    if (!res.ok) return NextResponse.json({ error: resText }, { status: 500 });

    return NextResponse.json({ received: true, tracking_number });

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