// api/recommend.js
// 最短MVP：仮データで「用途×予算」で上位3件を返す（Vercel向け）

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

function getMockProducts() {
  return [
    {
      sku: "A001",
      name: "14型 薄型ノート / Core i5 / メモリ16GB / SSD512GB",
      description: "メモリ16GB SSD512GB Core i5-1035G1",
      price: 59800,
      quantity: 3,
      url: "https://example.com/item/A001",
    },
    {
      sku: "A002",
      name: "15.6型 お仕事向け / メモリ8GB / SSD256GB",
      description: "メモリ8GB SSD256GB Core i5-8250U",
      price: 39800,
      quantity: 5,
      url: "https://example.com/item/A002",
    },
    {
      sku: "A003",
      name: "ゲーム向け / RTX搭載 / メモリ16GB / SSD1TB",
      description: "GeForce RTX メモリ16GB SSD1TB",
      price: 109800,
      quantity: 1,
      url: "https://example.com/item/A003",
    },
  ];
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
  try { return JSON.parse(raw); } catch { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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

    const products = getMockProducts()
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
            ? "事務・普段使い向けに、必要スペックを満たしつつ予算内でバランス◎"
            : useCase === "creator"
            ? "編集・制作向けに、メモリ/SSDを優先して候補から選定"
            : "ゲーム向けにGPU搭載を優先して候補から選定",
      }));

    return sendJson(res, 200, { ok: true, products });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e) });
  }
};
