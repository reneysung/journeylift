// 漫途旅遊誌 — Cloudflare Worker (final)
// 動態 sitemap.xml / 文章 SSR meta / 城市路由 / 舊 slug 301 / security headers
//
// 設計重點（避開今天踩到的雷）：
//   1. SSR 用 `new Response(htmlString, { status, headers })`，security headers 直接放 init，不二次 wrap
//   2. 從 ASSETS 取模板用 `/articles/article`（不帶 .html），避開 wrangler 4 的 308
//   3. ASSETS body 用 arrayBuffer + TextDecoder，避開 .text() 偶爾為空的情況

const SB_URL = 'https://zsebcpfblecwumbaxeaz.supabase.co';
const SB_KEY = 'sb_publishable_L2DOfeM0cAJqwlVCr1LwtA_jE9MBNDn';
const SITE = 'https://journeylift.com.tw';
const DEFAULT_OG = `${SITE}/og-default.jpg`;
const SITE_NAME = '漫途旅遊誌';

const CITIES = [
  ['taipei', 1.0], ['newtaipei', 0.9], ['taoyuan', 0.8], ['hsinchu', 0.8],
  ['taichung', 0.9], ['changhua', 0.8], ['nantou', 0.8], ['miaoli', 0.8],
  ['chiayi', 0.8], ['tainan', 0.9], ['kaohsiung', 0.9], ['pingtung', 0.8],
  ['yilan', 0.8], ['hualien', 0.8], ['taitung', 0.8], ['keelung', 0.8],
  ['kinmen', 0.8], ['penghu', 0.8],
];
const CITY_SET = new Set(CITIES.map((c) => c[0]));

// 城市中文名 → slug（麵包屑 BreadcrumbList 用；對不到就退回「文章」層）
const CITY_NAME_SLUG = {
  '台北': 'taipei', '新北': 'newtaipei', '桃園': 'taoyuan', '台中': 'taichung',
  '台南': 'tainan', '高雄': 'kaohsiung', '基隆': 'keelung', '新竹': 'hsinchu',
  '苗栗': 'miaoli', '彰化': 'changhua', '南投': 'nantou', '嘉義': 'chiayi',
  '屏東': 'pingtung', '宜蘭': 'yilan', '花蓮': 'hualien', '台東': 'taitung',
  '澎湖': 'penghu', '金門': 'kinmen',
};

const SLUG_REDIRECTS = {
  '-1774017366618': 'kaohsiung-pier2-warehouse-cafe',
  '-sm0m': 'taipei-daan-green-light-cafe',
  '-1774011508378': 'tainan-chihkan-old-well-cafe',
  '202610-1774019872644': 'tainan-renovation-cleaning-2026',
  'taipei-renovation-cleaning-2026': 'taipei-renovation-cleaning', // 舊 slug 改名 → 301 保住權重
};

// ── 地區專區（/{key}）：城市底下的旅遊熱區，集中同區文章＋分區導覽 ──
// 文章依 slug 前綴自動收進來（新發 kenting-* 會自動出現在「更多」組）；groups 決定分組與順序。
// 導覽文字只寫各篇文章裡已查證過的事實，改內容時同步對照文章。
const AREAS = {
  kenting: {
    name: '墾丁',
    city: '屏東',
    citySlug: 'pingtung',
    slugPrefix: 'kenting-',
    title: (n) => `墾丁旅遊攻略｜吃住玩分區整理與兩天一夜行程，${n} 篇一次看 — 漫途生活旅遊誌`,
    desc: '墾丁怎麼玩？漫途把墾丁的兩天一夜行程、海產、美食、飲料、民宿、飯店、露營、浮潛、卡丁車和按摩整理在同一頁，並依恆春古城、墾丁大街、南灣、後壁湖等區域分好，出發前先看這頁。',
    h1: '墾丁旅遊攻略',
    sub: (n) => `恆春半島的吃、住、玩與兩天一夜行程，漫途 ${n} 篇整理在這一頁`,
    intro: [
      '墾丁在恆春半島最南端，範圍大半在墾丁國家公園內，景點、餐廳和住宿散在半島一圈。從恆春市區開到後壁湖約 15 分鐘、到墾丁大街約 10 到 15 分鐘，住哪、在哪吃，會直接影響一天能玩幾個點。',
      '這頁把漫途寫過的墾丁文章收在一起。第一次去，先看兩天一夜行程把動線排好；行程定了，再依要吃什麼、住哪裡、玩什麼點進各篇，每篇都附比較表和 Google 評分。',
    ],
    zones: [
      ['恆春古城（市區）', '在地小吃最集中，綠豆蒜、鴨肉冬粉、餃子都在這一帶，古早味手搖和老屋咖啡也多在市區；精油芳療工作室多在恆春。住宿房價相對親民、好停車。',
        [['kenting-food', '墾丁美食'], ['kenting-drinks', '墾丁飲料店'], ['kenting-massage', '墾丁按摩']]],
      ['墾丁大街（小灣一帶）', '晚上最熱鬧的夜市街，晚餐、逛街、腳底按摩走路就到，凱撒、夏都、福華幾間飯店都在附近。旺季比較吵，停車最難找。',
        [['kenting-hotel', '墾丁飯店'], ['kenting-massage', '墾丁按摩']]],
      ['南灣', '沙灘與水上活動集中，比大街安靜。海景民宿、南灣渡假飯店都在這一帶，卡丁車場多在恆春往墾丁、南灣的路上。',
        [['kenting-bnb', '墾丁民宿'], ['kenting-gocar', '墾丁卡丁車']]],
      ['船帆石', '台 26 線海邊的珊瑚礁岩地標，往鵝鑾鼻、東海岸最順路，附近有海景民宿和福容。',
        [['kenting-bnb', '墾丁民宿'], ['kenting-hotel', '墾丁飯店']]],
      ['後壁湖', '墾丁國家公園內最大的漁港，生魚片、海產店最集中；內灣水淺浪小，是新手浮潛的首選。',
        [['kenting-seafood', '墾丁海產'], ['kenting-snorkeling', '墾丁浮潛']]],
      ['西海岸（萬里桐、紅柴、關山）', '萬里桐浮潛人比較少，有一對一帶的店；海景咖啡多在這一側，傍晚可以順看關山夕陽。',
        [['kenting-snorkeling', '墾丁浮潛'], ['kenting-drinks', '墾丁飲料店'], ['kenting-itinerary', '兩天一夜行程']]],
      ['東海岸（龍磐、風吹砂、佳樂水）', '看地景的路線，沿路店家少、草原段沒有遮蔽，水和防曬要帶夠；落山風季風很大。',
        [['kenting-itinerary', '兩天一夜行程']]],
    ],
    groups: [
      { title: '行程：第一次去先看這篇', note: '西岸、南岬、東海岸怎麼排才不繞路，含住宿分區、交通停車和季節提醒。', slugs: ['kenting-itinerary'] },
      { title: '吃：海產、美食、飲料', note: '海產集中在後壁湖，在地小吃和古早味飲料在恆春市區，墾丁大街適合晚上逛。', slugs: ['kenting-seafood', 'kenting-food', 'kenting-drinks'] },
      { title: '住：民宿、飯店、露營', note: '想走路到大街住小灣一帶，要安靜或海景看南灣、船帆石、埔頂；國家公園內限制露營，營地只有少數幾處。', slugs: ['kenting-bnb', 'kenting-hotel', 'kenting-camping'] },
      { title: '玩：浮潛、卡丁車、按摩', note: '浮潛新手去後壁湖、想避開人潮去萬里桐；卡丁車場多在恆春往墾丁、南灣的路上；玩到晚上，大街也有開到很晚的按摩店。', slugs: ['kenting-snorkeling', 'kenting-gocar', 'kenting-massage'] },
    ],
    tips: [
      ['季節', '10 月到隔年 3 月落山風強，東海岸偏冷；7 到 10 月是颱風季，海邊景點和水上活動遇大浪會關閉。'],
      ['交通', '景點分散，自駕最方便；不開車可搭高鐵到左營轉墾丁快線或台灣好行，再租機車。'],
      ['預約', '精油芳療、包棟民宿和熱門海產店，旺季都建議提早訂。'],
    ],
  },
  jiaoxi: {
    name: '礁溪',
    city: '宜蘭',
    citySlug: 'yilan',
    slugPrefix: 'jiaoxi-',
    title: (n) => `礁溪旅遊攻略｜溫泉、吃住玩分區整理與兩天一夜行程，${n} 篇一次看 — 漫途生活旅遊誌`,
    desc: '礁溪怎麼玩？漫途把礁溪的兩天一夜行程、溫泉飯店、湯屋、民宿、美食、早餐、宵夜、咖啡廳、伴手禮和親子景點整理在同一頁，並依車站溫泉區、湯圍溝、中山路、甕窯雞一條街與田園區分好，出發前先看這頁。',
    h1: '礁溪旅遊攻略',
    sub: (n) => `溫泉、吃、住、玩與兩天一夜行程，漫途 ${n} 篇整理在這一頁`,
    intro: [
      '礁溪在宜蘭北邊，從台北走國道 5 號不塞車約 50 分鐘。觀光署把以礁溪車站為中心、方圓約 1.2 公里劃為溫泉區，溫泉飯店、湯屋、免費泡腳池和小吃大多走路就到；民宿、田園咖啡和步道則散在周邊的山邊與稻田，要開車。',
      '這頁把漫途寫過的礁溪文章收在一起。第一次去，先看兩天一夜行程把動線排好；再依要住哪、吃什麼、帶小孩去哪點進各篇，每篇都附比較表和 Google 評分。',
    ],
    zones: [
      ['礁溪車站、溫泉路一帶', '溫泉區的中心，溫泉飯店最集中，火車站、客運轉運站都走得到；車站前的溫泉廣場有 24 小時免費泡腳池，晚上的串燒居酒屋也多在這一帶。',
        [['jiaoxi-hotspring-hotel', '礁溪溫泉飯店'], ['jiaoxi-late-night', '礁溪宵夜']]],
      ['德陽路、湯圍溝', '湯圍溝溫泉公園有免費泡腳池、檜木湯屋和溫泉魚，傍晚後常有街頭藝人；冬季溫泉季的燈飾也集中在這裡。',
        [['jiaoxi-hotspring-bath', '礁溪湯屋'], ['jiaoxi-family', '礁溪親子景點']]],
      ['忠孝路一巷', '平價計時湯屋集中的巷子，有 24 小時、不用預約的湯屋，也有不限時的大眾湯，寒流時常要排隊。',
        [['jiaoxi-hotspring-bath', '礁溪湯屋']]],
      ['中山路、礁溪路四段', '在地人吃的老店和早點最多，清晨就開的豆漿燒餅、麵線、魚羹肉羹，還有八寶冬粉和蔥油餅。',
        [['jiaoxi-breakfast', '礁溪早餐'], ['jiaoxi-food', '礁溪美食']]],
      ['礁溪路五段、六段（轉運站）', '伴手禮店集中，糕餅、牛舌餅和奶油麵包都在車站、轉運站走路幾分鐘內，回程前順路買最方便。',
        [['jiaoxi-souvenir', '礁溪伴手禮']]],
      ['礁溪路七段（下交流道）', '甕窯雞一條街，甕窯雞餐廳超過五家，對面還有羊肉爐，開車進出礁溪時順路吃。',
        [['jiaoxi-food', '礁溪美食']]],
      ['五峰路、林美山邊', '五峰旗、跑馬古道、林美石磐步道都在這一側，也有山坡上的度假飯店和日歸湯屋；步道豪雨後常封閉，出發前先查公告。',
        [['jiaoxi-itinerary', '兩天一夜行程'], ['jiaoxi-cafe', '礁溪咖啡廳']]],
      ['二龍、白雲、時潮等田園區', '合法民宿多在這些稻田區，還有田園咖啡廳和高架橋下的免費親子遊戲場，基本上要開車。',
        [['jiaoxi-bnb', '礁溪民宿'], ['jiaoxi-cafe', '礁溪咖啡廳'], ['jiaoxi-family', '礁溪親子景點']]],
    ],
    groups: [
      { title: '行程：第一次去先看這篇', note: '五峰旗、頭城海線到羅東夜市怎麼排不繞路，含住宿分區、交通和步道封閉提醒。', slugs: ['jiaoxi-itinerary'] },
      { title: '住：溫泉飯店、湯屋、民宿', note: '不開車就住車站周邊的溫泉飯店；只想泡幾個小時選湯屋；想住田園、包棟或帶寵物看合法民宿。', slugs: ['jiaoxi-hotspring-hotel', 'jiaoxi-hotspring-bath', 'jiaoxi-bnb'] },
      { title: '吃：美食、早餐、宵夜', note: '老店小吃集中在中山路和礁溪路四段，泡完湯的宵夜多在車站周邊，開車可以順路吃甕窯雞。', slugs: ['jiaoxi-food', 'jiaoxi-breakfast', 'jiaoxi-late-night'] },
      { title: '逛與玩：咖啡廳、伴手禮、親子景點', note: '車站附近有主題咖啡和甜點店，伴手禮在轉運站周邊一次買齊；帶小孩有不少免費景點和雨天備案。', slugs: ['jiaoxi-cafe', 'jiaoxi-souvenir', 'jiaoxi-family'] },
    ],
    tips: [
      ['季節', '宜蘭雨天多，12 月到隔年 4 月多是綿綿細雨；溫泉季過去多在 11 月底開始；步道類景點豪雨後常封閉。'],
      ['交通', '自駕走國 5 雪山隧道，週日下午到晚上北上常塞車；不開車可搭首都客運 1572、葛瑪蘭客運 1915 或台鐵到礁溪站。'],
      ['泡湯', '縣府提醒泡腳每次不超過 15 分鐘，泡完湯休息 30 分鐘以上再開車；孕婦、高血壓、心臟病患者不宜泡湯。'],
    ],
  },
  luodong: {
    name: '羅東',
    city: '宜蘭',
    citySlug: 'yilan',
    slugPrefix: 'luodong-',
    title: (n) => `羅東旅遊攻略｜夜市、吃住玩分區整理，${n} 篇一次看 — 漫途生活旅遊誌`,
    desc: '羅東怎麼玩？漫途把羅東夜市必吃、美食、早餐、住宿、咖啡廳和景點整理在同一頁，並依火車站前站、後站、夜市與中山公園、羅東林場、純精路、運動公園和往南的冬山河、傳藝分好，出發前先看這頁。',
    h1: '羅東旅遊攻略',
    sub: (n) => `夜市、吃、住、玩，漫途 ${n} 篇整理在這一頁`,
    intro: [
      '台鐵羅東站和羅東轉運站都在市區，從前站走到羅東夜市約 10 分鐘，羅東林場離火車站也不遠，老店、夜市、林場走路就能串起來。往南是五結和冬山，冬山河親水公園、傳藝園區、梅花湖都在附近。',
      '這頁把漫途寫過的羅東文章收在一起。晚上想逛夜市先看必吃清單；白天吃什麼、住哪裡、去哪玩，再依分區點進各篇，每篇都附比較表和 Google 評分。',
    ],
    zones: [
      ['火車站前站、公正路一帶', '出站沿公正路走到興東路左轉，約 10 分鐘到夜市；民生市場旁的公正街有兩家咖啡廳，近火車站的平價商旅也在這一帶。',
        [['luodong-stay', '羅東住宿'], ['luodong-cafe', '羅東咖啡廳']]],
      ['後站（站東路、光榮路、羅莊）', '緊鄰火車站和轉運站的溫泉飯店在這一側，還有康莊路的早午餐、光榮路的義法餐館和羅莊的千層蛋糕。',
        [['luodong-stay', '羅東住宿'], ['luodong-breakfast', '羅東早餐'], ['luodong-cafe', '羅東咖啡廳']]],
      ['夜市與中山公園', '民生路、民權路、公園路、興東路圍著中山公園，傍晚以後最熱鬧；夜市旁有老冰店和甜湯，周邊白天也有手路菜、米苔目這類老店。',
        [['luodong-night-market', '羅東夜市必吃'], ['luodong-food', '羅東美食'], ['luodong-breakfast', '羅東早餐']]],
      ['羅東林場、倉前路一帶', '羅東林業文化園區免門票，園區裡 2026 年開了星巴克；附近的倉前路有親子旅宿和台式熱炒，復興路一段有早午餐。',
        [['luodong-attraction', '羅東景點'], ['luodong-stay', '羅東住宿'], ['luodong-food', '羅東美食']]],
      ['純精路、文化工場、四育路', '羅東文化工場的大棚架在純精路，裡面有玻璃屋甜點店；純精路上有石頭火鍋、懷舊合菜和無招牌油飯，國華國中旁的四育路有醬油小吃和義大利麵。',
        [['luodong-attraction', '羅東景點'], ['luodong-food', '羅東美食'], ['luodong-breakfast', '羅東早餐']]],
      ['運動公園一帶', '羅東運動公園官方寫 24 小時開放，裡面有免費、有屋頂的風雨樂活館；旁邊有高樓層商旅，開車幾分鐘也有合法民宿。',
        [['luodong-attraction', '羅東景點'], ['luodong-stay', '羅東住宿']]],
      ['往南：五結、冬山', '冬山河親水公園可以搭電動小船到傳藝園區，冬山有生態綠舟和梅花湖，二結穀倉在五結；傳藝從羅東火車站搭計程車約 20 分鐘。',
        [['luodong-attraction', '羅東景點']]],
    ],
    groups: [
      { title: '吃：夜市、美食、早餐', note: '晚上逛夜市先看必吃清單；白天的手路菜、石頭火鍋和合菜在美食篇，早上的米苔目、乾麵和胡椒餅在早餐篇。', slugs: ['luodong-night-market', 'luodong-food', 'luodong-breakfast'] },
      { title: '住：火車站、夜市旁到親子旅館', note: '10 家都查過旅宿網的合法登記；不開車住前站、後站或夜市旁，帶小孩有兩家親子旅館，帶寵物看合法民宿。', slugs: ['luodong-stay'] },
      { title: '逛與玩：咖啡廳、景點', note: '火車站附近就有幾家咖啡廳；景點分市區和往南兩段，下雨也有免費的室內去處。', slugs: ['luodong-cafe', 'luodong-attraction'] },
    ],
    tips: [
      ['夜市', '縣府觀光網寫每天下午 3 點到半夜 12 點，多數攤位傍晚才開；周邊單行道多、假日停車不容易，縣府建議搭大眾運輸。'],
      ['交通', '台鐵羅東站前站走到夜市約 10 分鐘；往傳藝園區可以搭國光客運 1791，在「大眾廟-傳藝中心」站下車。'],
      ['下雨', '宜蘭雨天多，羅東的自然史教育館、文化工場天空藝廊是室內，運動公園的風雨樂活館有屋頂，都免費。'],
    ],
  },
};

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function withSec(extra = {}) {
  const h = new Headers(extra);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  return h;
}

async function passAsset(env, request) {
  const r = await env.ASSETS.fetch(request);
  const buf = await r.arrayBuffer();
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(buf, { status: r.status, statusText: r.statusText, headers });
}

async function loadTemplate(env, origin, internalPath) {
  const u = new URL(internalPath, origin);
  const r = await env.ASSETS.fetch(new Request(u.toString(), { method: 'GET' }));
  if (!r.ok) throw new Error(`template ${internalPath} ${r.status}`);
  const buf = await r.arrayBuffer();
  return new TextDecoder('utf-8').decode(buf);
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sb(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}`);
  return r.json();
}

async function buildSitemap() {
  const articles = await sb(
    'articles?select=slug,updated_at,published_at,cover_image&status=eq.published&order=published_at.desc&limit=2000'
  );
  const today = new Date().toISOString().slice(0, 10);
  const entries = [];
  entries.push(`<url><loc>${SITE}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`);
  entries.push(`<url><loc>${SITE}/articles</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`);
  for (const [city, prio] of CITIES) {
    entries.push(`<url><loc>${SITE}/${city}</loc><changefreq>weekly</changefreq><priority>${prio}</priority></url>`);
  }
  for (const key of Object.keys(AREAS)) {
    entries.push(`<url><loc>${SITE}/${key}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  }
  // 城市分類頁 /{city}/{kw}（只收有綁城市的分類）
  const cityKws = await sb('keywords?select=slug,regions(slug)&region_id=not.is.null').catch(() => []);
  const citySet = new Set(CITIES.map(([c]) => c));
  for (const k of cityKws) {
    const c = k.regions && k.regions.slug;
    if (!c || !citySet.has(c) || !k.slug) continue;
    entries.push(`<url><loc>${SITE}/${c}/${escapeXml(k.slug)}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`);
  }
  let articleCount = 0;
  for (const a of articles) {
    if (!a.slug || a.slug.startsWith('-')) continue;
    const lastmod = (a.updated_at || a.published_at || today).slice(0, 10);
    const img = a.cover_image ? `<image:image><image:loc>${escapeXml(a.cover_image)}</image:loc></image:image>` : '';
    entries.push(
      `<url><loc>${SITE}/articles/${escapeXml(a.slug)}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority>${img}</url>`
    );
    articleCount++;
  }
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${entries.join('\n')}\n</urlset>\n`,
    articleCount,
    totalEntries: entries.length,
  };
}

function injectArticleMeta(template, article, slug, related = []) {
  const url = `${SITE}/articles/${slug}`;
  const fullTitle = `${article.title} — ${SITE_NAME}`;
  const desc = (article.excerpt || article.title || '').slice(0, 160);
  const image = article.cover_image || DEFAULT_OG;
  const published = article.published_at || article.created_at;
  const updated = article.updated_at || published;

  // SSR：把整個 article inline 進 HTML，前端不必再打 Supabase
  // （解決內文渲染要等 Supabase 冷啟動/逾時、整篇空白卡住的問題）
  const ssrData = `<script id="__ssr_article" type="application/json">${JSON.stringify(article).replace(/</g, '\\u003c')}</script>`;

  // 相關文章（SSR 進 HTML，讓爬蟲/AI bot 讀得到內鏈；client 再以 __ssr_related 重繪）
  const relItems = (related || []).slice(0, 6);
  const relCard = (r) => {
    const meta = [r.city ? '📍' + escapeHtml(r.city) : '', escapeHtml(r.category || '')].filter(Boolean).join(' · ');
    return `<a class="related-card" href="/articles/${escapeHtml(r.slug)}">`
      + `<div class="related-thumb"${r.cover_image ? ` style="background-image:url('${escapeHtml(r.cover_image)}')"` : ''}></div>`
      + `<div class="related-info"><div class="related-meta">${meta}</div><div class="related-name">${escapeHtml(r.title || '')}</div></div></a>`;
  };
  const relatedBlock = relItems.length
    ? `<div class="related-wrap"><h2 class="related-title">相關文章</h2><div class="related-grid">${relItems.map(relCard).join('')}</div></div>`
    : '';
  const ssrRelated = `<script id="__ssr_related" type="application/json">${JSON.stringify(relItems).replace(/</g, '\\u003c')}</script>`;

  // SSR 可見正文：H1 + 內文寫進 #article-wrap，讓不執行 JS 的爬蟲 / AI bot 也讀得到（AEO）。
  // client JS 載入後以 __ssr_article 重新渲染（補 cover/分享/店家卡），整段覆蓋此內容，對真人無影響。
  const mdLite = (txt) => !txt ? '' : String(txt)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<p>####\s+(.+?)<\/p>/g, '<h4>$1</h4>')
    .replace(/<p>###\s+(.+?)<\/p>/g, '<h3>$1</h3>')
    .replace(/<p>##\s+(.+?)<\/p>/g, '<h2>$1</h2>')
    .replace(/<p>#\s+(.+?)<\/p>/g, '<h2>$1</h2>')
    .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
  const ssrDate = published ? String(published).slice(0, 10) : '';
  const ssrBody = '<div class="art-header">'
    + (article.cover_image ? `<div class="art-cover"><img src="${escapeHtml(article.cover_image)}" alt="${escapeHtml(article.title || '')}" style="width:100%;max-height:420px;object-fit:cover;border-radius:8px;margin-bottom:1.5rem;display:block"></div>` : '')
    + '<div class="art-meta">'
    + (article.city ? `<span>📍 ${escapeHtml(article.city)}</span>` : '')
    + (article.category ? `<span>${escapeHtml(article.category)}</span>` : '')
    + (ssrDate ? `<span>${escapeHtml(ssrDate)}</span>` : '')
    + '</div>'
    + `<h1 class="art-title">${escapeHtml(article.title || '')}</h1>`
    + (article.excerpt ? `<p class="art-excerpt">${escapeHtml(article.excerpt)}</p>` : '')
    + '</div>'
    + `<div class="art-content">${mdLite(article.content)}</div>`
    + relatedBlock
    + '<div class="art-footer"><a href="/articles" class="back-btn">← 返回文章列表</a></div>';

  // 麵包屑：首頁 › 城市（對不到則「文章」）› 本篇
  const citySlug = CITY_NAME_SLUG[article.city];
  const crumbs = [{ name: '首頁', item: `${SITE}/` }];
  crumbs.push(citySlug
    ? { name: article.city, item: `${SITE}/${citySlug}` }
    : { name: '文章', item: `${SITE}/articles` });
  for (const [key, ar] of Object.entries(AREAS)) {
    if (article.city === ar.city && String(slug).startsWith(ar.slugPrefix)) {
      crumbs.push({ name: ar.name, item: `${SITE}/${key}` });
      break;
    }
  }
  crumbs.push({ name: article.title, item: url });

  const jsonLd = JSON.stringify([
    {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: article.title,
      description: desc,
      image: [image],
      datePublished: published,
      dateModified: updated,
      author: { '@type': 'Organization', name: SITE_NAME },
      publisher: { '@type': 'Organization', name: SITE_NAME, url: SITE },
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })),
    },
  ]);

  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(fullTitle)}</title>`)
    .replace(/<meta name="description" id="meta-desc"[^>]*>/,
      `<meta name="description" id="meta-desc" content="${escapeHtml(desc)}">`)
    .replace(/<link rel="canonical"[^>]*>/,
      `<link rel="canonical" id="canonical-url" href="${url}">`)
    .replace(/<meta property="og:title"[^>]*>/,
      `<meta property="og:title" content="${escapeHtml(article.title)}">`)
    .replace(/<meta property="og:description"[^>]*>/,
      `<meta property="og:description" content="${escapeHtml(desc)}">`)
    .replace(/<meta property="og:url"[^>]*>/,
      `<meta property="og:url" content="${url}">`)
    .replace(/<meta property="og:image"[^>]*>/,
      `<meta property="og:image" content="${escapeHtml(image)}">`)
    .replace(/<meta name="twitter:title"[^>]*>/,
      `<meta name="twitter:title" content="${escapeHtml(article.title)}">`)
    .replace(/<meta name="twitter:description"[^>]*>/,
      `<meta name="twitter:description" content="${escapeHtml(desc)}">`)
    .replace(/<meta name="twitter:image"[^>]*>/,
      `<meta name="twitter:image" content="${escapeHtml(image)}">`)
    .replace(/<script type="application\/ld\+json" id="schema-jsonld">[^<]*<\/script>/,
      `<script type="application/ld+json" id="schema-jsonld">${jsonLd}</script>`)
    .replace('</head>', `${ssrData}\n${ssrRelated}\n</head>`)
    .replace('<div class="loading">載入中...</div>', ssrBody);
}

function buildOgBlock({ title, desc, url, image, type = 'website' }) {
  return [
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:locale" content="zh_TW">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(desc)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '',
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(desc)}">`,
    image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : '',
  ].filter(Boolean).join('\n');
}

function ldScript(obj) {
  // escape `<` 避免內容含 </script> 破壞標籤
  const json = JSON.stringify(obj).replace(/</g, '\\u003c');
  return `<script type="application/ld+json" id="schema-jsonld-ssr">${json}</script>`;
}

function injectHomeMeta(template, ogImage) {
  const url = `${SITE}/`;
  const title = '漫途生活旅遊誌｜全台各縣市在地美食、裝潢、生活服務推薦';
  const desc = '漫途生活旅遊誌，精選全台各縣市在地美食、餐廳、裝潢清潔與生活服務推薦，在地達人帶你找到每個城市最值得的好店與好去處。';
  const head = [
    `<link rel="canonical" href="${url}">`,
    buildOgBlock({ title, desc, url, image: ogImage || DEFAULT_OG }),
    ldScript([
      { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: SITE },
      { '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME, url: SITE },
    ]),
  ].join('\n');
  return template.replace('</head>', `${head}\n</head>`);
}

function injectCityMeta(template, cityName, citySlug, articles, keywords, activeKw) {
  const isKw = !!activeKw;
  const url = isKw ? `${SITE}/${citySlug}/${activeKw.slug}` : `${SITE}/${citySlug}`;
  const title = isKw
    ? `${cityName}${activeKw.name}推薦 — 漫途生活旅遊誌`
    : `${cityName}在地美食、裝潢、生活服務推薦 — 漫途生活旅遊誌`;
  const desc = isKw
    ? `精選${cityName}${activeKw.name}推薦，在地達人帶你找到最值得造訪的好店與服務。`
    : `精選${cityName}在地美食、餐廳、裝潢清潔與生活服務推薦，帶你找到${cityName}最值得的好店與好去處。`;
  const sectionTitle = isKw ? `${cityName} × ${activeKw.name}` : `${cityName}精選文章`;
  // SSR 分類 chips（讓爬蟲讀到 城市→分類 的內鏈，分類子頁也拿得到權重）
  const chip = (name, href, active) =>
    `<a class="kw-chip${active ? ' active' : ''}" href="${href}">${escapeHtml(name)}</a>`;
  const chipsHtml = chip('全部', `/${citySlug}`, !isKw)
    + (keywords || []).map((k) => chip(k.name, `/${citySlug}/${k.slug}`, isKw && activeKw.slug === k.slug)).join('');
  const areaLinks = Object.entries(AREAS)
    .filter(([, ar]) => ar.citySlug === citySlug)
    .map(([key, ar]) => `<a class="area-link" href="/${key}">📍 ${escapeHtml(ar.name)}專區：吃、住、玩與行程一次看 →</a>`)
    .join('');
  const ogImage = (articles.find((a) => a.cover_image) || {}).cover_image || '';
  const items = articles.slice(0, 20).map((a, i) => ({
    '@type': 'ListItem', position: i + 1, url: `${SITE}/articles/${a.slug}`, name: a.title,
  }));
  const head = [
    buildOgBlock({ title, desc, url, image: ogImage || DEFAULT_OG }),
    ldScript({
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: title, description: desc, url,
      isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE },
      mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items },
    }),
  ].join('\n');

  // SSR 文章卡片：把「載入中」grid 換成真的 <a href> 卡片，讓爬蟲讀到內鏈與內容
  // （治「城市總頁可見內容薄、內鏈弱 → 文章拿不到內鏈權重、Google 不收」的根因）
  const fmtDate = (s) => {
    if (!s) return '';
    const d = new Date(s);
    return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const cityCard = (a) => {
    const img = a.cover_image
      ? `<img class="card-img" src="${escapeHtml(a.cover_image)}" alt="${escapeHtml(a.title || '')}" loading="lazy">`
      : `<div class="card-img">${escapeHtml(a.emoji || '📝')}</div>`;
    return `<a class="card" href="/articles/${escapeHtml(a.slug)}">${img}`
      + `<div class="card-body"><div class="card-meta">`
      + (a.category ? `<span class="card-tag">${escapeHtml(a.category)}</span>` : '')
      + `<span>${escapeHtml(fmtDate(a.published_at))}</span></div>`
      + `<div class="card-title">${escapeHtml(a.title || '')}</div>`
      + `<div class="card-excerpt">${escapeHtml(a.excerpt || '')}</div></div></a>`;
  };
  const cards = articles.length
    ? articles.slice(0, 30).map(cityCard).join('')
    : '<div class="empty"><div class="empty-icon">📭</div><p>此區暫無文章，敬請期待</p></div>';
  const ssrArticles = `<script id="__ssr_articles" type="application/json">${JSON.stringify(articles).replace(/</g, '\\u003c')}</script>`;

  return template
    .replace(/<title id="page-title">[^<]*<\/title>/, `<title id="page-title">${escapeHtml(title)}</title>`)
    .replace(/<meta id="meta-desc"[^>]*>/, `<meta id="meta-desc" name="description" content="${escapeHtml(desc)}">`)
    .replace(/<link rel="canonical" id="canonical"[^>]*>/, `<link rel="canonical" id="canonical" href="${url}">`)
    // SSR H1：把靜態「載入中...」換成城市名，讓不執行 JS 的爬蟲讀到正確主標題
    .replace(/<h1 id="city-name">[^<]*<\/h1>/, `<h1 id="city-name">${escapeHtml(cityName)}</h1>`)
    // SSR 區塊標題 + 篇數
    .replace(/<h2 id="section-title">[^<]*<\/h2>/, `<h2 id="section-title">${escapeHtml(sectionTitle)}</h2>`)
    .replace(/<span class="count" id="art-count">[^<]*<\/span>/, `<span class="count" id="art-count">${articles.length} 篇文章</span>`)
    // SSR 分類副標（分類頁才換）
    .replace(/<p class="hero-sub" id="city-sub">[^<]*<\/p>/, isKw
      ? `<p class="hero-sub" id="city-sub">${escapeHtml(cityName)} ${escapeHtml(activeKw.name)}精選推薦</p>`
      : '$&')
    // SSR 分類 chips（城市→分類 內鏈，讓爬蟲讀到）
    .replace('<div class="kw-chips" id="kw-chips"></div>', () => `<div class="kw-chips" id="kw-chips">${chipsHtml}</div>${areaLinks}`)
    // SSR grid：真卡片取代「載入中」占位（爬蟲讀得到、Supabase 掛了使用者也看得到內容）
    .replace('<div id="grid" class="grid"><div class="loading">載入中...</div></div>', `<div id="grid" class="grid">${cards}</div>`)
    .replace('</head>', `${head}\n${ssrArticles}\n</head>`);
}

function injectListMeta(template, articles) {
  const url = `${SITE}/articles`;
  const title = '文章目錄 — 漫途旅遊誌';
  const desc = '漫途旅遊誌全部文章目錄：精選台灣各地咖啡廳、美食餐廳、旅遊景點與生活風格推薦文章。';
  const head = [
    `<link rel="canonical" href="${url}">`,
    `<meta name="description" content="${escapeHtml(desc)}">`,
    buildOgBlock({ title, desc, url, image: DEFAULT_OG }),
    ldScript({
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: title, description: desc, url,
      isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE },
    }),
  ].join('\n');
  // SSR：把列表資料 inline 進 HTML，前端不必再打 Supabase（解決列表頁等 Supabase 卡住）
  const ssrList = articles
    ? `<script id="__ssr_articles" type="application/json">${JSON.stringify(articles).replace(/</g, '\\u003c')}</script>`
    : '';
  // articles/index.html 只有 <title>，無 meta-desc/canonical 佔位 → 全部插入 </head> 前
  return template.replace('</head>', `${head}\n${ssrList}\n</head>`);
}

// ── 地區專區 SSR（/kenting 等）：整頁 server 產出，模板 area.html 無 client JS ──
function injectArea(template, key, area, articles) {
  const url = `${SITE}/${key}`;
  const bySlug = new Map(articles.map((a) => [a.slug, a]));
  const used = new Set();
  const groups = area.groups.map((g) => {
    const list = g.slugs.map((s) => bySlug.get(s)).filter(Boolean);
    list.forEach((a) => used.add(a.slug));
    return { ...g, list };
  });
  // 前綴相符但還沒排進分組的新文章 → 自動收進「更多」組，不會漏
  const rest = articles.filter((a) => !used.has(a.slug));
  if (rest.length) groups.push({ title: `更多${area.name}文章`, note: '', list: rest });
  const ordered = groups.flatMap((g) => g.list);
  const n = ordered.length;
  const title = area.title(n);
  const ogImage = (ordered.find((a) => a.cover_image) || {}).cover_image || DEFAULT_OG;

  const fmtDate = (s) => {
    if (!s) return '';
    const d = new Date(s);
    return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  const card = (a) => {
    const img = a.cover_image
      ? `<img class="card-img" src="${escapeHtml(a.cover_image)}" alt="${escapeHtml(a.title || '')}" loading="lazy">`
      : `<div class="card-img">${escapeHtml(a.emoji || '📝')}</div>`;
    return `<a class="card" href="/articles/${escapeHtml(a.slug)}">${img}`
      + `<div class="card-body"><div class="card-meta">`
      + (a.category ? `<span class="card-tag">${escapeHtml(a.category)}</span>` : '')
      + `<span>${escapeHtml(fmtDate(a.published_at))}</span></div>`
      + `<div class="card-title">${escapeHtml(a.title || '')}</div>`
      + `<div class="card-excerpt">${escapeHtml(a.excerpt || '')}</div></div></a>`;
  };

  const crumbs = [
    { name: '首頁', item: `${SITE}/` },
    { name: area.city, item: `${SITE}/${area.citySlug}` },
    { name: area.name, item: url },
  ];
  const hero = `<nav class="crumb" aria-label="麵包屑"><a href="/">首頁</a><span>›</span>`
    + `<a href="/${area.citySlug}">${escapeHtml(area.city)}</a><span>›</span>${escapeHtml(area.name)}</nav>`
    + `<div class="hero-label">地區專區 · ${escapeHtml(area.city)}</div>`
    + `<h1>${escapeHtml(area.h1)}</h1>`
    + `<p class="hero-sub">${escapeHtml(area.sub(n))}</p>`;

  // 分區速查：只連到有上線的文章
  const zoneHtml = area.zones.map(([name, desc, links]) => {
    const ls = links.filter(([s]) => bySlug.has(s))
      .map(([s, label]) => `<a href="/articles/${escapeHtml(s)}">${escapeHtml(label)} →</a>`).join('');
    return `<div class="zone"><div class="zone-name">${escapeHtml(name)}</div>`
      + `<div class="zone-desc">${escapeHtml(desc)}</div>`
      + (ls ? `<div class="zone-links">${ls}</div>` : '') + '</div>';
  }).join('');

  const groupHtml = groups.filter((g) => g.list.length).map((g) => `<section class="sec">`
    + `<h2>${escapeHtml(g.title)}</h2>`
    + (g.note ? `<p class="sec-note">${escapeHtml(g.note)}</p>` : '')
    + `<div class="grid">${g.list.map(card).join('')}</div></section>`).join('');

  const tipsHtml = area.tips.map(([k, v]) => `<li><b>${escapeHtml(k)}｜</b>${escapeHtml(v)}</li>`).join('');

  const body = `<div class="intro">${area.intro.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</div>`
    + `<section class="sec"><h2>${escapeHtml(area.name)}分區速查：每一區適合做什麼</h2><div class="zones">${zoneHtml}</div></section>`
    + (groupHtml || '<div class="empty">文章載入失敗，請稍後重新整理</div>')
    + `<section class="sec"><h2>出發前先知道</h2><ul class="tips">${tipsHtml}</ul></section>`;

  const head = [
    buildOgBlock({ title, desc: area.desc, url, image: ogImage }),
    ldScript([
      {
        '@context': 'https://schema.org', '@type': 'CollectionPage',
        name: title, description: area.desc, url,
        isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE },
        mainEntity: {
          '@type': 'ItemList', numberOfItems: n,
          itemListElement: ordered.map((a, i) => ({ '@type': 'ListItem', position: i + 1, url: `${SITE}/articles/${a.slug}`, name: a.title })),
        },
      },
      {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })),
      },
    ]),
  ].join('\n');

  return template
    .replace(/<meta name="robots" content="noindex" id="tmpl-noindex">\n?/, '')
    .replace(/<title id="page-title">[^<]*<\/title>/, () => `<title id="page-title">${escapeHtml(title)}</title>`)
    .replace(/<meta id="meta-desc"[^>]*>/, () => `<meta id="meta-desc" name="description" content="${escapeHtml(area.desc)}">`)
    .replace(/<link rel="canonical" id="canonical"[^>]*>/, () => `<link rel="canonical" id="canonical" href="${url}">`)
    .replace('<!--AREA_HERO-->', () => hero)
    .replace('<!--AREA_BODY-->', () => body)
    .replace('</head>', () => `${head}\n</head>`);
}

// ── 首頁 SSR：把文章卡／城市／主題連結產成真實 <a href> 注入 raw HTML（給 Google 爬） ──
function fmtHomeDate(d, big) {
  if (!d) return '';
  const t = new Date(d), y = t.getFullYear(), m = t.getMonth() + 1, day = t.getDate();
  return big ? `${y}年${m}月${day}日` : `${y}/${m}/${day}`;
}
function homeCard(a, n, big) {
  const cover = a.cover_image
    ? `<img class="ac-cover" src="${escapeHtml(a.cover_image)}" alt="${escapeHtml(a.title || '')}" loading="lazy">`
    : `<span class="ac-emoji">${escapeHtml(a.emoji || '✍️')}</span>`;
  const meta = [a.city, a.category].filter(Boolean).join(' · ') || '漫途';
  return `<a href="/articles/${escapeHtml(a.slug)}" class="ac${big ? ' ac-big' : ''}">`
    + `<div class="ac-n">No.${String(n).padStart(2, '0')}</div>${cover}`
    + `<div class="ac-meta">${escapeHtml(meta)}</div>`
    + `<div class="ac-ttl">${escapeHtml(a.title || '')}</div>`
    + `<div class="ac-exc">${escapeHtml(a.excerpt || '')}</div>`
    + `<div class="ac-ft"><span class="ac-dt">${fmtHomeDate(a.published_at, big)}</span>`
    + `<span class="ac-arr">${big ? '閱讀全文 →' : '→'}</span></div></a>`;
}
function homeAc(list) {
  if (!list.length) return '<div class="empty"><span class="empty-num">漫途</span>此地尚無文章</div>';
  const first = list[0], rest = list.slice(1), side = rest.slice(0, 1), small = rest.slice(1, 6);
  return `<div class="grid-main">${homeCard(first, 1, true)}${side.map((a, i) => homeCard(a, i + 2, false)).join('')}</div>`
    + (small.length ? `<div class="grid-small">${small.map((a, i) => homeCard(a, i + 3, false)).join('')}</div>` : '');
}
// 用字串定位填入容器內容（每個容器恰有 1 個佔位 div → 取第 2 個 </div> 為容器結尾）
function fillContainer(html, id, inner) {
  const marker = `id="${id}">`;
  const start = html.indexOf(marker);
  if (start < 0) return html;
  const openEnd = start + marker.length;
  const firstClose = html.indexOf('</div>', openEnd);
  if (firstClose < 0) return html;
  const secondClose = html.indexOf('</div>', firstClose + 6);
  if (secondClose < 0) return html;
  return html.slice(0, openEnd) + inner + html.slice(secondClose);
}
function injectHome(template, articles, regions, keywords) {
  const regionHtml = (regions || [])
    .map((r) => `<a class="region-chip" href="/${escapeHtml(r.slug)}"><span class="region-chip-name">${escapeHtml(r.name)}</span></a>`)
    .join('');
  const kwHtml = (keywords || [])
    .filter((k) => k.regions && k.regions.slug)
    .map((k) => `<a class="kw-chip" href="/${escapeHtml(k.regions.slug)}/${escapeHtml(k.slug)}">${escapeHtml((k.regions.name || '') + k.name)}</a>`)
    .join('');
  const ssr = `<script id="__ssr_articles" type="application/json">${JSON.stringify(articles || []).replace(/</g, '\\u003c')}</script>`;
  let html = template.replace('</head>', `${ssr}\n</head>`);
  html = fillContainer(html, 'ac-container', homeAc(articles || []));
  html = fillContainer(html, 'hp-region-grid', regionHtml);
  html = fillContainer(html, 'hp-kw-grid', kwHtml);
  return html;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 強制 https：避免 http:// 與 https:// 同時可達被 Google 視為重複網頁（本機 dev 例外）
      if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        url.protocol = 'https:';
        return new Response(null, {
          status: 301,
          headers: withSec({
            Location: url.toString(),
            'Cache-Control': 'public, max-age=86400',
          }),
        });
      }

      // favicon.ico → 直接服務網站圖示 PNG（避免 404，讓 Google 搜尋結果能顯示小圖示）
      if (path === '/favicon.ico') {
        return env.ASSETS.fetch(new Request(new URL('/favicon-192.png', url.origin).toString(), { method: 'GET' }));
      }

      // 統一 URL 形式：結尾 / 一律 301 到無斜線版（root / 除外），避免 /articles 與 /articles/、/tainan 與 /tainan/ 同時可達造成 canonical 重複
      if (path !== '/' && path.endsWith('/')) {
        const stripped = path.replace(/\/+$/, '');
        return new Response(null, {
          status: 301,
          headers: withSec({
            Location: `${SITE}${stripped}${url.search}`,
            'Cache-Control': 'public, max-age=86400',
          }),
        });
      }

      if (path === '/sitemap.xml') {
        const { xml, articleCount, totalEntries } = await buildSitemap();
        return new Response(xml, {
          status: 200,
          headers: withSec({
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600, s-maxage=3600',
            'X-Generated-By': 'worker',
            'X-Article-Count': String(articleCount),
            'X-Total-Entries': String(totalEntries),
          }),
        });
      }

      if (path === '/') {
        try {
          const tmpl = await loadTemplate(env, url.origin, '/');
          let articles = [], regions = [], keywords = [];
          try {
            [articles, regions, keywords] = await Promise.all([
              sb('articles?select=title,slug,city,category,excerpt,cover_image,emoji,published_at&status=eq.published&order=published_at.desc&limit=18'),
              sb('regions?select=name,slug&order=sort_order'),
              sb('keywords?select=name,slug,regions(name,slug)&order=sort_order'),
            ]);
          } catch (e) { /* 資料失敗 → 只注入 meta、內容由前端渲染 */ }
          const ogImage = (articles.find((a) => a.cover_image) || {}).cover_image || '';
          let html = injectHomeMeta(tmpl, ogImage);
          html = injectHome(html, articles, regions, keywords);
          return new Response(html, {
            status: 200,
            headers: withSec({
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=300, s-maxage=600',
              'X-Generated-By': 'worker-ssr-home',
            }),
          });
        } catch (e) {
          return passAsset(env, request);
        }
      }

      if (path === '/articles' || path === '/articles/') {
        try {
          const tmpl = await loadTemplate(env, url.origin, '/articles/');
          // 只撈列表需要的欄位（不抓 content），避免一次拉回所有文章內文
          let listArticles = null;
          try {
            listArticles = await sb('articles?select=id,slug,title,excerpt,cover_image,city,category,emoji,published_at&status=eq.published&order=published_at.desc&limit=100');
          } catch (e) { listArticles = null; }
          const html = injectListMeta(tmpl, listArticles);
          return new Response(html, {
            status: 200,
            headers: withSec({
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'public, max-age=300, s-maxage=600',
              'X-Generated-By': 'worker-ssr-list',
            }),
          });
        } catch (e) {
          return passAsset(env, request);
        }
      }

      if (path.startsWith('/articles/') && path !== '/articles/' && !path.endsWith('.html') && !path.includes('/', 10)) {
        const slug = decodeURIComponent(path.slice(10));

        if (SLUG_REDIRECTS[slug]) {
          return new Response(null, {
            status: 301,
            headers: withSec({
              Location: `${SITE}/articles/${SLUG_REDIRECTS[slug]}`,
              'Cache-Control': 'public, max-age=86400',
            }),
          });
        }

        try {
          const articles = await sb(
            `articles?select=*&slug=eq.${encodeURIComponent(slug)}&status=eq.published&limit=1`
          );
          if (articles.length) {
            const art = articles[0];
            // 相關文章：同城市 + 同分類，依相關度排序（同城 2 分 + 同類 1 分）取 6 篇
            let related = [];
            try {
              const conds = [];
              if (art.city) conds.push(`city.eq.${encodeURIComponent(art.city)}`);
              if (art.category) conds.push(`category.eq.${encodeURIComponent(art.category)}`);
              if (conds.length) {
                const rel = await sb(
                  `articles?select=slug,title,city,category,cover_image&status=eq.published`
                  + `&or=(${conds.join(',')})&slug=neq.${encodeURIComponent(slug)}`
                  + `&order=published_at.desc&limit=40`
                );
                related = rel
                  .map((r) => ({ r, s: (r.city === art.city ? 2 : 0) + (r.category === art.category ? 1 : 0) }))
                  .sort((a, b) => b.s - a.s)
                  .slice(0, 6)
                  .map((x) => x.r);
              }
            } catch (e) { related = []; }
            const tmpl = await loadTemplate(env, url.origin, '/articles/article');
            const html = injectArticleMeta(tmpl, art, slug, related);
            return new Response(html, {
              status: 200,
              headers: withSec({
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public, max-age=300, s-maxage=600',
                'X-Generated-By': 'worker-ssr',
                'X-Article-Slug': slug,
              }),
            });
          }
          // 文章不存在 → 回 404（不是 200 SPA 殼），避免 Google 標成「轉址式 404 / soft 404」
          const r = await env.ASSETS.fetch(new Request(new URL('/articles/article', url.origin).toString(), { method: 'GET' }));
          const buf = await r.arrayBuffer();
          return new Response(buf, {
            status: 404,
            statusText: 'Not Found',
            headers: withSec({ 'Content-Type': 'text/html; charset=utf-8' }),
          });
        } catch (e) {
          // DB 出錯（暫時性）→ 維持 SPA fallback、不要 404
          return passAsset(env, new Request(new URL('/articles/article', url.origin).toString(), { method: 'GET' }));
        }
      }

      // 地區專區（/kenting 等）：只撈前綴相符的文章，整頁 SSR
      const areaKey = path.slice(1);
      if (Object.prototype.hasOwnProperty.call(AREAS, areaKey)) {
        const area = AREAS[areaKey];
        let articles = [];
        try {
          articles = await sb(
            `articles?select=title,slug,city,category,excerpt,cover_image,emoji,published_at&status=eq.published`
            + `&slug=like.${encodeURIComponent(area.slugPrefix)}*&order=published_at.desc&limit=60`
          );
        } catch (e) { articles = []; }
        const tmpl = await loadTemplate(env, url.origin, '/area');
        const html = injectArea(tmpl, areaKey, area, articles);
        return new Response(html, {
          status: 200,
          headers: withSec({
            'Content-Type': 'text/html; charset=utf-8',
            // 文章撈失敗時別讓邊緣快取把空頁留 10 分鐘
            'Cache-Control': articles.length ? 'public, max-age=300, s-maxage=600' : 'no-store',
            'X-Generated-By': 'worker-ssr-area',
          }),
        });
      }

      const cityMatch = path.match(/^\/([^\/]+)(?:\/.+)?\/?$/);
      if (cityMatch && CITY_SET.has(cityMatch[1])) {
        const citySlug = cityMatch[1];
        const segs = path.replace(/^\/+|\/+$/g, '').split('/');
        // 純城市頁 (/{city}) 與分類子頁 (/{city}/{keyword}) 都 SSR
        if (segs.length === 1 || segs.length === 2) {
          try {
            const regions = await sb(
              `regions?select=id,name,slug&slug=eq.${encodeURIComponent(citySlug)}&limit=1`
            );
            if (regions.length) {
              const region = regions[0];
              const cityName = region.name;
              const keywords = await sb(
                `keywords?select=id,name,slug&region_id=eq.${region.id}&order=sort_order`
              ).catch(() => []);
              let activeKw = null;
              if (segs.length === 2) {
                activeKw = keywords.find((k) => k.slug === segs[1]) || null;
                // 未知分類 slug → 交給 client shell（不 SSR 錯誤 canonical）
                if (!activeKw) {
                  return passAsset(env, new Request(new URL('/city', url.origin).toString(), { method: 'GET' }));
                }
              }
              let articles = [];
              try {
                const q = activeKw
                  ? `articles?select=title,slug,city,category,excerpt,cover_image,emoji,published_at&status=eq.published&keyword_id=eq.${activeKw.id}&order=published_at.desc&limit=30`
                  : `articles?select=title,slug,city,category,excerpt,cover_image,emoji,published_at&status=eq.published&city=eq.${encodeURIComponent(cityName)}&order=published_at.desc&limit=30`;
                articles = await sb(q);
              } catch (e) { /* 無文章也可，ItemList 空 */ }
              const tmpl = await loadTemplate(env, url.origin, '/city');
              const html = injectCityMeta(tmpl, cityName, citySlug, articles, keywords, activeKw);
              return new Response(html, {
                status: 200,
                headers: withSec({
                  'Content-Type': 'text/html; charset=utf-8',
                  'Cache-Control': 'public, max-age=300, s-maxage=600',
                  'X-Generated-By': activeKw ? 'worker-ssr-city-kw' : 'worker-ssr-city',
                  'X-City-Slug': citySlug,
                }),
              });
            }
          } catch (e) { /* 失敗就 fallthrough 到 client-side shell */ }
        }
        return passAsset(env, new Request(new URL('/city', url.origin).toString(), { method: 'GET' }));
      }

      if (path === '/admin' || path === '/admin/') {
        return passAsset(env, new Request(new URL('/admin-v2', url.origin).toString(), { method: 'GET' }));
      }

      return passAsset(env, request);
    } catch (e) {
      return env.ASSETS.fetch(request);
    }
  },
};
