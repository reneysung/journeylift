export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // /articles/[anything-not-html] → serve articles/article.html
    // 覆蓋原本的 /articles/{numeric-id} + 所有字母數字、中文、連字號 slug
    if (path.startsWith('/articles/') && path !== '/articles/' && !path.endsWith('.html') && !path.includes('/', 10)) {
      const articleUrl = new URL('/articles/article.html', url.origin);
      const assetReq = new Request(articleUrl.toString(), request);
      return env.ASSETS.fetch(assetReq);
    }

    return env.ASSETS.fetch(request);
  }
};
