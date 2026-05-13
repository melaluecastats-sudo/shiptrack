import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
const AFTERSHIP_BASE = 'https://api.aftership.com/tracking/2024-10';
const SLUG_MAP: Record<string,string> = {'UPS':'ups','USPS':'usps','FedEx':'fedex','DHL':'dhl'};
const REFRESH_INTERVALS: Record<string, number> = {
  'Label Created':7200000,'In Transit':3600000,'Out for Delivery':600000,
  'Delayed':1800000,'Delivery Exception':1800000,'Failed Attempt':1800000,
  'Delivered':Infinity,'Returned':Infinity,'Unknown':3600000,
};

function normalizeTag(tag: string): string {
  const map: Record<string,string> = {
    'Pending':'Label Created','InfoReceived':'Label Created','InTransit':'In Transit',
    'OutForDelivery':'Out for Delivery','AttemptFail':'Failed Attempt','Delivered':'Delivered',
    'AvailableForPickup':'Out for Delivery','Exception':'Delivery Exception','Expired':'Returned',
  };
  return map[tag] || 'Unknown';
}

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key');
  if (apiKey !== process.env.SYNC_API_KEY) return NextResponse.json({ error:'Unauthorized' },{ status:401 });

  const body = await req.json().catch(()=>({}));
  const singleTracking = body.tracking_number;
  const key = process.env.AFTERSHIP_API_KEY;
  if (!key) return NextResponse.json({ error:'No AfterShip key' },{ status:500 });
  const headers = { 'as-api-key': key, 'Content-Type': 'application/json' };

  let shipments: any[] = [];
  if (singleTracking) {
    const { data } = await supabase.from('shipments').select('*').eq('tracking_number', singleTracking.toUpperCase());
    shipments = data || [];
  } else {
    const { data } = await supabase.from('shipments').select('*')
      .lte('next_refresh_at', new Date().toISOString())
      .order('next_refresh_at', { ascending: true })
      .limit(20);
    shipments = (data || []).filter((s: any) => s.status_category !== 'Delivered' && s.status_category !== 'Returned');
  }

  if (!shipments.length) return NextResponse.json({ refreshed:0, message:'Nothing due' });

  let refreshed=0, failed=0;
  const errors: string[] = [];

  for (const shipment of shipments) {
    try {
      const slug = SLUG_MAP[shipment.carrier] || 'usps';
      const tn = shipment.tracking_number;
      let aftershipId = shipment.aftership_id;
      let tracking: any = null;

      // If we have an AfterShip ID, fetch directly by ID
      if (aftershipId) {
        const res = await fetch(`${AFTERSHIP_BASE}/trackings/${aftershipId}`, { headers });
        if (res.ok) {
          const data = await res.json();
          tracking = data?.data?.tracking || data?.data;
        }
      }

      // If no ID or fetch failed, create the tracking
      if (!tracking) {
        const createRes = await fetch(`${AFTERSHIP_BASE}/trackings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ tracking_number: tn, slug })
        });
        const createData = await createRes.json();

        // Get the ID whether it's a new creation or already exists
        aftershipId = createData?.data?.id || createData?.data?.tracking?.id;

        if (aftershipId) {
          // Wait 3 seconds for AfterShip to sync with carrier
          await new Promise(r => setTimeout(r, 3000));
          const fetchRes = await fetch(`${AFTERSHIP_BASE}/trackings/${aftershipId}`, { headers });
          if (fetchRes.ok) {
            const fetchData = await fetchRes.json();
            tracking = fetchData?.data?.tracking || fetchData?.data;
          }
        }
      }

      if (!tracking) {
        errors.push(`${tn}: could not get tracking data`);
        failed++;
        await supabase.from('shipments').update({
          last_checked_at: new Date().toISOString(),
          next_refresh_at: new Date(Date.now() + 3600000).toISOString()
        }).eq('id', shipment.id);
        continue;
      }

      const checkpoints = tracking.checkpoints || [];
      const events = checkpoints.map((cp: any) => ({
        time: cp.checkpoint_time,
        location: [cp.city, cp.state, cp.country_region_name].filter(Boolean).join(', '),
        status: cp.message,
        tag: cp.tag,
      }));

      const statusCategory = normalizeTag(tracking.tag || 'Pending');
      const lastCarrierUpdate = events.length > 0 ? events[events.length - 1]?.time : null;
      const now = new Date();
      const intervalMs = REFRESH_INTERVALS[statusCategory] ?? 3600000;
      const nextRefresh = isFinite(intervalMs) ? new Date(now.getTime() + intervalMs).toISOString() : null;
      const lastUpdateMs = lastCarrierUpdate ? now.getTime() - new Date(lastCarrierUpdate).getTime() : null;
      const isStale = !['Delivered','Returned'].includes(statusCategory) && lastUpdateMs !== null && lastUpdateMs > 259200000;

      const payload: any = {
        current_status: statusCategory,
        status_category: statusCategory,
        tracking_events: events,
        last_carrier_update: lastCarrierUpdate,
        last_checked_at: now.toISOString(),
        next_refresh_at: nextRefresh,
        is_stale: isStale,
        exception_reason: tracking.tag === 'Exception' ? tracking.subtag_message : null,
        updated_at: now.toISOString(),
        aftership_id: aftershipId || null,
      };

      const estDelivery = tracking.latest_estimated_delivery?.datetime || tracking.first_estimated_delivery?.datetime;
      if (estDelivery && !shipment.estimated_delivery_date) {
        payload.estimated_delivery_date = estDelivery.split('T')[0];
      }
      if (statusCategory === 'Delivered' && lastCarrierUpdate) {
        payload.delivered_at = lastCarrierUpdate;
      }

      await supabase.from('shipments').update(payload).eq('id', shipment.id);
      refreshed++;
    } catch(e: any) {
      errors.push(`${shipment.tracking_number}: ${e.message}`);
      failed++;
      await supabase.from('shipments').update({
        last_checked_at: new Date().toISOString(),
        next_refresh_at: new Date(Date.now() + 1800000).toISOString()
      }).eq('id', shipment.id);
    }
  }

  return NextResponse.json({ refreshed, failed, total: shipments.length, errors });
}