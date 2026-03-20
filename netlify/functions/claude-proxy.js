const CORS={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'Content-Type,x-api-key',
  'Access-Control-Allow-Methods':'POST,OPTIONS',
  'Content-Type':'application/json'
};

exports.handler=async function(event){
  if(event.httpMethod==='OPTIONS')return{statusCode:200,headers:CORS,body:''};
  if(event.httpMethod!=='POST')return{statusCode:405,headers:CORS,body:'Method Not Allowed'};

  const API_KEY=process.env.ANTHROPIC_API_KEY;
  if(!API_KEY)return{statusCode:500,headers:CORS,body:JSON.stringify({error:'No API key'})};

  let body;
  try{body=JSON.parse(event.body);}catch(e){return{statusCode:400,headers:CORS,body:JSON.stringify({error:'Invalid JSON'})}}

  const max_tokens=Math.min(body.max_tokens||1000,1500);

  try{
    const resp=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key':API_KEY,
        'anthropic-version':'2023-06-01'
      },
      body:JSON.stringify({
        model:body.model||'claude-sonnet-4-5',
        max_tokens:max_tokens,
        messages:body.messages||[],
        system:body.system||undefined
      })
    });
    const data=await resp.json();
    return{statusCode:resp.status,headers:CORS,body:JSON.stringify(data)};
  }catch(e){
    return{statusCode:500,headers:CORS,body:JSON.stringify({error:e.message})};
  }
};