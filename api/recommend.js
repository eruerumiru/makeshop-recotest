// api/recommend.js
// CSV（data/20251224113121.csv）から在庫>0を読んでおすすめ返す

const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");

const SHOP_BASE = "https://www.alpaca-pc.com";

// 画像URLキャッシュ（6時間）
let _imgCache = new Map(); // key:url -> { at:number, imageUrl:string }

function normalizeItemId(code) {
  const c = String(code || "").trim();
  if (!c) return "";
  if (/^\d+$/.test(c)) return c.padStart(12, "0"); // 12桁ゼロ埋め
  return c;
}

function buildItemUrl(systemCode, sku) {
  const id = normalizeItemId(systemCode || sku);
  return id ? `${SHOP_BASE}/view/item/${id}` : "";
}

async function fetchOgImage(productUrl) {
  if (!productUrl) return "";
  const hit = _imgCache.get(productUrl);
  const now = Date.now();
  if (hit && now - hit.at < 6 * 60 * 60 * 1000) return hit.imageUrl;

  try {
    const res = await fetch(productUrl, { method: "GET" });
    const html = await res.text();

    const m =
      html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
      html.match(/name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);

    const imageUrl = m ? m[1] : "";
    _imgCache.set(productUrl, { at: now, imageUrl });
    return imageUrl;
  } catch {
    _imgCache.set(productUrl, { at: now, imageUrl: "" });
    return "";
  }
}


// 60秒キャッシュ
let _cache = { at: 0, rows: null };

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function decodeCsvSmart(buf) {
  const utf8 = buf.toString("utf8");
  if (utf8.includes("商品名") && utf8.includes("販売価格")) return utf8;
  return iconv.decode(buf, "cp932");
}

function readProductsFromMakeshopCsv() {
  const now = Date.now();
  if (_cache.rows && now - _cache.at < 60 * 1000) return _cache.rows;

  const csvPath = path.join(process.cwd(), "data", "20251224113121.csv");
  const buf = fs.readFileSync(csvPath);
  const raw = decodeCsvSmart(buf);

  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (cols, k) => (idx[k] == null ? "" : (cols[idx[k]] ?? "").trim());

  const rows = lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);

    const systemCode = get(cols, "システム商品コード");
    const originalCode = get(cols, "独自商品コード");
    const name = get(cols, "商品名");
    const opt = get(cols, "オプショングループ");
    const price = Number(get(cols, "販売価格") || 0);
    const quantity = Number(get(cols, "数量") || 0);

    return {
      sku: originalCode || systemCode,
      systemCode,
      name,
      description: `${name}\n${opt}`.trim(),
      price,
      quantity,
const url = buildItemUrl(systemCode, originalCode || systemCode);

return {
  sku: originalCode || systemCode,
  systemCode,
  name,
  description: `${name}\n${opt}`.trim(),
  price,
  quantity,
  url,
};

    };
  });

  _cache = { at: now, rows };
  return rows;
}

function parseSpec(text = "") {
  const t = String(text).replace(/\s+/g, " ");

  const memMatch =
    t.match(/(メモリ|RAM|Memory)[^0-9]{0,10}(\d{1,3})\s*GB/i) ||
    t.match(/(\d{1,3})\s*GB[^a-zA-Zぁ-んァ-ン一-龥]{0,10}(メモリ|RAM|Memory)/i);
  const memGB = memMatch ? Number(memMatch[2] || memMatch[1]) : null;

  const ssdMatch =
    t.match(/SSD[^0-9]{0,10}(\d{2,4})\s*(GB|TB)/i) ||
    t.match(/(\d{2,4})\s*(GB|TB)[^a-zA-Zぁ-んァ-ン一-龥]{0,10}SSD/i);
  let ssdGB = null;
  if (ssdMatch) {
    const n = Number(ssdMatch[1]);
    const unit = String(ssdMatch[2] || "").toUpperCase();
    ssdGB = unit === "TB" ? n * 1024 : n;
  }

  const hasGPU = /(RTX|GTX|Radeon|Arc|GeForce)/i.test(t);

  const cpu =
    (t.match(/i[3579]-\d{4,5}[A-Z]{0,2}/i) || [null])[0] ||
    (t.match(/Ryzen\s*[3579]\s*\d{4,5}[A-Z]{0,2}/i) || [null])[0] ||
    null;

  return { memGB, ssdGB, hasGPU, cpu };
}

function scoreByUse(useCase, price, spec) {
  let s = 0;
  s += Math.max(0, 100000 - price) / 10000;

  if (useCase === "office") {
    if ((spec.memGB ?? 0) >= 8) s += 5;
    if ((spec.ssdGB ?? 0) >= 256) s += 3;
  } else if (useCase === "creator") {
    if ((spec.memGB ?? 0) >= 16) s += 7;
    if ((spec.ssdGB ?? 0) >= 512) s += 4;
    if (spec.hasGPU) s += 2;
  } else if (useCase === "game") {
    if (spec.hasGPU) s += 10;
    if ((spec.memGB ?? 0) >= 16) s += 4;
  }

  if (spec.cpu) s += 1;
  return s;
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "POST only" });
  }

  try {
    const body = await readJson(req);
    const useCase = body.useCase || "office";
    const budgetNum = Number(body.budget ?? 60000);

const top = readProductsFromMakeshopCsv()
  .filter((p) => p.quantity > 0)
  .filter((p) => p.price <= budgetNum)
  .map((p) => {
    const spec = parseSpec(`${p.name}\n${p.description}`);
    const score = scoreByUse(useCase, p.price, spec);
    return { ...p, spec, score };
  })
  .sort((a, b) => b.score - a.score)
  .slice(0, 3)
  .map((p) => ({
    sku: p.sku,
    name: p.name,
    price: p.price,
    url: p.url,
    reason:
      useCase === "office"
        ? "事務・普段使い向けに、予算内でバランス重視で選定"
        : useCase === "creator"
        ? "編集・制作向けに、メモリ/SSD重視で選定"
        : "ゲーム向けにGPU記載を優先して選定",
  }));

// 画像URL（og:image）を付与（上位3件だけ）
const products = await Promise.all(
  top.map(async (p) => ({
    ...p,
    imageUrl: await fetchOgImage(p.url),
  }))
);

return sendJson(res, 200, { ok: true, products });

