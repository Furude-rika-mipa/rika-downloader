'use strict';
const fs = require('fs');
const path = require('path');

const GROUPS = [
  ['youtube.com', ['youtube.com', 'youtu.be', 'google.com', 'googlevideo.com']],
  ['bilibili.com', ['bilibili.com', 'b23.tv', 'bilivideo.com']],
  ['douyin.com', ['douyin.com', 'iesdouyin.com', 'douyinvod.com']],
  ['xiaohongshu.com', ['xiaohongshu.com', 'xhslink.com']],
  ['x.com', ['x.com', 'twitter.com', 'twimg.com']],
  ['yangshipin.cn', ['yangshipin.cn']],
];

function cookieSite(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    if (!/^[a-z0-9.-]{1,253}$/.test(host)) return '';
    return GROUPS.find(([, domains]) => domains.some(domain => host === domain || host.endsWith('.' + domain)))?.[0] || host;
  } catch { return ''; }
}

function findCookieBrowsers(url, { local = process.env.LOCALAPPDATA || '', roaming = process.env.APPDATA || '', platform = process.platform } = {}) {
  if (platform !== 'win32') return [];
  const site = cookieSite(url);
  if (!site || !local) return [];
  const candidates = [
    ['extension', []],
    ['chrome', [path.join(local, 'Google', 'Chrome', 'User Data')]],
    ['edge', [path.join(local, 'Microsoft', 'Edge', 'User Data')]],
    ['brave', [path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')]],
    ['vivaldi', [path.join(local, 'Vivaldi', 'User Data')]],
    ['chromium', [path.join(local, 'Chromium', 'User Data')]],
    ['opera', roaming ? [path.join(roaming, 'Opera Software', 'Opera Stable')] : []],
    ['firefox', [
      ...(roaming ? [path.join(roaming, 'Mozilla', 'Firefox', 'Profiles')] : []),
      path.join(local, 'Packages', 'Mozilla.Firefox_n80bbvh6b1yt2', 'LocalCache', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'),
    ]],
  ];
  const cacheDir = path.join(local, '视频下载器', '浏览器会话');
  return candidates.map(([name, profiles], index) => {
    let cacheTime = 0, cached = false;
    try { const stat = fs.statSync(path.join(cacheDir, `${name}--${site}.bin`)); cached = stat.isFile(); cacheTime = stat.mtimeMs; } catch {}
    return { name, index, cached, cacheTime, installed: profiles.some(profile => fs.existsSync(profile)) };
  }).filter(candidate => candidate.cached || candidate.installed)
    .sort((a, b) => Number(b.cached) - Number(a.cached) || b.cacheTime - a.cacheTime || a.index - b.index)
    .map(candidate => candidate.name);
}

function describeCookieReadIssue(browser, message, empty) {
  const name = ({ extension: '浏览器扩展', chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', brave: 'Brave', vivaldi: 'Vivaldi', chromium: 'Chromium', opera: 'Opera' })[browser] || '浏览器';
  if (empty) return `${name} 没有该网站的可用会话`;
  if (/failed to decrypt|dpapi|app.bound/i.test(message)) return `${name} 的浏览器加密限制了会话读取`;
  if (/unable to open database|database is locked|could not copy .*cookie database|cookie.*(?:locked|permission denied)/i.test(message)) return `${name} 会话数据库无法打开，请完全退出浏览器后重试`;
  if (/could not find .*cookies|no such file/i.test(message)) return `${name} 未找到可读取的浏览器会话`;
  return '';
}

function findSavedCookieBrowsers(url, options = {}) {
  const local = options.local === undefined ? process.env.LOCALAPPDATA || '' : options.local;
  const site = cookieSite(url);
  if (!local || !site) return [];
  const dir = path.join(local, '视频下载器', '浏览器会话');
  return findCookieBrowsers(url, options).filter(name => {
    try { return fs.statSync(path.join(dir, `${name}--${site}.bin`)).isFile(); } catch { return false; }
  });
}

module.exports = { cookieSite, findCookieBrowsers, findSavedCookieBrowsers, describeCookieReadIssue };
