'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { cookieSite } = require('./browser-cookies');

const GROUPS = {
  'youtube.com': ['youtube.com', 'youtu.be', 'google.com', 'googlevideo.com'],
  'bilibili.com': ['bilibili.com', 'b23.tv', 'bilivideo.com'],
  'douyin.com': ['douyin.com', 'iesdouyin.com', 'douyinvod.com'],
  'xiaohongshu.com': ['xiaohongshu.com', 'xhslink.com'],
  'x.com': ['x.com', 'twitter.com', 'twimg.com'],
  'yangshipin.cn': ['yangshipin.cn'],
};

function safeCookies(url, input) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请选择网站页面');
  const site = cookieSite(url);
  if (!site || !Array.isArray(input) || input.length > 300) throw new Error('网站会话无效或过多');
  const domains = GROUPS[site] || [site];
  const seen = new Set(), output = [];
  for (const c of input) {
    if (!c || typeof c.domain !== 'string' || typeof c.name !== 'string' || typeof c.value !== 'string') throw new Error('网站会话格式无效');
    const domain = c.domain.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
    if (domain.split('.').length < 2 || !domains.some(d => domain === d || domain.endsWith('.' + d) || d.endsWith('.' + domain))) continue;
    if (c.name.length > 1024 || c.value.length > 16384 || typeof c.path !== 'string' || !c.path.startsWith('/') || c.path.length > 2048) throw new Error('网站会话格式无效');
    const expires = c.session || !Number.isFinite(c.expirationDate) ? null : Math.floor(c.expirationDate);
    if (expires !== null && expires <= Date.now()/1000) continue;
    const key = domain + '\0' + c.path + '\0' + c.name;
    if (seen.has(key)) continue; seen.add(key);
    output.push({version:0,name:c.name,value:c.value,port:null,port_specified:false,domain:c.domain,
      domain_specified:!c.hostOnly,domain_initial_dot:c.domain.startsWith('.'),path:c.path,path_specified:true,
      secure:!!c.secure,expires,discard:!!c.session,comment:null,comment_url:null,rfc2109:false,
      rest:c.httpOnly?{HttpOnly:null}:{}});
  }
  if (!output.length) throw new Error('当前网站没有可用的 Cookie，请先登录后重试');
  return {version:1,browser:'extension',site,cookies:output};
}

function timingEqual(a,b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && crypto.timingSafeEqual(x,y);
}

function protectJson(data) {
  return new Promise((resolve,reject) => {
    const exe=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const script=path.join(__dirname,'protect-cookie-cache.ps1');
    const p=spawn(exe,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err=''; const timer=setTimeout(()=>p.kill(),10000);
    p.stdout.on('data',x=>{out+=x.toString('ascii');if(out.length>200000)p.kill();});
    p.stderr.on('data',x=>{err+=x.toString('utf8').slice(0,1000);});
    p.on('error',e=>{clearTimeout(timer);reject(e);});
    p.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(new Error('Windows 加密保存失败'));try {const b=Buffer.from(out.trim(),'base64');if(!b.length)throw Error();resolve(b);}catch{reject(new Error('Windows 加密保存失败'));}});
    p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify(data),'utf8');
  });
}

function createExtensionBridge({root, local=process.env.LOCALAPPDATA, protect=protectJson, now=Date.now}={}) {
  const id=fs.readFileSync(path.join(root,'browser-extension','extension-id.txt'),'utf8').trim();
  if (!/^[a-p]{32}$/.test(id)) throw new Error('扩展配置无效');
  const origin='chrome-extension://'+id;
  if (!local) throw new Error('无法确定本机应用数据目录');
  const dir=path.join(local,'视频下载器','浏览器会话');
  const pairFile=path.join(dir,'extension-pair.json');
  let pairCode='',expires=0,failures=0;
  function issueCode() { pairCode=String(crypto.randomInt(0,100000000)).padStart(8,'0');expires=now()+10*60*1000;failures=0;return pairCode; }
  function currentKeys() { try {const x=JSON.parse(fs.readFileSync(pairFile,'utf8'));return Array.isArray(x.keys)?x.keys.filter(k=>typeof k==='string'):[];}catch{return [];} }
  function pair(code) {
    if (!pairCode || now()>expires || failures>=8 || !timingEqual(code,pairCode)) {failures++;throw new Error('配对码无效或已过期，请重新获取');}
    pairCode='';expires=0;const key=crypto.randomBytes(32).toString('base64url');fs.mkdirSync(dir,{recursive:true});
    const keys=currentKeys().slice(-7);keys.push(key);
    fs.writeFileSync(pairFile,JSON.stringify({version:1,keys}),{encoding:'utf8',mode:0o600});return key;
  }
  async function sync(key, url, cookies) {
    const stored=currentKeys();if(!stored.some(k=>timingEqual(key,k))) {const e=new Error('请先配对扩展');e.statusCode=403;throw e;}
    const data=safeCookies(url,cookies); const bytes=await protect(data);
    fs.mkdirSync(dir,{recursive:true});const final=path.join(dir,`extension--${data.site}.bin`);
    const temp=path.join(dir,'.extension-'+crypto.randomBytes(12).toString('hex')+'.tmp');
    try { fs.writeFileSync(temp,bytes,{flag:'wx'});fs.renameSync(temp,final); }
    finally {try{fs.unlinkSync(temp);}catch{}}
    return data.site;
  }
  return {origin,issueCode,pair,sync};
}
module.exports={createExtensionBridge,safeCookies};
