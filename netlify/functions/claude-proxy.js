exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, x-api-key, x-action','Access-Control-Allow-Methods':'POST, OPTIONS'}, body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const action = event.headers['x-action'] || 'generate';
  const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, x-api-key, x-action','Content-Type':'application/json'};

  // ── DEPLOY article via Netlify API ──
  if (action === 'deploy') {
    const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;
    const SITE_ID = '05bc81ec-adb1-422c-9c1e-8a22a41fa1f8';
    if (!NETLIFY_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'NETLIFY_TOKEN 未設定' }) };

    try {
      const { filename, content } = JSON.parse(event.body);

      // Step 1: Get site info to find published deploy
      const siteRes = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}`, {
        headers: { 'Authorization': 'Bearer ' + NETLIFY_TOKEN }
      });
      const siteData = await siteRes.json();

      if (!siteData.published_deploy) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: '找不到已發布的部署，site data: ' + JSON.stringify(siteData).slice(0,100) }) };
      }

      const deployId = siteData.published_deploy.id;

      // Step 2: Upload file to deploy
      const encoder = new TextEncoder();
      const fileBytes = encoder.encode(content);

      const uploadRes = await fetch(`https://api.netlify.com/api/v1/deploys/${deployId}/files/${filename}`, {
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer ' + NETLIFY_TOKEN,
          'Content-Type': 'application/octet-stream'
        },
        body: fileBytes
      });

      const uploadText = await uploadRes.text();
      let uploadData;
      try { uploadData = JSON.parse(uploadText); } catch(e) { uploadData = { raw: uploadText.slice(0,100) }; }

      return {
        statusCode: uploadRes.status,
        headers: CORS,
        body: JSON.stringify({ ok: uploadRes.ok, status: uploadRes.status, deployId, data: uploadData })
      };
    } catch (err) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message, stack: err.stack?.slice(0,200) }) };
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
