// 漫途旅遊誌 — Cloudflare Worker (minimal)
// Provides only: original /articles/{numeric-id} routing + global security headers
// Dynamic sitemap, SSR meta and city routing intentionally removed pending careful redo.

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

async function passWithSecurity(env, request) {
  const r = await env.ASSETS.fetch(request);
  const buf = await r.arrayBuffer();
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(buf, { status: r.status, statusText: r.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (/^\/articles\/\d+$/.test(path)) {
      const articleUrl = new URL('/articles/article.html', url.origin);
      const assetReq = new Request(articleUrl.toString(), request);
      return passWithSecurity(env, assetReq);
    }

    return passWithSecurity(env, request);
  },
};
