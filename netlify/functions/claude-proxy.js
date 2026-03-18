exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, x-api-key, x-action','Access-Control-Allow-Methods':'POST, OPTIONS'}, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const action = event.headers['x-action'] || 'generate';
  const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, x-api-key, x-action','Content-Type':'application/json'};

  // ── DEPLOY: commit article to GitHub ──
  if (action === 'deploy') {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const OWNER = 'reneysung';
    const REPO = 'journeylift';
    if (!GITHUB_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GITHUB_TOKEN 未設定' }) };

    try {
      const { filename, content } = JSON.parse(event.body);
      const encodedContent = Buffer.from(content).toString('base64');

      // Check if file already exists (to get SHA for update)
      let sha = null;
      const checkRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${filename}`, {
        headers: { 'Authorization': 'Bearer ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
      });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        sha = checkData.sha;
      }

      // Create or update file
      const body = { message: `發布文章：${filename}`, content: encodedContent };
      if (sha) body.sha = sha;

      const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${filename}`, {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + GITHUB_TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const data = await res.json();
      return {
        statusCode: res.status,
        headers: CORS,
        body: JSON.stringify({ ok: res.ok, status: res.status, url: data.content?.html_url })
      };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── GENERATE with Claude ──
  const API_KEY = event.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: 'API Key 未設定，請點右上角 ⚙ 設定' } }) };

  try {
    const body = JSON.parse(event.body);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    return { statusCode: response.status, headers: CORS, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: err.message } }) };
  }
};
