
export default async (request, context) => {
  const url = new URL(request.url);
  const ua = request.headers.get('user-agent') || '';
  
  // 只有爬蟲才走 Edge Function，一般用戶直接通過
  const isCrawler = /facebookexternalhit|twitterbot|linkedinbot|whatsapp|telegrambot|slackbot|discordbot|line-poker|vkshare/i.test(ua);
  if (!isCrawler) return context.next();

  // 從 URL 取得 slug
  const slug = url.pathname.replace('/articles/', '').replace(/\/$/, '');
  if (!slug) return context.next();

  try {
    // 從 Supabase 抓文章資料
    const sbUrl = 'https://zsebcpfblecwumbaxeaz.supabase.co/rest/v1/articles?slug=eq.' + encodeURIComponent(slug) + '&select=title,excerpt,cover_image,city,category';
    const res = await fetch(sbUrl, {
      headers: {
        'apikey': 'sb_publishable_L2DOfeM0cAJqwlVCr1LwtA_jE9MBNDn',
        'Authorization': 'Bearer sb_publishable_L2DOfeM0cAJqwlVCr1LwtA_jE9MBNDn'
      }
    });
    const data = await res.json();
    const article = data?.[0];
    if (!article) return context.next();

    const title = article.title + ' — 漫途旅遊誌';
    const desc = article.excerpt || article.title;
    const image = article.cover_image || 'https://journeylift.com.tw/og-default.jpg';
    const pageUrl = 'https://journeylift.com.tw' + url.pathname;

    // 回傳含 OG 標籤的 HTML
    const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="漫途旅遊誌">
<meta property="og:url" content="${pageUrl}">
<meta property="og:title" content="${article.title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${article.title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${image}">
<link rel="canonical" href="${pageUrl}">
</head>
<body>
<script>location.href="${pageUrl}"<\/script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'content-type': 'text/html;charset=UTF-8', 'cache-control': 'public,max-age=3600' }
    });
  } catch(e) {
    return context.next();
  }
};

export const config = { path: '/articles/:slug' };
