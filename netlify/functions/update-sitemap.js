const https = require('https');

const SUPA_URL = 'zsebcpfblecwumbaxeaz.supabase.co';
const SUPA_KEY = 'sb_publishable_L2DOfeM0cAJqwlVCr1LwtA_jE9MBNDn';
const REPO = 'reneysung/journeylift';
const BASE = 'https://journeylift.com.tw';

function sbFetch(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPA_URL,
      path: '/rest/v1/' + path,
      headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function ghFetch(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: 'token ' + token,
        'User-Agent': 'journeylift-sitemap',
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': 'https://journeylift.com.tw',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) return { statusCode: 500, headers, body: JSON.stringify({ error: 'No GH token' }) };

  try {
    const today = new Date().toISOString().split('T')[0];
    const [regions, keywords, articles] = await Promise.all([
      sbFetch('regions?select=slug&order=slug'),
      sbFetch('keywords?select=slug,regions(slug)&order=slug'),
      sbFetch('articles?select=slug,published_at&status=eq.published&order=published_at.desc'),
    ]);

    const urls = [];
    urls.push('  <url><loc>' + BASE + '</loc><changefreq>daily</changefreq><priority>1.0</priority></url>');
    urls.push('  <url><loc>' + BASE + '/articles</loc><changefreq>daily</changefreq><priority>0.9</priority></url>');
    regions.forEach(r => urls.push('  <url><loc>' + BASE + '/' + r.slug + '</loc><changefreq>weekly</changefreq><priority>0.8</priority><lastmod>' + today + '</lastmod></url>'));
    keywords.forEach(k => {
      if (k.regions && k.regions.slug) urls.push('  <url><loc>' + BASE + '/' + k.regions.slug + '/' + k.slug + '</loc><changefreq>weekly</changefreq><priority>0.7</priority><lastmod>' + today + '</lastmod></url>');
    });
    articles.forEach(a => {
      const lm = a.published_at ? a.published_at.split('T')[0] : today;
      urls.push('  <url><loc>' + BASE + '/articles/' + a.slug + '</loc><changefreq>monthly</changefreq><priority>0.6</priority><lastmod>' + lm + '</lastmod></url>');
    });

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.join('\n') + '\n</urlset>';
    const b64 = Buffer.from(xml, 'utf-8').toString('base64');

    // Get current sha
    const current = await ghFetch('GET', '/repos/' + REPO + '/contents/sitemap.xml', null, token);
    const sha = current.sha;

    // Push updated sitemap
    await ghFetch('PUT', '/repos/' + REPO + '/contents/sitemap.xml', {
      message: 'auto: update sitemap after publish',
      content: b64,
      sha
    }, token);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, urls: urls.length }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
