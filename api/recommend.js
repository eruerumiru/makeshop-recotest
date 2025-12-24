// api/recommend.js
// Makeshop CSV（data/20251224113121.csv）から在庫>0のみ読み込み、
// 初心者向けの「店員知識」込みで 3枠（十分/快適/余裕）おすすめを返す。

const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");

// ===== CORS =====
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

// ===== CSV reader (cp932) =====
let _cache = { at: 0, rows: null }; // 60s cache

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
  // Makeshopはcp932が多い
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

    // URLは「12桁ゼロ埋め」前提（えるのページ形式に合ってる）
    const url = systemCode
      ? `https://www.alpaca-pc.com/view/item/${String(systemCode).padStart(12, "0")}`
      : "";

    return {
      sku: originalCode || systemCode,
      systemCode,
      name,
      description: `${name}\n${opt}`.trim(),
      price,
      quantity,
      url,
    };
  });

  _cache = { at: now, rows };
  return rows;
}

// ===== Spec / feature extraction =====
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

  const hasHDD = /HDD/i.test(t) && !/SSD/i.test(t); // 「SSD」もあるならHDD単独ではない扱い
  const hasGPU = /(RTX|GTX|Radeon|Arc|GeForce)/i.test(t);

  // CPU文字列（i3-6100U, i5-8250U, Ryzen 5 3500Uなど）
  const cpu =
    (t.match(/i[3579]-\d{4,5}[A-Z]{0,2}/i) || [null])[0] ||
    (t.match(/Ryzen\s*[3579]\s*\d{4,5}[A-Z]{0,2}/i) || [null])[0] ||
    null;

  // 世代ざっくり推定（Intel iX-6xxx -> 6世代, iX-8250 -> 8世代, iX-10210 -> 10世代）
  let cpuGen = null;
  if (cpu && /^i[3579]-/i.test(cpu)) {
    const m = cpu.match(/i[3579]-(\d{4,5})/i);
    if (m) {
      const num = m[1];
      cpuGen = num.length === 4 ? Number(num[0]) : Number(num.slice(0, 2));
    }
  }

  return { memGB, ssdGB, hasGPU, hasHDD, cpu, cpuGen };
}

function parseFeatures(text = "") {
  const t = String(text);

  const isLaptop = /ノート|Laptop|ThinkPad|LuvBook|Latitude|EliteBook|Let's note|レッツノート/i.test(t);
  const isDesktop = /デスクトップ|Desktop|ProDesk|OptiPlex|SFF|DM|MT|タワー|ワークステーション/i.test(t);

  const deviceType = isLaptop && !isDesktop ? "laptop" : isDesktop && !isLaptop ? "desktop" : "any";

  const hasCamera = /WEBカメラ|Webカメラ|カメラ/i.test(t);
  const hasTenkey = /テンキー/i.test(t);

  const inchMatch = t.match(/(\d{1,2}\.?\d?)\s*インチ/);
  const inch = inchMatch ? Number(inchMatch[1]) : null;

  return { deviceType, hasCamera, hasTenkey, inch };
}

// ===== 店員知識（用途→適正） =====
function getProfile(useCase) {
  // えるの希望：officeは「適正2万」を起点にする
  // ※ここは後からいくらでも調整できる “知識テーブル”
  const base = {
    office: {
      label: "事務・普段使い",
      target: { laptop: 22000, desktop: 20000, any: 20000 },
      minSpec: { mem: 8, ssd: 256 },
      avoid: { hddOnly: true, memUnder: 8 },
    },
    zoom: {
      label: "Zoom・オンライン会議",
      target: { laptop: 25000, desktop: 22000, any: 23000 },
      minSpec: { mem: 8, ssd: 256 },
      require: { camera: true },
      avoid: { hddOnly: true, memUnder: 8 },
    },
    creator: {
      label: "制作・編集（軽〜中）",
      target: { laptop: 45000, desktop: 40000, any: 42000 },
      minSpec: { mem: 16, ssd: 512 },
      avoid: { hddOnly: true, memUnder: 8 },
    },
    game: {
      label: "ゲーム",
      target: { laptop: 70000, desktop: 65000, any: 65000 },
      minSpec: { mem: 16, ssd: 512 },
      require: { gpu: true },
      avoid: { hddOnly: true, memUnder: 8 },
    },
  };

  return base[useCase] || base.office;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// 「予算上限」から「店員が探す中心価格」を決める（ここが“知識で考える”）
function computeTargetBudget(profile, budgetMax, devicePref) {
  const key = devicePref === "laptop" || devicePref === "desktop" ? devicePref : "any";
  const baseTarget = profile.target[key] ?? profile.target.any;

  // 上限が高くても、用途の適正に寄せる（office=2万ルール）
  const target = Math.min(budgetMax || baseTarget, baseTarget);

  // 3枠（十分/快適/余裕）の中心を作る
  const enough = clamp(target, 10000, budgetMax || target);
  const comfort = clamp(Math.round(target * 1.35), enough, budgetMax || Math.round(target * 1.35));
  const headroom = clamp(Math.round(target * 1.8), comfort, budgetMax || Math.round(target * 1.8));

  return { target, enough, comfort, headroom };
}

function scoreProduct(p, spec, feat, useCase, centerPrice, profile, req) {
  let s = 0;

  // 価格：centerPriceに近いほど高い（安すぎも少し減点）
  if (centerPrice > 0) {
    const ratio = p.price / centerPrice;
    // ratio=1 が最高、0.6〜1.6あたりを許容
    const dist = Math.abs(Math.log(ratio)); // 0がベスト
    s += Math.max(0, 12 - dist * 18); // 雑に山型
    if (ratio < 0.55) s -= 2; // 安すぎるのは“過剰に安物提案”防止
  }

  // 地雷回避（中古店員）
  if (profile.avoid?.hddOnly && spec.hasHDD) s -= 8;
  if (profile.avoid?.memUnder && (spec.memGB ?? 0) < profile.avoid.memUnder) s -= 8;

  // 必要スペック（用途）
  const mem = spec.memGB ?? 0;
  const ssd = spec.ssdGB ?? 0;

  if (mem >= (profile.minSpec?.mem ?? 0)) s += 4;
  if (ssd >= (profile.minSpec?.ssd ?? 0)) s += 3;

  // 余裕枠に寄せるときはメモリ/SSDを強めに評価
  if (centerPrice >= (req.headroomCenter || 0)) {
    if (mem >= 16) s += 3;
    if (ssd >= 512) s += 2;
  }

  // GPU必須用途
  if (profile.require?.gpu) {
    if (spec.hasGPU) s += 10;
    else s -= 20;
  }

  // Zoom用途：カメラ
  if (profile.require?.camera) {
    if (feat.hasCamera) s += 6;
    else s -= 10;
  }

  // デバイス希望（ノート/デスク）
  if (req.device && req.device !== "any") {
    if (feat.deviceType === req.device) s += 4;
    else if (feat.deviceType !== "any") s -= 3;
  }

  // 追加希望：テンキー/カメラ/サイズ（任意）
  if (req.needsTenkey === true) s += feat.hasTenkey ? 2 : -2;
  if (req.needsCamera === true) s += feat.hasCamera ? 2 : -2;

  if (req.screen) {
    // "13-14" / "15.6"
    if (req.screen === "13-14") {
      if (feat.inch != null) s += feat.inch <= 14.5 ? 2 : -1;
    } else if (req.screen === "15.6") {
      if (feat.inch != null) s += feat.inch >= 15 ? 2 : -1;
    }
  }

  // CPU世代は軽く評価（拾えた時だけ）
  if (spec.cpuGen != null) {
    if (spec.cpuGen >= 8) s += 2;
    else if (spec.cpuGen >= 6) s += 1;
    else s -= 1;
  }

  return s;
}

function buildReason(useCase, bucketLabel, profile, req) {
  // お客さんに刺さる“店員コメント”
  const parts = [];

  if (useCase === "office") {
    parts.push("普段使いは「8GB＋SSD256GB」で十分にサクサク");
    parts.push("予算は余ってOK、過剰スペックよりコスパ重視で選定");
  } else if (useCase === "zoom") {
    parts.push("オンライン会議向けにカメラ表記を優先");
    parts.push("8GB＋SSDで動作のもたつきを回避");
  } else if (useCase === "creator") {
    parts.push("制作向けにメモリ/SSD多めを優先");
    parts.push("作業が重いほど快適差が出やすい枠です");
  } else if (useCase === "game") {
    parts.push("ゲームはGPUが要、GPU記載を優先");
    parts.push("メモリ16GB以上を優先");
  }

  if (req.device === "laptop") parts.push("持ち運び前提でノート優先");
  if (req.device === "desktop") parts.push("据え置き前提でデスク優先");

  // 枠の説明
  if (bucketLabel === "十分") parts.push("まずはここで十分枠");
  if (bucketLabel === "快適") parts.push("体感の快適さが上がる枠");
  if (bucketLabel === "余裕") parts.push("長く使いたい人向けの余裕枠");

  return parts.slice(0, 3).join(" / ");
}

// ===== main handler =====
module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "POST only" });
  }

  try {
    const body = await readJson(req);

    // 入力（全部任意・デフォルトあり）
    // useCase: office | zoom | creator | game
    const useCase = String(body.useCase || "office");
    const budgetMax = Number(body.budget ?? 60000);

    // device: any | laptop | desktop
    const device = String(body.device || "any");

    // 任意の希望
    const needsCamera = body.needsCamera === true;
    const needsTenkey = body.needsTenkey === true;
    const screen = body.screen || null; // "13-14" | "15.6" | null

    const profile = getProfile(useCase);

    const centers = computeTargetBudget(profile, budgetMax, device);

    const reqPref = {
      device,
      needsCamera,
      needsTenkey,
      screen,
      headroomCenter: centers.headroom,
    };

    const all = readProductsFromMakeshopCsv()
      .filter((p) => p.quantity > 0)
      .filter((p) => p.price > 0)
      .filter((p) => p.price <= budgetMax);

    // スコアリング（3つの中心価格で別々に評価 → それぞれ1台ずつ選ぶ）
    function pickOne(centerPrice, label) {
      let best = null;
      let bestScore = -1e9;

      for (const p of all) {
        const spec = parseSpec(`${p.name}\n${p.description}`);
        const feat = parseFeatures(p.name);

        // 必須条件がある場合の強フィルタ（Zoomのカメラなど）
        if (profile.require?.camera && !feat.hasCamera) continue;
        if (profile.require?.gpu && !spec.hasGPU) continue;

        const sc = scoreProduct(p, spec, feat, useCase, centerPrice, profile, reqPref);

        if (sc > bestScore) {
          bestScore = sc;
          best = { p, sc, spec, feat };
        }
      }

      if (!best) return null;

      return {
        tier: label,
        name: best.p.name,
        price: best.p.price,
        url: best.p.url,
        sku: best.p.sku,
        // 表示用の簡易スペック（お客さんに効くやつ）
        spec: {
          cpu: best.spec.cpu,
          memGB: best.spec.memGB,
          ssdGB: best.spec.ssdGB,
          gpu: best.spec.hasGPU ? "あり" : "なし",
          camera: best.feat.hasCamera ? "あり" : "なし",
          tenkey: best.feat.hasTenkey ? "あり" : "なし",
          device: best.feat.deviceType,
          inch: best.feat.inch,
        },
        reason: buildReason(useCase, label, profile, reqPref),
      };
    }

    // 3枠：十分 / 快適 / 余裕
    const enough = pickOne(centers.enough, "十分");
    const comfort = pickOne(centers.comfort, "快適");
    const headroom = pickOne(centers.headroom, "余裕");

    // 同じ商品が重複したら、後ろを落とす（簡易）
    const uniq = [];
    const seen = new Set();
    for (const x of [enough, comfort, headroom]) {
      if (!x) continue;
      const key = x.sku || x.url || x.name;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(x);
    }

    const meta = {
      useCase,
      useCaseLabel: profile.label,
      budgetMax,
      device,
      // 店員の“頭の中”を少しだけ返す（表示に使える）
      pricing: {
        target: centers.target, // 用途の適正に寄せた中心
        enough: centers.enough,
        comfort: centers.comfort,
        headroom: centers.headroom,
      },
      note:
        useCase === "office"
          ? "普段使いは予算を使い切らなくてOK。2万円前後を中心に“十分/快適/余裕”で提案します。"
          : "用途に合わせて“十分/快適/余裕”で提案します。",
    };

    return sendJson(res, 200, { ok: true, meta, products: uniq });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e) });
  }
};
