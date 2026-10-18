// Free Cloudflare Worker: on-demand delayed prices (2 min cache) and RNS/news (10 min cache). No keys.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" };
const LB = 2204.62262;
const PEERS = [["FCX","Freeport-McMoRan"],["ANTO.L","Antofagasta"],["SCCO","Southern Copper"],["FM.TO","First Quantum"],["LUN.TO","Lundin Mining"],["CS.TO","Capstone Copper"],["HBM","Hudbay"],["CAML.L","Central Asia Metals"],["SFR.AX","Sandfire"]];
const MKTS = [["^FTMC", "FTSE 250", "LSE"], ["BRWM.L", "Miners (BRWM)", "LSE"], ["COPX", "Cu miners (COPX)", "NYSE"], ["^GSPC", "S&P 500", "NYSE"], ["^STOXX", "Stoxx 600", "XETRA"], ["^N225", "Nikkei 225", "TSE"], ["^HSI", "Hang Seng", "HKEX"],
  ["GC=F", "Gold ($/oz)", "CME"], ["SI=F", "Silver ($/oz)", "CME"], ["BZ=F", "Brent ($/bbl)", "CME"]];
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
  const syms = ["ATYM.L", "HG=F", "GBPUSD=X", "EURUSD=X", "TTF=F", ...PEERS.map(p => p[0]), ...MKTS.filter(m => m[0]).map(m => m[0])];
  const r = await Promise.all(syms.map(s => safe(yahoo(s))));
  const Y = Object.fromEntries(syms.map((s, i) => [s, r[i]]));
  const a = Y["ATYM.L"], hg = Y["HG=F"], g = Y["GBPUSD=X"], e = Y["EURUSD=X"], out = { generated: iso(Date.now()) };
  if (a.ok) out.atym = a;
  if (g.ok && e.ok) out.fx = { gbpusd: g.price, gbpusd_chg_pct: g.chg_pct, eurusd: e.price, eurusd_chg_pct: e.chg_pct, asof: g.asof, ok: true };
  if (hg.ok) out.copper = { comex_lb: hg.price, comex_t: Math.round(hg.price * LB * 10) / 10, comex_gbp_t: g.ok ? Math.round(hg.price * LB / g.price * 10) / 10 : null,
    comex_chg_pct: hg.chg_pct, comex_m1: hg.m1, comex_ytd: hg.ytd, asof: hg.asof, hist: hg.hist };
  if (a.ok && hg.ok) { a.rel_m1 = Math.round((a.m1 - hg.m1) * 100) / 100; a.rel_ytd = Math.round((a.ytd - hg.ytd) * 100) / 100; }
  out.markets = { rows: MKTS.map(([s, n, ex]) => s && Y[s].ok ? { sym: s, name: n, ex, price: Y[s].price, chg_pct: Y[s].chg_pct, asof: Y[s].asof } : { sym: s, name: n, ex, unavailable: true }), asof: out.generated, ok: true };
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

const RANGES = { "1d": ["1d", "5m", 120], "1mo": ["1mo", "1d", 3600], "3mo": ["3mo", "1d", 3600], "6mo": ["6mo", "1d", 3600], "1y": ["1y", "1d", 3600], "5y": ["5y", "1wk", 3600] };
const SYMS = ["ATYM.L", "HG=F"];
async function lme(r, col = 0) {
  const yrs = { "1mo": 1, "3mo": 1, "6mo": 1, "1y": 2, "5y": 6 }[r], Y = new Date().getUTCFullYear(), M = {};
  "January February March April May June July August September October November December".split(" ").forEach((m, i) => M[m] = i);
  const pages = await Promise.all([...Array(yrs).keys()].map(k => get(`https://www.westmetall.com/en/markdaten.php?action=table&field=LME_Cu_cash${k ? "&year=" + (Y - k) : ""}`).then(x => x.text()).catch(() => "")));
  const pts = [];
  for (const t of pages) for (const m of t.matchAll(/<td[^>]*>(\d{2})\. (\w+) (\d{4})<\/td>\s*<td[^>]*>([\d,.]+)<\/td>\s*<td[^>]*>([\d,.]+)<\/td>\s*<td[^>]*>([\d,.]+)<\/td>/g))
    pts.push([Date.UTC(+m[3], M[m[2]], +m[1], 12) / 1000, +m[4 + col].replace(/,/g, "")]);
  const days = { "1mo": 31, "3mo": 92, "6mo": 183, "1y": 366, "5y": 1827 }[r], cut = Date.now() / 1000 - days * 86400;
  const out = [...new Map(pts.filter(p => p[0] >= cut).map(p => [p[0], p])).values()].sort((a, b) => a[0] - b[0]);
  if (!out.length) throw new Error("no LME rows");
  return { range: r, pts: out, first: out[0][0], asof: iso(out.at(-1)[0] * 1000), ok: true };
}
async function chart(r, sym = "ATYM.L") {
  const [range, iv] = RANGES[r];
  const j = await (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${iv}`)).json();
  const res = j.chart.result[0], q = res.indicators.quote[0].close, vo = res.indicators.quote[0].volume || [];
  const pts = (res.timestamp || []).map((t, i) => [t, q[i], vo[i] || 0]).filter(p => p[1] != null).map(p => [p[0], Math.round(p[1] * 100) / 100, p[2]]);
  if (!pts.length) throw new Error("no points");
  return { range: r, interval: iv, pts, asof: iso((res.meta.regularMarketTime || pts.at(-1)[0]) * 1000), ok: true };
}

// ---- daily items, refreshed by Cron Trigger into KV ----
async function unzipEntry(buf, name) {
  const u = new Uint8Array(buf), dv = new DataView(buf);
  let e = u.length - 22; while (e > 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  let p = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true), td = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const meth = dv.getUint16(p + 10, true), csz = dv.getUint32(p + 20, true), fl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const fn = td.decode(u.subarray(p + 46, p + 46 + fl));
    if (fn === name) {
      const ds = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), data = u.subarray(ds, ds + csz);
      if (meth === 0) return td.decode(data);
      return await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    }
    p += 46 + fl + xl + cl;
  }
  throw new Error("zip entry missing " + name);
}
async function dGas() {
  const t = (await (await get("https://www.mibgas.es/en")).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = t.match(/Price Day Ahead ES - (\d{2})\/(\d{2}) ([\d.,]+) €\/MWh (-?[\d.,]+) €\/MWh/);
  if (!m) throw new Error("MIBGAS price not found");
  const num = s => +s.replace(/\./g, "").replace(",", "."), now = new Date(), y = now.getUTCFullYear() - (+m[2] === 1 && now.getUTCMonth() === 11 ? -1 : 0);
  const price = num(m[3]), ch = num(m[4]);
  return { price, prev: Math.round((price - ch) * 100) / 100, delivery: `${y}-${m[2]}-${m[1]}`, asof: iso(Date.now()), source: "mibgas.es last price", ok: true };
}
async function dPower() {
  const d = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const j = await (await get(`https://apidatos.ree.es/en/datos/mercados/precios-mercados-tiempo-real?start_date=${d(-1)}T00:00&end_date=${d(1)}T23:59&time_trunc=hour`)).json();
  const spot = j.included.find(i => i.id === "600" || /spot/i.test(i.attributes.title)), days = {};
  for (const v of spot.attributes.values) (days[v.datetime.slice(0, 10)] ||= []).push(v.value);
  const k = Object.keys(days).sort(), last = k.at(-1), prev = k.at(-2), avg = x => Math.round(days[x].reduce((a, b) => a + b, 0) / days[x].length * 100) / 100;
  return { day: last, avg: avg(last), min: Math.min(...days[last]), max: Math.max(...days[last]), prev_avg: prev ? avg(prev) : null, asof: iso(Date.now()), ok: true };
}
async function dLme() {
  const t = await (await get("https://www.westmetall.com/en/markdaten.php?action=table&field=LME_Cu_cash")).text();
  const M = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
  const rows = [...t.matchAll(/<td[^>]*>(\d{2})\. (\w+) (\d{4})<\/td>\s*<td[^>]*>([\d,.]+)<\/td>\s*<td[^>]*>([\d,.]+)<\/td>\s*<td[^>]*>([\d,.]+)<\/td>/g)];
  if (!rows.length) throw new Error("no LME rows");
  const n = s => +s.replace(/,/g, ""), r = rows[0], date = `${r[3]}-${String(M[r[2]]).padStart(2, "0")}-${r[1]}`;
  return { lme_cash: n(r[4]), lme_3m: n(r[5]), lme_stock: n(r[6]), lme_date: date, lme_prev: rows[1] ? n(rows[1][4]) : null, asof: date + "T17:00:00Z", ok: true };
}
async function dComex() {  // MetalCharts public page (server-rendered text); CME's own file blocks bots
  const t = (await (await get("https://metalcharts.org/comex/copper")).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = t.match(/As of (\w+ \d{1,2}, \d{4}) , COMEX copper warehouses hold ([\d,]+) short tons/);
  if (!m) throw new Error("COMEX text not found");
  const st = +m[2].replace(/,/g, ""), date = new Date(m[1] + " 12:00 UTC").toISOString().slice(0, 10);
  return { t: Math.round(st * 0.90718474), st, date, asof: date + "T22:00:00Z", source: "MetalCharts (CME data)", ok: true };
}
async function dShfe() {  // SHFE weekly warehouse report (Fridays), copper section total
  for (let k = 0; k < 21; k++) {
    const d = new Date(Date.now() - k * 864e5); if (d.getUTCDay() !== 5 && d.getUTCDay() !== 4 && d.getUTCDay() !== 3) continue;
    const ds = d.toISOString().slice(0, 10), r = await fetch(`https://www.shfe.com.cn/data/tradedata/future/stockdata/weeklystock_${ds.replace(/-/g, "")}/ZH/all.html`, { headers: UA, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || !r.ok) continue;
    const t = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), i = t.indexOf(" 铜 单位"); if (i < 0) continue;
    const m = t.slice(i).match(/ 总计 ([\d,]+) [\d,]+ ([\d,]+) /); if (!m) continue;
    return { t: +m[2].replace(/,/g, ""), date: ds, asof: ds + "T08:00:00Z", source: "SHFE weekly", ok: true };
  }
  throw new Error("no SHFE report");
}
async function comexHist() {  // meiyuanhuanliu.com embeds ~1y of CME copper stocks (short tons) as chartData
  const t = await (await get("https://www.meiyuanhuanliu.com/copper_stocks/", 12000)).text();
  const d = JSON.parse(t.match(/const chartData = (\{[\s\S]*?\});/)[1]);
  return d.labels.map((l, i) => [Date.parse(l + "T12:00:00Z") / 1000, Math.round(d.total[i] * 0.90718474)]).filter(p => p[1] > 0);
}
async function stocks(env) {
  const o = { asof: iso(Date.now()), ok: true };
  await Promise.all([
    lme("1y", 2).then(x => o.lme = x.pts).catch(() => o.lme = []),
    comexHist().then(x => o.comex = x).catch(() => o.comex = []),
    env.DAILY.get("shfehist").then(v => o.shfe = JSON.parse(v || "[]").map(([d, t]) => [Date.parse(d + "T12:00:00Z") / 1000, t])).catch(() => o.shfe = [])]);
  const cut = Date.now() / 1000 - 366 * 86400; for (const k of ["comex", "shfe"]) o[k] = o[k].filter(p => p[0] >= cut);
  if (!o.lme.length && !o.comex.length && !o.shfe.length) throw new Error("no stocks");
  return o;
}
async function chile() {  // Cochilco monthly Chilean copper mine production, kt fine copper (TOTAL CHILE column)
  const buf = await (await get("https://www.cochilco.cl/web/download/951/cobre/12683/produccion-de-cobre-mina-por-empresa-mensual.xlsx", 20000)).arrayBuffer();
  const ss = [...(await unzipEntry(buf, "xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
  const ti = ss.findIndex(x => /^TOTAL CHILE$/i.test(x)); if (ti < 0) throw new Error("no TOTAL CHILE");
  const sh = await unzipEntry(buf, "xl/worksheets/sheet1.xml");
  const hc = sh.match(new RegExp(`<c r="([A-Z]+)\\d+"[^>]*t="s"[^>]*><v>${ti}</v>`)); if (!hc) throw new Error("no total col");
  const col = hc[1], pts = [];
  for (const [, row] of sh.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
    const a = row.match(/<c r="A\d+"[^>]*><v>(\d+)<\/v>/), v = row.match(new RegExp(`<c r="${col}\\d+"[^>]*>(?:<f[^>]*(?:/>|>[^<]*</f>))?<v>([\\d.]+)</v>`));
    if (a && v && +a[1] > 40000 && +v[1] > 0) pts.push([new Date(Date.UTC(1899, 11, 30) + +a[1] * 864e5).toISOString().slice(0, 7), Math.round(+v[1] * 10) / 10]);
  }
  if (pts.length < 13) throw new Error("few rows");
  const L = pts.at(-1), [y, m] = L[0].split("-"), py = pts.find(p => p[0] === `${+y - 1}-${m}`);
  return { pts: pts.slice(-36), latest: L[0], kt: L[1], yoy: py ? Math.round((L[1] / py[1] - 1) * 1000) / 10 : null, source: "Cochilco", asof: iso(Date.now()), ok: true };
}
async function dDiesel() {
  const pg = await (await get("https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en")).text();
  const href = pg.match(/href="(\/document\/download\/[^"]+prices%20with%20Taxes[^"]*)"/)[1].replace(/&amp;/g, "&");
  const buf = await (await get("https://energy.ec.europa.eu" + href, 15000)).arrayBuffer();
  const ss = [...(await unzipEntry(buf, "xl/sharedStrings.xml")).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => m[1].replace(/<[^>]+>/g, ""));
  const sh = await unzipEntry(buf, "xl/worksheets/sheet1.xml"), cell = (row, col) => {
    const m = row.match(new RegExp(`<c r="${col}\\d+"([^>]*)>(?:<f>[^<]*</f>)?<v>([^<]*)</v>`)); if (!m) return null;
    return /t="s"/.test(m[1]) ? ss[+m[2]] : +m[2]; };
  const rows = [...sh.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map(m => m[1]);
  const serial = cell(rows[1], "A"), es = rows.find(r => String(cell(r, "A")).trim() === "Spain");
  if (!es || !serial) throw new Error("Spain row/date not found");
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 864e5).toISOString().slice(0, 10);
  return { price: Math.round(cell(es, "C") * 10) / 10, date, asof: date + "T12:00:00Z", ok: true };
}
async function dVal() {
  const r0 = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual", signal: AbortSignal.timeout(8000) });
  const ck = (r0.headers.getSetCookie ? r0.headers.getSetCookie() : [r0.headers.get("set-cookie") || ""]).map(c => c.split(";")[0]).filter(Boolean).join("; ");
  const H = { ...UA, Cookie: ck };
  const crumb = await (await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: H, signal: AbortSignal.timeout(8000) })).text();
  if (!crumb || crumb.length > 20 || /[<{ ]/.test(crumb)) throw new Error("no crumb");
  // Yahoo mixes quote currency (e.g. GBp) and reporting currency (USD/EUR) in its ratios, so recompute everything in USD.
  const fxr = { USD: 1 };
  await Promise.all(["GBP", "EUR", "CAD", "AUD"].map(async c => { try { fxr[c] = (await yahoo(c + "USD=X")).price; } catch (e) { } }));
  if (fxr.GBP) fxr.GBp = fxr.GBP / 100;
  const syms = ["ATYM.L", ...PEERS.map(p => p[0])], out = {};
  await Promise.all(syms.map(async s => {
    try {
      const j = await (await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(s)}?modules=summaryDetail,defaultKeyStatistics,financialData,price&crumb=${encodeURIComponent(crumb)}`, { headers: H, signal: AbortSignal.timeout(8000) })).json();
      const r = j.quoteSummary.result[0], sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {}, pr = r.price || {};
      const v = x => x && typeof x.raw === "number" ? x.raw : null;
      const qc = pr.currency, fc = fd.financialCurrency || qc, q = fxr[qc], fr = fxr[fc];
      if (!q || !fr) throw new Error("fx " + qc + "/" + fc);
      const px = v(pr.regularMarketPrice), pxU = px * q, sh = v(ks.sharesOutstanding);
      const eps = v(ks.trailingEps), feps = v(ks.forwardEps);
      let pe = null, pe_type = null;
      if (eps > 0) { pe = pxU / (eps * fr); pe_type = "T"; } else if (feps > 0) { pe = pxU / (feps * fr); pe_type = "F"; }
      const debt = v(fd.totalDebt), cash = v(fd.totalCash), ebitda = v(fd.ebitda);
      const ev = sh && debt != null && cash != null ? sh * pxU + (debt - cash) * fr : null;
      const ev_ebitda = ev != null && ebitda > 0 ? ev / (ebitda * fr) : null;
      const tdr = v(sd.trailingAnnualDividendRate);  // reported in the financial currency
      const dy = tdr != null ? tdr * fr / pxU * 100 : null;
      const rd = (x, n) => x == null || !isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n;
      out[s] = { pe: rd(pe, 2), pe_type, ev_ebitda: rd(ev_ebitda, 2), div_yield: rd(dy, 2), qc, fc };
    } catch (e) { }
  }));
  if (!Object.keys(out).length) throw new Error("quoteSummary blocked");
  return { rows: out, v: 2, asof: iso(Date.now()), ok: true };
}
async function refreshDaily(env) {
  const old = JSON.parse((await env.DAILY.get("daily")) || "{}"), out = { generated: iso(Date.now()), errors: {} };
  const jobs = { gas: dGas, power: dPower, lme: dLme, comex: dComex, shfe: dShfe, diesel: dDiesel, news };
  const fresh = old.val && old.val.ok !== false && Date.now() - Date.parse(old.val.asof) < 20 * 3600e3 && old.val.v === 2;
  if (fresh) out.val = old.val; else jobs.val = dVal;  // valuations once per day
  await Promise.all(Object.entries(jobs).map(async ([k, fn]) => {
    try { out[k] = await fn(); } catch (e) { out.errors[k] = String(e).slice(0, 150); if (old[k]) out[k] = { ...old[k], ok: false }; }
  }));
  await env.DAILY.put("daily", JSON.stringify(out));
  if (out.shfe && out.shfe.ok) {  // log SHFE weekly figure into its history
    const h = JSON.parse((await env.DAILY.get("shfehist")) || "[]");
    if (!h.some(x => x[0] === out.shfe.date)) { h.push([out.shfe.date, out.shfe.t]); h.sort(); await env.DAILY.put("shfehist", JSON.stringify(h.slice(-120))); }
  }
  return out;
}

export default {
  async scheduled(ev, env, ctx) { ctx.waitUntil(refreshDaily(env)); },
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "", url = new URL(req.url);
    const cors = { "Vary": "Origin", ...(allowed(origin) ? { "Access-Control-Allow-Origin": origin } : {}) };
    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (origin && !allowed(origin)) return new Response("forbidden", { status: 403 });
    if (url.pathname === "/daily" && req.method === "GET") {
      let v = await env.DAILY.get("daily");
      if (!v) v = JSON.stringify(await refreshDaily(env));
      return new Response(v, { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    let route = { "/prices": [prices, 120], "/slow": [slow, 600] }[url.pathname];
    let ck = url.pathname;
    if (url.pathname === "/chart") { const r = url.searchParams.get("range") || "1mo", s = url.searchParams.get("symbol") || "ATYM.L"; if (RANGES[r] && SYMS.includes(s)) { route = [() => chart(r, s), RANGES[r][2]]; ck += "?v=2&range=" + r + "&symbol=" + s; } }
    if (url.pathname === "/lme") { const r = url.searchParams.get("range") || "1mo"; if (RANGES[r] && r !== "1d") { route = [() => lme(r), 3600]; ck += "?range=" + r; } }
    if (url.pathname === "/inv") { route = [async () => { const o = { asof: iso(Date.now()) }; await Promise.all([["comex", dComex], ["shfe", dShfe]].map(async ([k, fn]) => { try { o[k] = await fn(); } catch (e) { } })); if (!o.comex && !o.shfe) throw new Error("no inv"); return o; }, 21600]; }
    if (url.pathname === "/stocks") { route = [() => stocks(env), 21600]; ck += "?v=1"; }
    if (url.pathname === "/chile") { route = [chile, 86400]; }
    if (url.pathname === "/lmestock") { route = [() => lme("1y", 2), 21600]; }
    if (!route || req.method !== "GET") return new Response("not found", { status: 404, headers: cors });
    const key = new Request(url.origin + ck), cache = caches.default;
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
