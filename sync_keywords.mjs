#!/usr/bin/env node
// 依各城實際 category 同步 keywords 表 + 文章 keyword_id（城市頁分類 chip 的資料來源）
// 冪等：可重複跑。發佈一批新文後跑一次，就自動：①新 category 過 ≥3 門檻就建分類頁 ②新文歸類
// 用法：node sync_keywords.mjs [--dry]
import { execFileSync } from 'node:child_process';

const SUPA = 'https://zsebcpfblecwumbaxeaz.supabase.co';
const KEY = 'sb_publishable_L2DOfeM0cAJqwlVCr1LwtA_jE9MBNDn';
const THRESHOLD = 3;               // 該城某分類 ≥3 篇才生分類頁（避免薄頁 doorway）
const DRY = process.argv.includes('--dry');

// category → [顯示標籤, 英文 slug 後綴]（親民精準詞、對 SEO 較好）
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

const regions = req('GET', 'regions?select=id,name,slug');
const regByName = Object.fromEntries(regions.map((r) => [r.name, r]));
const arts = req('GET', 'articles?status=eq.published&select=id,city,category');
const existing = req('GET', 'keywords?select=id,slug,region_id');
const exMap = new Map(existing.map((k) => [`${k.region_id}|${k.slug}`, k.id]));

// 每 (city,category) 的文章 id
const cc = new Map();
for (const a of arts) {
  if (!a.city || !a.category) continue;
  const key = `${a.city}|${a.category}`;
  (cc.get(key) || cc.set(key, []).get(key)).push(a.id);
}

let created = 0, reused = 0, linked = 0;
const linkedIds = new Set();
for (const [key, ids] of cc) {
  const [city, cat] = key.split('|');
  if (ids.length < THRESHOLD || !CATMAP[cat] || !regByName[city]) continue;
  const region = regByName[city];
  const [name, eng] = CATMAP[cat];
  const slug = `${region.slug}-${eng}`;
  const sort = -ids.length;
  let kwid = exMap.get(`${region.id}|${slug}`);
  if (kwid) {
    reused++;
    if (!DRY) req('PATCH', `keywords?id=eq.${kwid}`, { name, sort_order: sort });
  } else {
    created++;
    if (!DRY) {
      const res = req('POST', 'keywords', { name, slug, region_id: region.id, sort_order: sort });
      kwid = res[0] && res[0].id;
    }
  }
  if (kwid && !DRY) req('PATCH', `articles?id=in.(${ids.join(',')})`, { keyword_id: kwid });
  ids.forEach((i) => linkedIds.add(i));
  linked += ids.length;
  console.log(`  ${city} × ${name} (${ids.length}篇) → ${slug}`);
}
// 清掉「原本有 keyword_id、但現在該分類 <門檻 或無對映」的文章
if (!DRY) {
  const orphan = arts.filter((a) => !linkedIds.has(a.id));
  const hadKw = req('GET', 'articles?status=eq.published&keyword_id=not.is.null&select=id').map((a) => a.id);
  const toNull = hadKw.filter((id) => !linkedIds.has(id));
  if (toNull.length) req('PATCH', `articles?id=in.(${toNull.join(',')})`, { keyword_id: null });
  if (toNull.length) console.log(`  清掉 ${toNull.length} 篇不再符合的 keyword_id`);
}
console.log(`\nkeywords: 新建 ${created}、沿用 ${reused}；掛 keyword_id ${linked} 篇${DRY ? '（DRY，未寫入）' : ''}`);
