// Vercel serverless function (Node runtime, zero-config under /api)
// Fetches Media Buying data live from a Google Sheet (via an Apps Script Web App
// bound to the "meta_report" sheet) and returns it as-is -- it is already shaped
// as { generatedAt, months: [{ period, year, month, brands: [...] }] }.
//
// Requires env vars GSHEET_URL (the Apps Script /exec URL) and GSHEET_SECRET (the
// shared-secret key the Web App checks) to be set in the Vercel project's
// Settings -> Environment Variables.
//
// This replaced the old ClickUp-based version, which hit ClickUp's API rate limit
// (it fetched 29+ separate ClickUp lists on every cache miss). The Apps Script
// endpoint instead reads every month tab in the Google Sheet directly and requires
// no code changes when a new month tab is added -- no hardcoded list of months.

export default async function handler(req, res) {
    const baseUrl = process.env.GSHEET_URL;
    const secret = process.env.GSHEET_SECRET;
    if (!baseUrl || !secret) {
          res.status(500).json({ error: "GSHEET_URL / GSHEET_SECRET are not configured on the server." });
          return;
    }

  try {
        const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}key=${encodeURIComponent(secret)}`;
        const resp = await fetch(url, { redirect: "follow" });
        if (!resp.ok) {
                throw new Error(`Google Sheet report endpoint failed: ${resp.status} ${await resp.text()}`);
        }
        const data = await resp.json();
        if (data.error) {
                throw new Error(`Google Sheet report endpoint returned an error: ${data.error}`);
        }

      res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
        res.status(200).json(data);
  } catch (err) {
        res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
