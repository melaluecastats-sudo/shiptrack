import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key');
  if (apiKey !== process.env.SYNC_API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const items = body.items || {};
  const orders = body.orders || [];

  if (!Object.keys(items).length) {
    return NextResponse.json({ updated: 0, message: 'No items' });
  }

  let updated = 0, errors = 0, ordersAdded = 0;

  // Save individual orders with their items
  for (const order of orders) {
    try {
      // Check if order already exists
      const { data: existing } = await supabase
        .from('inventory_orders')
        .select('id')
        .eq('source_email_id', order.source_email_id)
        .single();

      if (existing) continue;

      // Insert order
      const { data: newOrder, error: orderError } = await supabase
        .from('inventory_orders')
        .insert({
          order_number: order.order_number,
          order_date: order.order_date,
          source_email_id: order.source_email_id,
        })
        .select()
        .single();

      if (orderError || !newOrder) continue;

      // Insert order items
      const orderItems = order.items.map((item: any) => ({
        order_id: newOrder.id,
        product_name: item.name,
        quantity: item.qty,
        cost: Math.round(item.cost * 100) / 100,
      }));

      await supabase.from('inventory_order_items').insert(orderItems);
      ordersAdded++;
    } catch(e) {
      console.error('Error saving order:', e);
    }
  }

  // Update running totals in inventory_receiving
  for (const [productName, data] of Object.entries(items) as any) {
    try {
      const { data: existing } = await supabase
        .from('inventory_receiving')
        .select('*')
        .eq('product_name', productName)
        .single();

      if (existing) {
        await supabase
          .from('inventory_receiving')
          .update({
            quantity: existing.quantity + data.qty,
            total_cost: Math.round(((existing.total_cost || 0) + data.cost) * 100) / 100,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        const { data: product } = await supabase
          .from('products')
          .select('id')
          .eq('name', productName)
          .single();

        await supabase
          .from('inventory_receiving')
          .insert({
            product_name: productName,
            product_id: product?.id || null,
            quantity: data.qty,
            total_cost: Math.round(data.cost * 100) / 100,
            updated_at: new Date().toISOString(),
          });
      }
      updated++;
    } catch(e) {
      console.error('Error updating inventory for', productName, e);
      errors++;
    }
  }

  return NextResponse.json({ updated, ordersAdded, errors, total: Object.keys(items).length });
}