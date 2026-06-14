import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

// Load OAuth2 credentials from environment or local file
const KEY_FILE_PATH = path.join(process.cwd(), 'google-credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

// Spreadsheet ID and range to lookup account emails and names
const SPREADSHEET_ID = '1AVP4pDCh3TMakMRsljXfnszJSO2DeYTV2Grs4ta6NEM';
const RANGE = 'Sheet1!D:F'; // Assuming email address in D and account name in E or F

let sheetsClient: any = null;

async function authenticate() {
  if (sheetsClient) return sheetsClient;

  let authClient;
  if (fs.existsSync(KEY_FILE_PATH)) {
    authClient = new google.auth.GoogleAuth({
      keyFile: KEY_FILE_PATH,
      scopes: SCOPES
    });
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    authClient = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: SCOPES
    });
  } else {
    throw new Error("Google credentials not found");
  }

  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

// Cache spreadsheet data in memory for performance
let cachedData: Array<{email: string, accountName: string}> = [];
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getAccountNameByEmail(email: string): Promise<string | null> {
  if (!email) return null;

  const sheets = await authenticate();

  const now = Date.now();
  if (now - lastFetch > CACHE_TTL || cachedData.length === 0) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE
    });
    cachedData = (res.data.values || []).map((row: string[]) => ({
      email: row[0]?.toLowerCase() || '',
      accountName: row[1] || ''
    }));
    lastFetch = now;
  }

  const found = cachedData.find(x => x.email === email.toLowerCase());
  return found ? found.accountName : null;
}
