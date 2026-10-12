// Free Cloudflare Worker: on-demand delayed prices (2 min cache) and RNS/news (10 min cache). No keys.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
const LB = 2204.62262;
const PEERS = [["FCX","Freeport-McMoRan"],["ANTO.L","Antofagasta"],["SCCO","Southern Copper"],["FM.TO","First Quantum"],["LUN.TO","Lundin Mining"],["CS.TO","Capstone Copper"],["HBM","Hudbay"],["CAML.L","Central Asia Metals"],["SFR.AX","Sandfire"]];
const FEEDS = ['"Atalaya Mining"','Riotinto copper','"Proyecto Touro"','"Masa Valverde"','"E-LIX"','"copper price"'];
const iso = d => new Date(d).toISOString().replace(/\.\d+Z$/, "Z");
const allowed = o => /^https:\/\/djancom\.github\.io$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

async function get(url, ms = 8000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(r.status + " " + url); return r;
}
async function yahoo(sym) {
  const j = await (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`)).json();
  const res = j.chart.result[0], m = res.meta, q = res.indicators.quote[0].close;
  const pts = res.timestamp.map((t, i) => [t, q[i]]).filter(p => p[1] != null);
  const price = m.regularMarketPrice ?? pts.at(-1)[1], mt = m.regularMarketTime ?? pts.at(-1)[0];
  const day = t => new Date(t * 1000).toISOString().slice(0, 10);
  const prev = day(pts.at(-1)[0]) === day(mt) ? (pts.at(-2) || pts.at(-1))[1] : pts.at(-1)[1];
  const now = Date.now() / 1000, back = d => { const c = pts.filter(p => p[0] <= now - d * 86400); return (c.at(-1) || pts[0])[1]; };
  const ys = Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000, yb = (pts.filter(p => p[0] < ys).at(-1) || pts[0])[1];
  const pct = (a, b) => b ? Math.round((a / b - 1) * 1e4) / 100 : null;
  return { price, currency: m.currency, chg: Math.round((price - prev) * 1e4) / 1e4, chg_pct: pct(price, prev), m1: pct(price, back(30)), ytd: pct(price, yb),
    asof: iso(mt * 1000), ok: true, hist: pts.filter(p => p[0] >= now - 35 * 86400).map(p => [p[0], Math.round(p[1] * 1e4) / 1e4]) };
}
const safe = p => p.catch(e => ({ ok: false, error: String(e).slice(0, 120) }));

async function prices() {
  const syms = ["ATYM.L", "HG=F", "GBPUSD=X", "EURUSD=X", "TTF=F", ...PEERS.map(p => p[0])];
  const r = await Promise.all(syms.map(s => safe(yahoo(s))));
  const Y = Object.fromEntries(syms.map((s, i) => [s, r[i]]));
  const a = Y["ATYM.L"], hg = Y["HG=F"], g = Y["GBPUSD=X"], e = Y["EURUSD=X"], out = { generated: iso(Date.now()) };
  if (a.ok) out.atym = a;
  if (g.ok && e.ok) out.fx = { gbpusd: g.price, gbpusd_chg_pct: g.chg_pct, eurusd: e.price, eurusd_chg_pct: e.chg_pct, asof: g.asof, ok: true };
  if (hg.ok) out.copper = { comex_lb: hg.price, comex_t: Math.round(hg.price * LB * 10) / 10, comex_gbp_t: g.ok ? Math.round(hg.price * LB / g.price * 10) / 10 : null,
    comex_chg_pct: hg.chg_pct, comex_m1: hg.m1, comex_ytd: hg.ytd, asof: hg.asof, hist: hg.hist };
  if (a.ok && hg.ok) { a.rel_m1 = Math.round((a.m1 - hg.m1) * 100) / 100; a.rel_ytd = Math.round((a.ytd - hg.ytd) * 100) / 100; }
  if (Y["TTF=F"].ok) { const t = Y["TTF=F"]; delete t.hist; out.ttf = t; }
  const rows = PEERS.map(([s, n]) => Y[s].ok ? (delete Y[s].hist, { ...Y[s], sym: s, name: n }) : null);
  if (rows.every(Boolean)) out.peers = { rows, asof: out.generated, ok: true };
  else out.peer_rows = rows.filter(Boolean);  // partial: page merges by symbol
  return out;
}

const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").trim();
async function rns() {
  const t = await (await get("https://www.investegate.co.uk/company/ATYM")).text();
  const re = /<td>(\d{1,2}) (\w{3}) (\d{4})<\/td>\s*<td>(\d{1,2}):(\d{2}) ([AP]M)<\/td>[\s\S]*?class="announcement-link" href="([^"]+)">([^<]+)<\/a>/g;
  const M = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const items = []; let m;
  while ((m = re.exec(t)) && items.length < 8) {
    let h = +m[4] % 12 + (m[6] === "PM" ? 12 : 0);
    items.push({ date: `${m[3]}-${M[m[2]]}-${m[1].padStart(2, "0")}`, time: `${String(h).padStart(2, "0")}:${m[5]}`, link: m[7], title: unesc(m[8]) });
  }
  if (!items.length) throw new Error("no RNS rows");
  return { items, asof: iso(Date.now()), ok: true };
}
async function news() {
  const urls = FEEDS.map(q => `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:30d")}&hl=en-GB&gl=GB&ceid=GB:en`).concat("https://www.mining.com/feed/");
  const texts = await Promise.all(urls.map(u => get(u, 6000).then(r => r.text()).catch(() => "")));
  const items = [];
  texts.forEach((x, i) => {
    for (const it of (x.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, 20)) {
      const g = tag => unesc((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [, ""])[1]);
      let title = g("title"), src = g("source"); const mc = urls[i].includes("mining.com");
      if (mc && !/copper/i.test(title)) continue;
      if (src && title.endsWith(" - " + src)) title = title.slice(0, -src.length - 3);
      items.push({ title, link: g("link"), ts: (Date.parse(g("pubDate")) || 0) / 1000, source: src || (mc ? "MINING.COM" : "") });
    }
  });
  const seen = new Set(), out = [];
  for (const i of items.sort((a, b) => b.ts - a.ts)) { const k = i.title.toLowerCase().replace(/\W+/g, "").slice(0, 60); if (!seen.has(k)) { seen.add(k); out.push(i); } }
  if (!out.length) throw new Error("no news");
  return { items: out.slice(0, 15), asof: iso(Date.now()), ok: true };
}
async function slow() {
  const [r, n] = await Promise.all([safe(rns()), safe(news())]);
  const out = { generated: iso(Date.now()) }; if (r.ok) out.rns = r; if (n.ok) out.news = n; return out;
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "", url = new URL(req.url);
    const cors = { "Vary": "Origin", ...(allowed(origin) ? { "Access-Control-Allow-Origin": origin } : {}) };
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (origin && !allowed(origin)) return new Response("forbidden", { status: 403 });
    const route = { "/prices": [prices, 120], "/slow": [slow, 600] }[url.pathname];
    if (!route || req.method !== "GET") return new Response("not found", { status: 404, headers: cors });
    const key = new Request(url.origin + url.pathname), cache = caches.default;
    let res = await cache.match(key);
    if (!res) {
      const body = await Promise.race([route[0](), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000))]).catch(e => null);
      if (!body) return new Response('{"error":"upstream"}', { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
      res = new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${route[1]}` } });
      ctx.waitUntil(cache.put(key, res.clone()));
    }
    res = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
};
