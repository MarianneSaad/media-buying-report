/ Vercel serverless function (Node runtime, zero-config under /api)
// Two data sources, merged into one JSON payload:
//
// 1. LEGACY_LISTS (Mar 2024 - Feb 2025): fetched live from ClickUp. These 12 months
//    live in the "Media Buying History" ClickUp folder and are never expected to
//    change, so a fixed, small list of IDs here is safe (nowhere near ClickUp's
//    rate limit).
// 2. Mar 2025 onward: fetched from the "meta_report" Google Sheet via an Apps
//    Script Web App (GSHEET_URL / GSHEET_SECRET env vars). New month tabs in the
//    Sheet show up automatically -- no code changes needed here when a new month
//    starts.
//
// Requires env vars:
//   CLICKUP_TOKEN  - a ClickUp personal API token (for the 12 legacy months only)
//   GSHEET_URL     - the Apps Script /exec URL
//   GSHEET_SECRET  - the shared-secret key the Web App checks

const APPROVED_FIELD = "410e2674-d0c4-469d-b7ba-30871d480a63"; // Approved Spend $
const WEEK_FIELDS = [
      "f6c13e7d-e97c-49e0-9128-e1640571cc9b", // Week 1 Spend $
      "74e5b311-31fa-42e8-b500-029272b42638", // Week 2 Spend $
      "22ecee99-0eaa-4e50-ad97-3b7355861652", // Week 3 Spend $
      "a4b7e7f8-8dfb-4248-b332-0a0ac6959fe8", // Week 4 Spend $
      "2556ee7f-fa0a-4687-9202-2e3e0197c594", // Week 5 Spend $
    ];
const CLIENT_BRAND_FIELD = "ca705f36-99c5-4c86-82c9-d06782c42313";

// The 12 months living in ClickUp's "Media Buying History" folder that predate the
// Google Sheet (which only goes back to March 2025).
const LEGACY_LISTS = [
    { id: "901418421678", year: 2024, month: 3 },
    { id: "901418421671", year: 2024, month: 4 },
    { id: "901418421674", year: 2024, month: 5 },
    { id: "901418421673", year: 2024, month: 6 },
    { id: "901418421677", year: 2024, month: 7 },
    { id: "901418421675", year: 2024, month: 8 },
    { id: "901418421676", year: 2024, month: 9 },
    { id: "901418421672", year: 2024, month: 10 },
    { id: "901418421670", year: 2024, month: 11 },
    { id: "901418421669", year: 2024, month: 12 },
    { id: "901418421040", year: 2025, month: 1 },
    { id: "901418420638", year: 2025, month: 2 },
    ];

// Normalize brand name variants that show up across months to one canonical label.
const NAME_ALIASES = {
      "hale shine": "Hala Shine",
      "hala shine": "Hala Shine",
      "trade kings foundation": "Trade Kings Foundation",
      "trade kings  foundation": "Trade Kings Foundation",
};

const EXCLUDE_NAMES = new Set(["assets mobilization"]);

const ASSIGNEE_EXCLUSIONS = {
      "Giraffe Creatives": new Set(["Kataka Mbunji", "Kataka"]),
      "Desired Spaces": new Set(["Kataka Mbunji", "Kataka"]),
};

function normalizeName(raw) { const trimmed = raw.replace(/[‘’]/g, "'").trim(); const key = trimmed.toLowerCase(); return NAME_ALIASES[key] || trimmed; }

function numField(customFields, id) {
      const f = customFields.find((c) => c.id === id);
      if (!f || f.value === null || f.value === undefined || f.value === "") return null;
      const n = Number(f.value);
      return Number.isFinite(n) ? n : null;
}

function clientOf(customFields, fallbackName) {
      const f = customFields.find((c) => c.id === CLIENT_BRAND_FIELD);
      if (!f || f.value === null || f.value === undefined) return fallbackName;
      const options = f.type_config && Array.isArray(f.type_config.options) ? f.type_config.options : null;
      if (!options) return fallbackName;
      const opt = options.find((o) => o.orderindex === f.value) || options[f.value];
      if (!opt || !opt.name) return fallbackName;
      const stripped = opt.name.replace(/\s*\([^)]*\)\s*$/, "").trim();
      return stripped || fallbackName;
}

async function fetchClickUpList(listId, token) {
      const url = `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&subtasks=true`;
      const resp = await fetch(url, { headers: { Authorization: token } });
      if (!resp.ok) {
              throw new Error(`ClickUp list ${listId} failed: ${resp.status} ${await resp.text()}`);
      }
      const data = await resp.json();
      return data.tasks || [];
}

async function fetchLegacyMonths(token) {
      const months = await Promise.all(
              LEGACY_LISTS.map(async ({ id, year, month }) => {
                        const tasks = await fetchClickUpList(id, token);
                        const brandMap = new Map();
                        for (const t of tasks) {
                                    const rawName = t.name || "";
                                    const key = rawName.trim().toLowerCase();
                                    if (EXCLUDE_NAMES.has(key)) continue;
                                    const cf = t.custom_fields || [];
                                    const approved = numField(cf, APPROVED_FIELD);
                                    if (approved === null) continue;
                                    const weeks = WEEK_FIELDS.map((fid) => numField(cf, fid) || 0);
                                    const actual = weeks.reduce((a, b) => a + b, 0);
                                    const name = normalizeName(rawName);
                                    let assignees = (t.assignees || []).map((a) => a.username).filter(Boolean);
                                    const excl = ASSIGNEE_EXCLUSIONS[name];
                                    if (excl) assignees = assignees.filter((a) => !excl.has(a));
                                    const client = clientOf(cf, name);
                                    const updatedAt = Number(t.date_updated) || 0;
                                    const existing = brandMap.get(name);
                                    if (!existing || updatedAt >= existing.updatedAt) {
                                                  brandMap.set(name, { updatedAt, entry: { name, approved, weeks, actual, assignees, client } });
                                    }
                        }
                        const brands = [...brandMap.values()].map((v) => v.entry);
                        return { period: `${year}-${String(month).padStart(2, "0")}`, year, month, brands };
              })
            );

  // Vote on each brand's canonical client across the legacy months only (same fix-up
  // as before -- a single month occasionally has a blank Client/Brand field).
  const clientVotes = new Map();
      for (const m of months) {
              for (const b of m.brands) {
                        if (!b.client || b.client === b.name) continue;
                        if (!clientVotes.has(b.name)) clientVotes.set(b.name, new Map());
                        const votes = clientVotes.get(b.name);
                        votes.set(b.client, (votes.get(b.client) || 0) + 1);
              }
      }
      const canonicalClient = new Map();
      for (const [name, votes] of clientVotes) {
              let best = null, bestCount = 0;
              for (const [client, count] of votes) {
                        if (count > bestCount) { best = client; bestCount = count; }
              }
              canonicalClient.set(name, best);
      }
      for (const m of months) {
              for (const b of m.brands) {
                        const canon = canonicalClient.get(b.name);
                        if (canon) b.client = canon;
              }
      }

  return months;
}

async function fetchSheetMonths(baseUrl, secret) {
      const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}key=${encodeURIComponent(secret)}`;
      const resp = await fetch(url, { redirect: "follow" });
      if (!resp.ok) {
              throw new Error(`Google Sheet report endpoint failed: ${resp.status} ${await resp.text()}`);
      }
      const data = await resp.json();
      if (data.error) {
              throw new Error(`Google Sheet report endpoint returned an error: ${data.error}`);
      }
      return data.months || [];
}

export default async function handler(req, res) {
      const clickupToken = process.env.CLICKUP_TOKEN;
      const gsheetUrl = process.env.GSHEET_URL;
      const gsheetSecret = process.env.GSHEET_SECRET;

  if (!clickupToken) {
          res.status(500).json({ error: "CLICKUP_TOKEN is not configured on the server." });
          return;
  }
      if (!gsheetUrl || !gsheetSecret) {
              res.status(500).json({ error: "GSHEET_URL / GSHEET_SECRET are not configured on the server." });
              return;
      }

  try {
          const [legacyMonths, sheetMonths] = await Promise.all([
                    fetchLegacyMonths(clickupToken),
                    fetchSheetMonths(gsheetUrl, gsheetSecret),
                  ]);

        // Sheet months take priority over legacy ClickUp months whenever both somehow
        // cover the same period (they shouldn't -- legacy stops at Feb 2025, Sheet
        // starts at Mar 2025 -- but de-dupe defensively just in case).
        const byPeriod = new Map();
          for (const m of legacyMonths) byPeriod.set(m.period, m);
          for (const m of sheetMonths) byPeriod.set(m.period, m);

        const months = [...byPeriod.values()].sort((a, b) => (a.year - b.year) || (a.month - b.month));

        res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
          res.status(200).json({ generatedAt: new Date().toISOString(), months });
  } catch (err) {
          res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
