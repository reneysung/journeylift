export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // /articles/{numeric-id} → serve articles/article.html
    if (/^\/articles\/\d+$/.test(path)) {
      const articleUrl = new URL('/articles/article.html', url.origin);
      const assetReq = new Request(articleUrl.toString(), request);
      return env.ASSETS.fetch(assetReq);
    }

    // All other requests → pass through to ASSETS normally
    return env.ASSETS.fetch(request);
  }
};
