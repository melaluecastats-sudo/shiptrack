import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

export async function GET(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key');
  if (apiKey !== process.env.SYNC_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // Shipments
  const { data: shipments } = await supabase
    .from('shipments')
    .select('*')
    .order('added_at', { ascending: false });

  const all = shipments || [];
  const todayShipments = all.filter(s => s.added_at === today);
  const yesterdayShipments = all.filter(s => s.added_at === yesterday);

  const inboundToday = todayShipments.filter(s => s.shipment_direction === 'inbound');
  const outboundToday = todayShipments.filter(s => s.shipment_direction === 'outbound');
  const inboundYesterday = yesterdayShipments.filter(s => s.shipment_direction === 'inbound');
  const outboundYesterday = yesterdayShipments.filter(s => s.shipment_direction === 'outbound');

  const deliveredToday = all.filter(s =>
    s.status_category === 'Delivered' &&
    (s.last_carrier_update || '').startsWith(today)
  );

  const ofd = all.filter(s => s.status_category === 'Out for Delivery');
  const delayed = all.filter(s => s.status_category === 'Delayed');
  const exceptions = all.filter(s => s.status_category === 'Delivery Exception');
  const failed = all.filter(s => s.status_category === 'Failed Attempt');
  const active = all.filter(s => !['Delivered', 'Returned'].includes(s.status_category || ''));

  // Receipts today
  const { data: receiptsToday } = await supabase
    .from('receipts')
    .select('amount')
    .eq('date_paid', today);

  const { data: receiptsYesterday } = await supabase
    .from('receipts')
    .select('amount')
    .eq('date_paid', yesterday);

  const salesToday = (receiptsToday || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const salesYesterday = (receiptsYesterday || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const salesChange = salesYesterday > 0
    ? ((salesToday - salesYesterday) / salesYesterday * 100).toFixed(1)
    : null;

  // Inventory
  const { data: inventory } = await supabase
    .from('inventory_receiving')
    .select('product_name, quantity');

  const { data: ordersToday } = await supabase
    .from('inventory_orders')
    .select('*, inventory_order_items(*)')
    .eq('order_date', today);

  const newUnitsToday = (ordersToday || []).reduce((sum, order) =>
    sum + (order.inventory_order_items || []).reduce((s: number, i: any) => s + (i.quantity || 0), 0), 0
  );

  // Mailboxes
  const { data: mailboxes } = await supabase
    .from('mailboxes')
    .select('id', { count: 'exact' })
    .eq('active', true);

  const summary = {
    date: today,
    generated_at: new Date().toISOString(),
    sales: {
      today: salesToday.toFixed(2),
      yesterday: salesYesterday.toFixed(2),
      change_percent: salesChange,
      direction: salesChange ? (parseFloat(salesChange) >= 0 ? 'up' : 'down') : 'no data',
    },
    shipments: {
      active_total: active.length,
      new_inbound_today: inboundToday.length,
      new_outbound_today: outboundToday.length,
      new_inbound_yesterday: inboundYesterday.length,
      new_outbound_yesterday: outboundYesterday.length,
      delivered_today: deliveredToday.length,
      out_for_delivery: ofd.length,
      delayed: delayed.length,
      exceptions: exceptions.length,
      failed_attempts: failed.length,
      flags: [
        ...exceptions.map(s => ({ type: 'Exception', tracking: s.tracking_number, carrier: s.carrier })),
        ...delayed.map(s => ({ type: 'Delayed', tracking: s.tracking_number, carrier: s.carrier })),
        ...failed.map(s => ({ type: 'Failed Attempt', tracking: s.tracking_number, carrier: s.carrier })),
      ],
    },
    inventory: {
      new_units_received_today: newUnitsToday,
      new_orders_today: (ordersToday || []).length,
      total_receiving_units: (inventory || []).reduce((s, i) => s + (i.quantity || 0), 0),
    },
    mailboxes: {
      active: mailboxes?.length || 0,
    },
  };

  return NextResponse.json(summary);
}