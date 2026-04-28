export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Article slug page → fetch the article template via its non-html alias to avoid html_handling 308 redirect
    if (path.startsWith('/articles/') && path !== '/articles/' && !path.endsWith('.html') && !path.includes('/', 10)) {
      const articleUrl = new URL('/articles/article', url.origin);
      const assetReq = new Request(articleUrl.toString(), request);
      return env.ASSETS.fetch(assetReq);
    }

    return env.ASSETS.fetch(request);
  }
};
