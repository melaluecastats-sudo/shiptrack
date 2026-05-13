import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export async function GET() {
  const { data: logs, error } = await supabase.from("sync_logs").select("*").order("synced_at",{ascending:false}).limit(10);
  const { count: totalShipments } = await supabase.from("shipments").select("*",{count:"exact",head:true});
  const { count: gmailShipments } = await supabase.from("shipments").select("*",{count:"exact",head:true}).eq("sync_source","gmail_auto");
  if (error) return NextResponse.json({ error: error.message },{ status:500 });
  return NextResponse.json({ logs, totalShipments, gmailShipments, lastSync: logs?.[0]||null });
}