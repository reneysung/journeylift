exports.handler = async function(event) {
  const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:CORS, body:'' };
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const OWNER = 'reneysung', REPO = 'journeylift';
  if (!GITHUB_TOKEN) return { statusCode:500, headers:CORS, body:JSON.stringify({error:'GITHUB_TOKEN 未設定'}) };
  try {
    const { filename, content } = JSON.parse(event.body);
    const compressed = content.replace(/<style[\s\S]*?<\/style>/gi,'').replace(/src="data:image\/[^"]{50,}"/g,'src=""').replace(/\s{2,}/g,' ').trim();
    const encodedContent = Buffer.from(compressed).toString('base64');
    let sha = null;
    try { const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${filename}`,{headers:{'Authorization':'Bearer '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json'}}); if(r.ok){const d=await r.json();sha=d.sha;} } catch(e){}
    const body = { message:`發布文章：${filename}`, content:encodedContent };
    if (sha) body.sha = sha;
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${filename}`,{method:'PUT',headers:{'Authorization':'Bearer '+GITHUB_TOKEN,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json'},body:JSON.stringify(body)});
    const data = await res.json();
    return { statusCode:res.status, headers:CORS, body:JSON.stringify({ok:res.ok,status:res.status,url:data.content?.html_url}) };
  } catch(err) { return { statusCode:500, headers:CORS, body:JSON.stringify({error:err.message}) }; }
};