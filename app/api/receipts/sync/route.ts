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
  const receipts = body.receipts || [];

  if (!receipts.length) {
    return NextResponse.json({ added: 0, message: 'No receipts' });
  }

  let added = 0, duplicates = 0, errors = 0;

  for (const receipt of receipts) {
    try {
      const { error } = await supabase
        .from('receipts')
        .insert(receipt)
        .select();

      if (error) {
        if (error.code === '23505') {
          duplicates++;
        } else {
          errors++;
        }
      } else {
        added++;
      }
    } catch (e) {
      errors++;
    }
  }

  return NextResponse.json({ added, duplicates, errors, total: receipts.length });
}