// Vercel serverless function (Node runtime, zero-config under /api)
// Fetches Media Buying data live from ClickUp and returns normalized JSON.
// Requires env var CLICKUP_TOKEN (a ClickUp personal API token) to be set
// in the Vercel project's Settings -> Environment Variables.

const APPROVED_FIELD = "410e2674-d0c4-469d-b7ba-30871d480a63"; // Approved Spend $
const WEEK_FIELDS = [
  "f6c13e7d-e97c-49e0-9128-e1640571cc9b", // Week 1 Spend $
  "74e5b311-31fa-42e8-b500-029272b42638", // Week 2 Spend $
  "22ecee99-0eaa-4e50-ad97-3b7355861652", // Week 3 Spend $
  "a4b7e7f8-8dfb-4248-b332-0a0ac6959fe8", // Week 4 Spend $
  "2556ee7f-fa0a-4687-9202-2e3e0197c594", // Week 5 Spend $
];
const CLIENT_BRAND_FIELD = "ca705f36-99c5-4c86-82c9-d06782c42313";

// All 29 Media Buying tracker lists (March 2024 - July 2026)
const LISTS = [
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
  { id: "901418420641", year: 2025, month: 3 },
  { id: "901418421022", year: 2025, month: 4 },
  { id: "901418421032", year: 2025, month: 5 },
  { id: "901418420637", year: 2025, month: 6 },
  { id: "901418420642", year: 2025, month: 7 },
  { id: "901418420643", year: 2025, month: 8 },
  { id: "901418420640", year: 2025, month: 9 },
  { id: "901418420635", year: 2025, month: 10 },
  { id: "901418420647", year: 2025, month: 11 },
  { id: "901418421221", year: 2025, month: 12 },
  { id: "901418420589", year: 2026, month: 1 },
  { id: "901418420588", year: 2026, month: 2 },
  { id: "901418420587", year: 2026, month: 3 },
  { id: "901418420584", year: 2026, month: 4 },
  { id: "901418420585", year: 2026, month: 5 },
  { id: "901418420586", year: 2026, month: 6 },
  { id: "901418399046", year: 2026, month: 7 },
];

// Normalize brand name variants that show up across months to one canonical label.
const NAME_ALIASES = {
  "hale shine": "Hala Shine",
  "hala shine": "Hala Shine",
  "trade kings foundation": "Trade Kings Foundation",
  "trade kings  foundation": "Trade Kings Foundation",
};

// Non-brand organizational/breakdown rows that should never appear as a "brand" line item.
const EXCLUDE_NAMES = new Set([
  "instagram",
  "linkedin",
  "w community",
  "assets mobilization",
  "access bank linkedin",
  "access bank w community",
]);

function normalizeName(raw) {
  const trimmed = raw.replace(/[‘’]/g, "'").trim();
  const key = trimmed.toLowerCase();
  return NAME_ALIASES[key] || trimmed;
}

function numField(customFields, id) {
  const f = customFields.find((c) => c.id === id);
  if (!f || f.value === null || f.value === undefined || f.value === "") return null;
  const n = Number(f.value);
  return Number.isFinite(n) ? n : null;
}

async function fetchList(listId, token) {
  const url = `https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&subtasks=true`;
  const resp = await fetch(url, { headers: { Authorization: token } });
  if (!resp.ok) {
    throw new Error(`ClickUp list ${listId} failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.tasks || [];
}

export default async function handler(req, res) {
  const token = process.env.CLICKUP_TOKEN;
  if (!token) {
    res.status(500).json({ error: "CLICKUP_TOKEN is not configured on the server." });
    return;
  }

  try {
    const months = await Promise.all(
      LISTS.map(async ({ id, year, month }) => {
        const tasks = await fetchList(id, token);
        // Dedupe by normalized brand name WITHIN this one month's list. Occasionally the same
        // brand ends up with two tasks in a single tracker (e.g. an accidental copy) — if we
        // summed both we'd double-count that brand's spend for the month. Keep only the most
        // recently updated task for a given name instead of summing duplicates.
        const brandMap = new Map();
        for (const t of tasks) {
          const rawName = t.name || "";
          const key = rawName.trim().toLowerCase();
          if (EXCLUDE_NAMES.has(key)) continue;
          const cf = t.custom_fields || [];
          const approved = numField(cf, APPROVED_FIELD);
          if (approved === null) continue; // no budget tracked on this task, skip
          const weeks = WEEK_FIELDS.map((fid) => numField(cf, fid) || 0);
          const actual = weeks.reduce((a, b) => a + b, 0);
          const name = normalizeName(rawName);
          const assignees = (t.assignees || []).map((a) => a.username).filter(Boolean);
          const updatedAt = Number(t.date_updated) || 0;
          const existing = brandMap.get(name);
          if (!existing || updatedAt >= existing.updatedAt) {
            brandMap.set(name, { updatedAt, entry: { name, approved, weeks, actual, assignees } });
          }
        }
        const brands = [...brandMap.values()].map((v) => v.entry);
        return {
          period: `${year}-${String(month).padStart(2, "0")}`,
          year,
          month,
          brands,
        };
      })
    );

    months.sort((a, b) => (a.year - b.year) || (a.month - b.month));

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).json({ generatedAt: new Date().toISOString(), months });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
