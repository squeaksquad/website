// Builds artwork.json — a { itunesId: "600x600 artwork URL" } map — by reading
// the published credits sheet and looking each album up in the iTunes API.
//
// Run locally (`node build-artwork.mjs`) or from CI. iTunes blocks Cloudflare
// Worker egress IPs with 403, so artwork must be resolved here (a normal egress
// IP) and served as a static file instead of proxied at request time.

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vREEfOlYzrjyA9nDfdGhEM_e6XK5qkVGHkWJHLxH7r-X7XegFweDWnPXlG9T3QovRAtFr4S5wKhEvf3/pub?gid=0&single=true&output=csv';

// Same extraction the frontend uses, kept in sync intentionally.
function itunesIdFromLink(link) {
  if (!link) return null;
  const patterns = [
    /(?:album|song)\.link\/i\/(\d+)/,
    /music\.apple\.com\/.+\/(\d+)(?:\?|$)/,
    /itunes\.apple\.com\/.+\/id(\d+)/,
  ];
  for (const re of patterns) {
    const m = link.match(re);
    if (m) return m[1];
  }
  return null;
}

// Minimal CSV field splitter (handles quoted commas) — we only need the Link column.
function splitCsvLine(line) {
  const vals = [];
  let cur = '', inQ = false;
  for (const ch of line.replace(/\r/g, '')) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { vals.push(cur); cur = ''; }
    else cur += ch;
  }
  vals.push(cur);
  return vals.map(v => v.replace(/^"|"$/g, '').trim());
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const res = await fetch(SHEET_URL);
if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
const csv = await res.text();

const lines = csv.trim().split('\n');
const headers = splitCsvLine(lines[0]).map(h => h.toLowerCase());
const linkCol = headers.indexOf('link');
if (linkCol === -1) throw new Error('No "Link" column found in sheet');

const ids = [...new Set(
  lines.slice(1)
    .map(l => itunesIdFromLink(splitCsvLine(l)[linkCol]))
    .filter(Boolean)
)];
console.log(`Found ${ids.length} unique iTunes IDs`);

const map = {};
for (const ids150 of chunk(ids, 150)) {
  const url = `https://itunes.apple.com/lookup?id=${ids150.join(',')}&country=us`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) { console.warn(`lookup batch HTTP ${r.status} — skipping`); continue; }
  const data = await r.json();
  for (const item of data.results || []) {
    const id = item.collectionId ?? item.trackId ?? item.artistId;
    const art = item.artworkUrl100;
    if (id != null && art) map[String(id)] = art.replace('100x100bb', '600x600bb');
  }
}

const found = Object.keys(map).length;
console.log(`Resolved artwork for ${found}/${ids.length} IDs`);

// Safety: if every lookup failed (e.g. the runner's IP is blocked with 403),
// don't overwrite a good artwork.json with an empty one.
if (found === 0 && ids.length > 0) {
  throw new Error('Resolved 0 artwork URLs — refusing to overwrite artwork.json');
}

await import('node:fs/promises').then(fs =>
  fs.writeFile('artwork.json', JSON.stringify(map, null, 2) + '\n')
);
console.log('Wrote artwork.json');
