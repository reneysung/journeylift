#!/usr/bin/env node
// 依文章 slug/category 同步城市頁分類 chip（keywords 表 + articles.keyword_id）
// 策略：精準主題優先（該城 ≥2 篇即生，吃「台南防水」等精準詞），粗分類當後備（≥3 篇、排除已被精準涵蓋者）。每篇歸一個。
// 冪等：可重複跑。發一批新文後 `node sync_keywords.mjs`（--dry 先看）。會刪掉變空的舊分類 keyword。
import { execFileSync } from 'node:child_process';

const SUPA = 'https://zsebcpfblecwumbaxeaz.supabase.co';
const KEY = 'sb_publishable_L2DOfeM0cAJqwlVCr1LwtA_jE9MBNDn';
const TP = 2;   // 精準主題門檻（該城 ≥2 篇）
const TC = 3;   // 粗分類後備門檻（該城 ≥3 篇）
const DRY = process.argv.includes('--dry');

// 精準主題：依序比對 slug 尾綴（去城市前綴後） → [regex, 顯示名, slug 尾]
const RULES = [
  [/roof-waterproofing|waterproofing/, '防水抓漏', 'waterproofing'],
  [/enamel-kitchen|kitchen/, '廚具', 'kitchen'],
  [/contractor/, '裝潢統包', 'contractor'],
  [/painting/, '油漆', 'painting'],
  [/cctv|low-voltage/, '監視器弱電', 'security'],
  [/cabinet/, '系統櫃', 'cabinet'],
  [/interior-design|design-guide/, '室內設計', 'interior-design'],
  [/flooring|wood-floor|laminate/, '木地板', 'flooring'],
  [/water-filter|swiss-water/, '淨水設備', 'water-filter'],
  [/steak/, '牛排', 'steak'], [/hotpot/, '火鍋', 'hotpot'], [/yakiniku/, '燒肉', 'yakiniku'],
  [/dessert/, '甜點', 'dessert'],
  [/hair-salon/, '美髮', 'hair-salon'],
  [/bojin|bodywork|sports-massage|foot-massage/, '整復按摩', 'massage'],
  [/hair-removal/, '除毛', 'hair-removal'],
  [/car-detailing/, '汽車美容', 'car-detailing'], [/car-wrap/, '汽車包膜', 'car-wrap'],
  [/car-coating/, '汽車鍍膜', 'car-coating'], [/car-audio/, '汽車音響', 'car-audio'],
  [/renovation-cleaning/, '裝潢細清', 'renovation-cleaning'],
  [/aircon-cleaning/, '冷氣清洗', 'aircon-cleaning'], [/home-cleaning/, '居家清潔', 'home-cleaning'],
];
// 粗分類後備：category → [顯示名, slug 尾]
const CATMAP = {
  '餐廳': ['美食', 'food'], '咖啡廳': ['咖啡廳', 'cafe'], '居家裝修': ['居家裝修', 'renovation'],
  '居家清潔': ['居家清潔', 'cleaning'], '美容美髮': ['美容美髮', 'beauty'], '汽車服務': ['汽車服務', 'car'],
  '手作體驗': ['手作體驗', 'handmade'], '健康醫療': ['健康醫療', 'health'], '生活服務': ['生活服務', 'life'],
  '運動健身': ['運動健身', 'fitness'], '除蟲防治': ['除蟲防治', 'pest'], '珠寶銀樓': ['珠寶銀樓', 'jewelry'],
  '景點': ['旅遊景點', 'attraction'], '住宿': ['住宿', 'stay'], '專業服務': ['專業服務', 'professional'],
  '教育學習': ['教育學習', 'education'],
};

function req(method, path, body) {
  const args = ['-s', '-X', method, `${SUPA}/rest/v1/${path}`,
    '-H', `apikey: ${KEY}`, '-H', `Authorization: Bearer ${KEY}`,
    '-H', 'Content-Type: application/json', '-H', 'Prefer: return=representation'];
  if (body !== undefined) args.push('--data-binary', JSON.stringify(body));
  const out = execFileSync('curl', args, { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : [];
}
const topicOf = (slug) => {
  const tail = slug.split('-').slice(1).join('-');
  for (const [rx, name, ts] of RULES) if (rx.test(tail)) return [name, ts];
  return null;
};

const regions = req('GET', 'regions?select=id,name,slug');
const regByName = Object.fromEntries(regions.map((r) => [r.name, r]));
const arts = req('GET', 'articles?status=eq.published&select=id,city,slug,category');
const existing = req('GET', 'keywords?select=id,slug,region_id');
const exMap = new Map(existing.map((k) => [`${k.region_id}|${k.slug}`, k.id]));

// 目標：region → Map(slug → {name, ids})
const target = new Map();
const affectedRegions = new Set();
for (const region of regions) {
  const ca = arts.filter((a) => a.city === region.name);
  if (!ca.length) continue;
  const groups = new Map(); // slug → {name, ids}
  const used = new Set();
  // 精準主題
  const byTopic = new Map();
  for (const a of ca) {
    const t = a.slug ? topicOf(a.slug) : null;
    if (!t) continue;
    const key = `${region.slug}-${t[1]}`;
    if (!byTopic.has(key)) byTopic.set(key, { name: t[0], ids: [] });
    byTopic.get(key).ids.push(a.id);
  }
  for (const [slug, g] of byTopic) if (g.ids.length >= TP) { groups.set(slug, g); g.ids.forEach((i) => used.add(i)); }
  // 粗分類後備（排除已用）
  const byCat = new Map();
  for (const a of ca) {
    if (used.has(a.id) || !CATMAP[a.category]) continue;
    const [nm, sl] = CATMAP[a.category];
    const slug = `${region.slug}-${sl}`;
    if (!byCat.has(slug)) byCat.set(slug, { name: nm, ids: [] });
    byCat.get(slug).ids.push(a.id);
  }
  for (const [slug, g] of byCat) if (g.ids.length >= TC) groups.set(slug, g);
  if (groups.size) { target.set(region.id, groups); affectedRegions.add(region.id); }
}

let created = 0, reused = 0, linked = 0, deleted = 0;
const linkedIds = new Set();
for (const region of regions) {
  const groups = target.get(region.id);
  if (!groups) continue;
  let so = -1000;
  const wanted = [...groups.entries()].sort((a, b) => b[1].ids.length - a[1].ids.length);
  for (const [slug, g] of wanted) {
    so += 1;
    const sortOrder = -g.ids.length;
    let kwid = exMap.get(`${region.id}|${slug}`);
    if (kwid) { reused++; if (!DRY) req('PATCH', `keywords?id=eq.${kwid}`, { name: g.name, sort_order: sortOrder }); }
    else { created++; if (!DRY) { const r = req('POST', 'keywords', { name: g.name, slug, region_id: region.id, sort_order: sortOrder }); kwid = r[0] && r[0].id; } }
    if (kwid && !DRY) req('PATCH', `articles?id=in.(${g.ids.join(',')})`, { keyword_id: kwid });
    g.ids.forEach((i) => linkedIds.add(i));
    linked += g.ids.length;
    console.log(`  ${region.name} × ${g.name} (${g.ids.length}) → ${slug}`);
  }
}
if (!DRY) {
  // NULL 掉不再符合的 keyword_id
  const hadKw = req('GET', 'articles?status=eq.published&keyword_id=not.is.null&select=id').map((a) => a.id);
  const toNull = hadKw.filter((id) => !linkedIds.has(id));
  if (toNull.length) req('PATCH', `articles?id=in.(${toNull.join(',')})`, { keyword_id: null });
  // 刪掉受影響 region 裡、不在目標集合的舊 keyword（變空的分類）
  for (const region of regions) {
    const groups = target.get(region.id) || new Map();
    const cur = req('GET', `keywords?region_id=eq.${region.id}&select=id,slug`);
    for (const k of cur) if (!groups.has(k.slug)) { req('DELETE', `keywords?id=eq.${k.id}`); deleted++; }
  }
  if (toNull.length) console.log(`  NULL ${toNull.length} 篇不再符合的 keyword_id`);
}
console.log(`\nkeywords: 新建 ${created}、沿用 ${reused}、刪除 ${deleted}；掛 ${linked} 篇${DRY ? '（DRY）' : ''}`);
