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
  ['taichung', 0.9], ['nantou', 0.8], ['chiayi', 0.8], ['tainan', 0.9],
  ['kaohsiung', 0.9], ['pingtung', 0.8], ['yilan', 0.8], ['hualien', 0.8],
  ['taitung', 0.8], ['keelung', 0.8], ['kinmen', 0.8], ['penghu', 0.8],
];
const CITY_SET = new Set(CITIES.map((c) => c[0]));

const SLUG_REDIRECTS = {
  '-1774017366618': 'kaohsiung-pier2-warehouse-cafe',
  '-sm0m': 'taipei-daan-green-light-cafe',
  '-1774011508378': 'tainan-chihkan-old-well-cafe',
  '202610-1774019872644': 'tainan-renovation-cleaning-2026',
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

function injectArticleMeta(template, article, slug) {
  const url = `${SITE}/articles/${slug}`;
  const fullTitle = `${article.title} — ${SITE_NAME}`;
  const desc = (article.excerpt || article.title || '').slice(0, 160);
  const image = article.cover_image || DEFAULT_OG;
  const published = article.published_at || article.created_at;
  const updated = article.updated_at || published;

  // SSR：把整個 article inline 進 HTML，前端不必再打 Supabase
  // （解決內文渲染要等 Supabase 冷啟動/逾時、整篇空白卡住的問題）
  const ssrData = `<script id="__ssr_article" type="application/json">${JSON.stringify(article).replace(/</g, '\\u003c')}</script>`;

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
    + '<div class="art-footer"><a href="/articles" class="back-btn">← 返回文章列表</a></div>';

  const jsonLd = JSON.stringify({
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
  });

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
    .replace('</head>', `${ssrData}\n</head>`)
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
  const title = '漫途 — 生活旅遊誌｜用文字記錄每一段旅程';
  const desc = '漫途旅遊誌，用文字記錄每一段值得被記住的旅程。';
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

function injectCityMeta(template, cityName, citySlug, articles) {
  const url = `${SITE}/${citySlug}`;
  const title = `${cityName}旅遊美食攻略 — 漫途生活旅遊誌`;
  const desc = `探索${cityName}最值得一訪的咖啡廳、美食餐廳與生活風格，精選在地推薦文章。`;
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
  return template
    .replace(/<title id="page-title">[^<]*<\/title>/, `<title id="page-title">${escapeHtml(title)}</title>`)
    .replace(/<meta id="meta-desc"[^>]*>/, `<meta id="meta-desc" name="description" content="${escapeHtml(desc)}">`)
    .replace(/<link rel="canonical" id="canonical"[^>]*>/, `<link rel="canonical" id="canonical" href="${url}">`)
    // SSR H1：把靜態「載入中...」換成城市名，讓不執行 JS 的爬蟲讀到正確主標題
    .replace(/<h1 id="city-name">[^<]*<\/h1>/, `<h1 id="city-name">${escapeHtml(cityName)}</h1>`)
    .replace('</head>', `${head}\n</head>`);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 強制 https：避免 http:// 與 https:// 同時可達被 Google 視為重複網頁
      if (url.protocol === 'http:') {
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
          let ogImage = '';
          try {
            const latest = await sb(
              'articles?select=cover_image&status=eq.published&cover_image=not.is.null&order=published_at.desc&limit=1'
            );
            ogImage = latest[0]?.cover_image || '';
          } catch (e) { /* og:image 省略即可 */ }
          const html = injectHomeMeta(tmpl, ogImage);
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
            const tmpl = await loadTemplate(env, url.origin, '/articles/article');
            const html = injectArticleMeta(tmpl, articles[0], slug);
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

      const cityMatch = path.match(/^\/([^\/]+)(?:\/.+)?\/?$/);
      if (cityMatch && CITY_SET.has(cityMatch[1])) {
        const citySlug = cityMatch[1];
        const segs = path.replace(/^\/+|\/+$/g, '').split('/');
        if (segs.length === 1) {
          // 純城市頁 → SSR meta（子頁 /{city}/{keyword} 維持 client-side，避免錯誤 canonical）
          try {
            const regions = await sb(
              `regions?select=name,slug&slug=eq.${encodeURIComponent(citySlug)}&limit=1`
            );
            if (regions.length) {
              const cityName = regions[0].name;
              let articles = [];
              try {
                articles = await sb(
                  `articles?select=title,slug,cover_image&status=eq.published&city=eq.${encodeURIComponent(cityName)}&order=published_at.desc&limit=20`
                );
              } catch (e) { /* 無文章也可，ItemList 空 */ }
              const tmpl = await loadTemplate(env, url.origin, '/city');
              const html = injectCityMeta(tmpl, cityName, citySlug, articles);
              return new Response(html, {
                status: 200,
                headers: withSec({
                  'Content-Type': 'text/html; charset=utf-8',
                  'Cache-Control': 'public, max-age=300, s-maxage=600',
                  'X-Generated-By': 'worker-ssr-city',
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
