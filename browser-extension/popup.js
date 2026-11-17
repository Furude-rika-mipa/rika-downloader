'use strict';
const groups={
  'youtube.com':['youtube.com','youtu.be','google.com','googlevideo.com'],
  'bilibili.com':['bilibili.com','b23.tv','bilivideo.com'],
  'douyin.com':['douyin.com','iesdouyin.com','douyinvod.com'],
  'xiaohongshu.com':['xiaohongshu.com','xhslink.com'],
  'x.com':['x.com','twitter.com','twimg.com'],
  'yangshipin.cn':['yangshipin.cn']
};
const $=id=>document.getElementById(id), status=$('status');
function show(message,kind=''){status.textContent=message;status.className=kind;}
async function post(port,route,data){
  let response;
  try {response=await fetch(`http://127.0.0.1:${port}/api/extension/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(12000)});}
  catch {throw new Error('无法连接下载器，请确认它已打开；端口变化时请重新配对。');}
  const result=await response.json();if(!response.ok)throw new Error(result.err||'操作失败，请重试');return result;
}
$('pair').addEventListener('click',async()=>{
  const match=$('code').value.trim().match(/^(\d{4,5})-(\d{8})$/);
  if(!match || Number(match[1]) < 1024 || Number(match[1]) > 65535)return show('请输入下载器提供的完整配对码。','error');
  $('pair').disabled=true;
  try {const port=Number(match[1]);const result=await post(port,'pair',{code:match[2]});
    if(typeof result.key!=='string'||result.key.length<32)throw new Error('配对失败');
    await chrome.storage.local.set({port,key:result.key});$('code').value='';show('连接成功。打开需要下载的网站后，点击下方按钮。','success');
  }catch(e){show(e.message,'error');}finally{$('pair').disabled=false;}
});
$('sync').addEventListener('click',async()=>{
  $('sync').disabled=true;
  try{
    const saved=await chrome.storage.local.get(['port','key']);
    if(!saved.port||!saved.key)throw new Error('请先输入配对码并连接下载器。');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    let url;try{url=new URL(tab.url);}catch{throw new Error('请先打开需要下载的网站。');}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('请先打开需要下载的网站。');
    const host=url.hostname.toLowerCase();
    const related=Object.values(groups).find(list=>list.some(domain=>host===domain||host.endsWith('.'+domain)))||[host];
    const batches=await Promise.all([chrome.cookies.getAll({url:url.href}),...related.map(domain=>chrome.cookies.getAll({domain}))]);
    const unique=new Map();for(const batch of batches)for(const c of batch)unique.set([c.storeId,c.domain,c.path,c.name,JSON.stringify(c.partitionKey||'')].join('\0'),c);
    const cookies=[...unique.values()].map(({domain,name,value,path,secure,httpOnly,hostOnly,session,expirationDate})=>({domain,name,value,path,secure,httpOnly,hostOnly,session,expirationDate}));
    const result=await post(saved.port,'sync',{key:saved.key,url:url.origin,cookies});
    show(`已同步 ${result.site}，现在可以在下载器中下载。`,'success');
  }catch(e){show(e.message,'error');}finally{$('sync').disabled=false;}
});
