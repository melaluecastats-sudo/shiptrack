import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey !== process.env.SYNC_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { shipments: any[] };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const { shipments } = body;
  if (!Array.isArray(shipments) || shipments.length === 0) {
    return NextResponse.json({ added: 0, updated: 0, errors: 0 });
  }
  let added = 0, updated = 0, errors = 0;
  for (const s of shipments) {
    try {
      const tracking = (s.tracking_number || "").trim().toUpperCase();
      if (!tracking || !s.carrier) { errors++; continue; }
      const record = {
        tracking_number: tracking, carrier: s.carrier,
        shipment_direction: s.shipment_direction || "inbound",
        gmail_label: s.gmail_label || "", sync_source: "gmail_auto",
        customer_name: s.customer_name || "", customer_first_name: s.customer_first_name || "",
        customer_last_name: s.customer_last_name || "", name_source: s.name_source || "",
        name_confidence: s.name_confidence || "none", possible_customer_name: s.possible_customer_name || "",
        vendor_name: s.vendor_name || "", contact: s.contact || "",
        order_number: s.order_number || "", description: s.description || "",
        invoice_total: s.invoice_total || "", current_status: "Unknown", status_category: "Unknown",
        tracking_url: s.tracking_url || "", estimated_delivery_date: s.estimated_delivery_date || null,
        next_refresh_at: new Date().toISOString(), is_stale: false,
        source_email_id: s.source_email_id || "", source_email_link: s.source_email_link || "",
        source_email_subject: s.source_email_subject || "", source_email_sender: s.source_email_sender || "",
        added_at: s.added_at || new Date().toISOString().split("T")[0], updated_at: new Date().toISOString(),
      };
      const { data: existing } = await supabase.from("shipments").select("id").eq("tracking_number", tracking).maybeSingle();
      if (existing) {
        await supabase.from("shipments").update({
          description: record.description, customer_name: record.customer_name,
          vendor_name: record.vendor_name, order_number: record.order_number,
          estimated_delivery_date: record.estimated_delivery_date,
          source_email_id: record.source_email_id, source_email_link: record.source_email_link,
          updated_at: record.updated_at,
        }).eq("tracking_number", tracking);
        updated++;
      } else {
        await supabase.from("shipments").insert(record);
        added++;
      }
    } catch (e: any) { errors++; console.error("Record error:", e.message); }
  }
  await supabase.from("sync_logs").insert({ source: "gmail_auto", shipments_added: added, shipments_updated: updated, errors, synced_at: new Date().toISOString() });
  return NextResponse.json({ added, updated, errors });
}