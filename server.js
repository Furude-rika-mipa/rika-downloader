#!/usr/bin/env node
/*
 * 视频下载器 · 本地下载服务
 * 贴链接(B站/YouTube/凡 yt-dlp 支持的站) → 选保存位置 → 下载,带实时进度。
 * Windows 启动脚本自动下载并校验 Node.js、yt-dlp 和 FFmpeg。
 * 只监听 127.0.0.1。分享源码启动包，不复制个人配置或运行目录(见 README)。
 */
'use strict';
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { once } = require('events');
const { finished } = require('stream/promises');
const { StringDecoder } = require('string_decoder');
const { verifiedRuntime } = require('./scripts/runtime');
const yangshipin = require('./scripts/yangshipin');
const { describeDownloadError, classifyAccessIssue } = require('./scripts/download-errors');
const { ShutdownCoordinator } = require('./scripts/shutdown');
const { findCookieBrowsers, findSavedCookieBrowsers, describeCookieReadIssue } = require('./scripts/browser-cookies');
const { createExtensionBridge } = require('./scripts/extension-bridge');
const { resolveRevealTarget } = require('./scripts/reveal-target');
const { MAX_HISTORY, snapshotHistory, restoreHistory } = require('./scripts/download-history');
const browserDiscovery = require('./scripts/browser-resolver');
const bilibiliDownload = require('./scripts/bilibili-download');
const twitterDownload = require('./scripts/twitter-download');
const { openAppWindow } = require('./scripts/app-window');
const { normalizeQuality, qualityArgs, qualitySuffix, resolutionSuffix } = require('./scripts/video-quality');

const CONF_PATH = path.join(__dirname, 'config.json');
const DEFAULT_DIR = path.join(os.homedir(), 'Downloads', '视频素材');
const APP_ID = 'video-downloader-desktop';
const BUNDLED_BIN = path.join(__dirname, 'bin');
const DEPENDENCIES = require('./dependencies.windows.json');
const INSTANCE_ID = crypto.createHash('sha256').update(path.resolve(__dirname).toLowerCase()).digest('hex').slice(0, 12);
const BUILD_ID = crypto.createHash('sha256').update([
  'server.js', 'scripts/yangshipin.js', 'scripts/download-errors.js', 'scripts/douyin-anonymous-resolver.js', 'scripts/browser-resolver.js', 'scripts/runtime.js', 'dependencies.windows.json',
  'scripts/bilibili-download.js', 'scripts/yt-dlp-plugins/video_downloader/yt_dlp_plugins/extractor/video_downloader_bilibili.py',
  'scripts/yt-dlp-plugins/video_downloader/yt_dlp_plugins/extractor/memory_browser_cookie.py',
  'scripts/yt-dlp-plugins/video_downloader/yt_dlp_plugins/extractor/cookie_store.py',
  'scripts/app-window.js', 'scripts/video-quality.js',
  'scripts/twitter-download.js', 'scripts/shutdown.js', 'scripts/browser-cookies.js',
  'scripts/extension-bridge.js', 'scripts/protect-cookie-cache.ps1',
  'scripts/reveal-target.js',
  'scripts/download-history.js',
].map(file => file + '\0' + fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\0')).digest('hex').slice(0, 12);
const API_TOKEN = crypto.randomBytes(32).toString('base64url');
const MAX_JSON_BODY = 64 * 1024;
const shutdownCoordinator = new ShutdownCoordinator();
let shuttingDown = false;
let extensionBridge;
function getExtensionBridge() { return extensionBridge ||= createExtensionBridge({ root: __dirname }); }
const DOUYIN_ANONYMOUS_RESOLVER = path.join(__dirname, 'scripts', 'douyin-anonymous-resolver.js');

// ── 环境探测 ──
const IS_WIN = process.platform === 'win32';
function which(bin) {
  if (IS_WIN) return verifiedRuntime(__dirname, bin + '.exe', bin === 'node' ? DEPENDENCIES.node.executableSha256 : DEPENDENCIES.ffmpeg.sha256);
  // 优先系统安装版(pip/brew 形式,冷启动秒开);没有再用自带 bundled(PyInstaller 打包版功能相同,但每次运行要解压自己、冷启动慢)
  const cands = [`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`, `/usr/bin/${bin}`, bin];
  for (const c of cands) {
    try { const r = spawnSync(c, ['--version'], { timeout: 6000 }); if (!r.error && r.status !== null) return c; } catch {}  // ffmpeg --version 退出码可能非0,能跑即算有
  }
  const bundled = path.join(BUNDLED_BIN, bin);
  try { fs.accessSync(bundled, fs.constants.X_OK); return bundled; } catch {}
  return null;
}
const FFMPEG = which('ffmpeg');
const JS_NODE = which('node');

function extractUrl(value) {
  const m = String(value || '').match(/https?:\/\/[^\s<>"'，。！？；、）)\]】}>》」』]+/i);
  return m ? m[0].replace(/[，。！？；、,)\]}>]+$/g, '') : '';
}

function inspectMedia(file) {
  if (!FFMPEG || !file || !fs.existsSync(file)) return { video: false, audio: false };
  const r = spawnSync(FFMPEG, ['-hide_banner', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,mpegts,avi,flv,ogg', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0', '-t', '0', '-f', 'null', '-'], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
  const text = String(r.stderr || '') + String(r.stdout || '');
  const dimensions = text.match(/Video:[^\r\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return { video: r.status === 0 && !r.error, audio: r.status === 0 && !r.error, container: text.match(/Input #0, (.+?), from /)?.[1] || '',
    width: dimensions ? Number(dimensions[1]) : 0, height: dimensions ? Number(dimensions[2]) : 0 };
}

async function finishVideoJob(job) {
  if (shuttingDown) throw new Error('下载服务正在关闭');
  if (job.dir && job.file && fs.existsSync(job.file)) {
    const relative = path.relative(fs.realpathSync(job.dir), fs.realpathSync(job.file));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('最终文件不在指定保存目录内');
  }
  let streams = inspectMedia(job.file);
  if (!streams.video || !streams.audio) throw new Error(!fs.existsSync(job.file) ? '下载结束但没有找到最终视频' : '最终文件缺少画面或声音');
  // Without a bundled ffprobe, yt-dlp may leave HLS transport streams named .mp4.
  // Remux only that case, preserving the original until the replacement is verified.
  if (streams.container === 'mpegts' && path.extname(job.file).toLowerCase() === '.mp4') {
    job.phase = '整理 MP4 格式';
    const temp = job.file + '.' + crypto.randomBytes(6).toString('hex') + '.remux.mp4';
    try {
      await new Promise((resolve, reject) => {
        if (shuttingDown) return reject(new Error('下载服务正在关闭'));
        const child = shutdownCoordinator.track(spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-n', '-i', job.file,
          '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', temp],
        { windowsHide: true, stdio: 'ignore', timeout: 180000 }));
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error('整理 MP4 失败，原下载文件已保留')));
      });
      streams = inspectMedia(temp);
      if (!streams.video || !streams.audio || !streams.container.includes('mp4')) throw new Error('整理后的 MP4 校验失败，原下载文件已保留');
      fs.renameSync(temp, job.file);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
  job.width = streams.width; job.height = streams.height;
  if (usesSavedSessionForBestQuality(job.url) && job.quality === '2160p' && streams.width && streams.height
      && Math.max(streams.width, streams.height) < 3840) {
    job.note = [job.note, '未获取到4K，已使用可用画质'].filter(Boolean).join(' · ');
  }
  job.status = 'done'; job.pct = 100; job.merging = false; job.phase = '完成';
}

// Windows 固定使用启动脚本按清单校验的 yt-dlp.exe，避免残留 zipapp 抢占引擎。
// 非 Windows 保留 python3 + zipapp 的快速启动路径。
function findPython310() {
  for (const c of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3', '/usr/bin/python3']) {
    try { const r = spawnSync(c, ['-c', 'import sys;print(1 if sys.version_info>=(3,10) else 0)'], { encoding: 'utf8', timeout: 5000 }); if (r.stdout && r.stdout.trim() === '1') return c; } catch {}
  }
  return null;
}
const ZIPAPP = path.join(__dirname, 'bin', 'yt-dlp.pyz');
const ONEFILE = path.join(__dirname, 'bin', IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
const PY310 = IS_WIN ? null : findPython310();
let YTDLP_CMD = null;   // [可执行, ...前置参数]
if (!IS_WIN && PY310 && fs.existsSync(ZIPAPP)) YTDLP_CMD = [PY310, ZIPAPP];
else if (IS_WIN) { const executable = verifiedRuntime(__dirname, 'yt-dlp.exe', DEPENDENCIES.ytDlp.sha256); if (executable) YTDLP_CMD = [executable]; }
else if (fs.existsSync(ONEFILE)) YTDLP_CMD = [ONEFILE];

let ACTIVE_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const PROXY_CANDIDATES = [
  { port: 7897, scheme: 'http' }, // Clash Verge 常用 mixed-port
  { port: 7890, scheme: 'http' },
  { port: 10809, scheme: 'http' },
  { port: 7891, scheme: 'socks5' },
  { port: 10808, scheme: 'socks5' },
  { port: 1080, scheme: 'socks5' },
];
function detectProxy(cb) {
  if (ACTIVE_PROXY) return cb(ACTIVE_PROXY);
  const net = require('net');
  let index = 0;
  const tryNext = () => {
    if (index >= PROXY_CANDIDATES.length) return cb('');
    const candidate = PROXY_CANDIDATES[index++];
    let settled = false;
    const finish = (found) => {
      if (settled) return;
      settled = true;
      if (found) cb(`${candidate.scheme}://127.0.0.1:${candidate.port}`);
      else tryNext();
    };
    const s = net.connect({ host: '127.0.0.1', port: candidate.port, timeout: 500 });
    s.on('connect', () => { s.destroy(); finish(true); });
    s.on('error', () => finish(false));
    s.on('timeout', () => { s.destroy(); finish(false); });
  };
  tryNext();
}

// ── 配置 ──
function loadConf() { try { const value = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }
function saveConf(c) {
  const temp = CONF_PATH + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(c, null, 2), { flag: 'wx' }); fs.renameSync(temp, CONF_PATH); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
let conf = loadConf();
try { conf.quality = normalizeQuality(conf.quality); } catch { conf.quality = 'best'; }
if (IS_WIN && typeof conf.dir === 'string') {
  conf.dir = conf.dir.replace(/%([^%]+)%/g, (all, name) => process.env[name] || all);
}
if (typeof conf.dir !== 'string' || !path.isAbsolute(conf.dir) || (IS_WIN && /^\/Users\//i.test(conf.dir))) conf.dir = DEFAULT_DIR;

// ── 下载任务 ──
const jobs = new Map(); // id -> {id,url,name,pct,speed,eta,status,err,file,dir}
let pendingHistorySave = null;
let historySaveError = false;
function saveHistoryNow() {
  if (pendingHistorySave) { clearImmediate(pendingHistorySave); pendingHistorySave = null; }
  const updated = { ...conf, history: snapshotHistory(jobs) };
  try { saveConf(updated); conf = updated; historySaveError = false; }
  catch (error) { historySaveError = true; throw error; }
}
function scheduleHistorySave() {
  if (pendingHistorySave) return;
  pendingHistorySave = setImmediate(() => {
    pendingHistorySave = null;
    try { saveHistoryNow(); } catch { /* The task displays a local persistence warning. */ }
  });
}
function trackHistory(job) {
  return new Proxy(job, {
    set(target, key, value) {
      const changed = key === 'status' && target.status !== value;
      target[key] = value;
      if (changed && jobs.has(target.id)) scheduleHistorySave();
      return true;
    },
  });
}
for (const restored of restoreHistory(conf.history)) jobs.set(restored.id, trackHistory(restored));
const DOUYIN_MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';

function isDouyinUrl(value) {
  try {
    return /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isDouyinMediaUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'www.douyin.com'
      || host === 'aweme.snssdk.com'
      || host.endsWith('.douyinvod.com')
      || host.endsWith('.byteimg.com')
      || host.endsWith('.douyin.com');
  } catch {
    return false;
  }
}

function isYouTubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function usesSavedSessionForBestQuality(url) {
  return bilibiliDownload.isBilibiliUrl(url) || isYouTubeUrl(url);
}

function isXiaohongshuUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'xhslink.com' || host.endsWith('.xhslink.com')
      || host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com');
  } catch {
    return false;
  }
}

function safeFileName(value) {
  const cleaned = String(value || '抖音视频')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  return (cleaned || '抖音视频').slice(0, 80);
}

function findDouyinItem(value, id) {
  if (!value || typeof value !== 'object') return null;
  if (String(value.aweme_id || '') === String(id) && value.video) return value;
  for (const child of Object.values(value)) {
    const found = findDouyinItem(child, id);
    if (found) return found;
  }
  return null;
}

async function fetchText(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': DOUYIN_MOBILE_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!response.ok) throw new Error(`页面请求失败（HTTP ${response.status}）`);
    return { url: response.url, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveXiaohongshuUrl(value) {
  if (!isXiaohongshuUrl(value)) return value;
  let host = '';
  try { host = new URL(value).hostname.toLowerCase(); } catch { return value; }
  if (host !== 'xhslink.com' && !host.endsWith('.xhslink.com')) return value;
  const resolved = await fetchText(value, 20000);
  return isXiaohongshuUrl(resolved.url) ? resolved.url : value;
}

function extractDouyinVideoId(value) {
  const text = String(value || '');
  const pathId = text.match(/\/(?:video|note)\/(\d{15,25})(?:[/?#]|$)/i)?.[1];
  if (pathId) return pathId;
  try {
    const parsed = new URL(text);
    for (const key of ['modal_id', 'aweme_id', 'item_id', 'item_ids']) {
      const candidate = String(parsed.searchParams.get(key) || '').match(/^\d{15,25}$/)?.[0];
      if (candidate) return candidate;
    }
  } catch {}
  return '';
}

async function getDouyinVideoInfo(originalUrl) {
  let id = extractDouyinVideoId(originalUrl);
  if (!id) {
    const resolved = await fetchText(originalUrl);
    id = extractDouyinVideoId(resolved.url)
      || resolved.text.match(/"(?:aweme_id|itemId)"\s*:\s*"(\d{15,25})"/i)?.[1]
      || '';
  }
  if (!id) throw new Error('没有从抖音链接中识别出视频编号');
  try {
    const share = await fetchText(`https://www.iesdouyin.com/share/video/${id}/`);
    const routerJson = share.text.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)?.[1];
    if (!routerJson) throw new Error('抖音游客页面没有返回视频数据');
    let data;
    try { data = JSON.parse(routerJson); } catch { throw new Error('抖音游客页面数据解析失败'); }
    const item = findDouyinItem(data, id);
    const videoId = item?.video?.play_addr?.uri;
    if (!item || !videoId) throw new Error('抖音游客页面暂未提供这个视频的播放地址');

    return {
      id,
      title: safeFileName(item.desc),
      url: `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(videoId)}&ratio=1080p&line=0`,
      userAgent: DOUYIN_MOBILE_UA,
      referer: 'https://www.iesdouyin.com/',
    };
  } catch (error) {
    error.douyinVideoId = id;
    throw error;
  }
}

function cancelResolver(child) {
  if (child.connected) { try { child.send('cancel', () => {}); } catch {} }
  else { try { child.kill(); } catch {} }
  const kill = setTimeout(() => { if (child.exitCode === null) { try { child.kill(); } catch {} } }, 15000);
  kill.unref();
}

function getDouyinAnonymousVideoInfo(id) {
  return new Promise((resolve, reject) => {
    if (shuttingDown) return reject(new Error('下载服务正在关闭'));
    if (!JS_NODE || !fs.existsSync(DOUYIN_ANONYMOUS_RESOLVER)) {
      return reject(new Error('匿名临时会话组件不可用'));
    }
    const args = [DOUYIN_ANONYMOUS_RESOLVER, String(id)];
    if (ACTIVE_PROXY) args.push(ACTIVE_PROXY);
    const child = shutdownCoordinator.track(spawn(JS_NODE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, NO_COLOR: '1' } }), true);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      cancelResolver(child);
      finish(new Error('匿名临时会话解析超时'));
    }, 45000);
    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
      if (stdout.length > 1024 * 1024) {
        cancelResolver(child);
        finish(new Error('匿名临时会话返回数据异常'));
      }
    });
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString('utf8')).slice(-600); });
    child.on('error', (error) => finish(new Error(`匿名临时会话启动失败：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error(stderr.trim() || '匿名临时会话没有取得播放地址'));
      try {
        const data = JSON.parse(stdout);
        if (String(data.id) !== String(id) || !isDouyinMediaUrl(data.url)) throw new Error('返回的视频信息不匹配');
        finish(null, {
          id: String(id),
          title: safeFileName(data.title),
          url: data.url,
          userAgent: String(data.userAgent || DOUYIN_MOBILE_UA),
          referer: String(data.referer || 'https://www.douyin.com/'),
        });
      } catch (error) {
        finish(new Error(`匿名临时会话数据无效：${error.message}`));
      }
    });
  });
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)}MiB/s`;
  return `${Math.round(bytesPerSecond / 1024)}KiB/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const rounded = Math.ceil(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${String(minutes).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

async function saveDouyinVideo(job, videoUrl, partFile, requestHeaders = {}) {
  if (!isDouyinMediaUrl(videoUrl)) throw new Error('抖音播放地址未通过安全检查');
  const controller = new AbortController();
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), 30000);
  };
  resetIdleTimer();
  let response;
  try {
    response = await fetch(videoUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': requestHeaders.userAgent || DOUYIN_MOBILE_UA,
        Referer: requestHeaders.referer || 'https://www.iesdouyin.com/',
      },
    });
    if (!response.ok) throw new Error(`视频请求失败（HTTP ${response.status}）`);
    if (!/^video\//i.test(response.headers.get('content-type') || '')) throw new Error('抖音返回的内容不是视频');
    if (!response.body) throw new Error('抖音没有返回视频数据');

    const total = Number(response.headers.get('content-length')) || 0;
    const output = fs.createWriteStream(partFile, { flags: 'wx' });
    const outputFinished = finished(output);
    let received = 0;
    let sampleBytes = 0;
    let sampleTime = Date.now();
    try {
      for await (const chunk of response.body) {
        resetIdleTimer();
        received += chunk.length;
        if (!output.write(chunk)) await Promise.race([once(output, 'drain'), outputFinished]);
        const now = Date.now();
        if (now - sampleTime >= 500) {
          const speed = (received - sampleBytes) * 1000 / (now - sampleTime);
          job.speed = formatSpeed(speed);
          job.pct = total ? Math.min(99.5, received * 100 / total) : 0;
          job.eta = total && speed > 0 ? formatEta((total - received) / speed) : '';
          sampleBytes = received;
          sampleTime = now;
        }
      }
      output.end();
      await outputFinished;
    } catch (error) {
      output.destroy();
      try { await outputFinished; } catch {}
      throw error;
    }
    if (!received || (total && received !== total)) throw new Error('视频文件接收不完整');
  } finally {
    clearTimeout(idleTimer);
  }
}

async function runDouyinJob(job) {
  const tempDir = path.join(job.dir, '.视频下载器临时');
  let partFile = '';
  try {
    job.phase = '获取抖音游客视频信息';
    let info;
    try {
      info = await getDouyinVideoInfo(job.url);
    } catch (visitorError) {
      const id = visitorError.douyinVideoId || extractDouyinVideoId(job.url);
      if (!id) throw visitorError;
      job.phase = '建立隔离匿名临时会话';
      try {
        info = await getDouyinAnonymousVideoInfo(id);
        job.note = job.note === '浏览器会话未能完成下载，已改用公开方式'
          ? '浏览器会话未完成下载，已使用匿名临时会话'
          : '游客页受限，已自动使用隔离匿名临时会话';
      } catch (anonymousError) {
        throw new Error(`${visitorError.message}；${anonymousError.message}`);
      }
    }
    job.name = `${info.title} [${info.id}].mp4`;
    job.file = path.join(job.dir, job.name);
    if (fs.existsSync(job.file)) {
      const streams = inspectMedia(job.file);
      if (streams.video && streams.audio) {
        job.width = streams.width; job.height = streams.height;
        job.status = 'done'; job.phase = '完成'; job.pct = 100; job.note = '此前已下载过';
        return;
      }
      job.file = path.join(job.dir, `${info.title} [${info.id}-${job.id.slice(0, 4)}].mp4`);
      job.name = path.basename(job.file);
    }

    fs.mkdirSync(tempDir, { recursive: true });
    partFile = path.join(tempDir, `${info.id}-${job.id}.mp4.part`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      job.attempt = attempt;
      job.phase = attempt === 1 ? '下载抖音视频（游客模式）' : '抖音下载自动重试';
      try {
        await saveDouyinVideo(job, info.url, partFile, info);
        break;
      } catch (error) {
        try { fs.unlinkSync(partFile); } catch {}
        if (attempt === 2) throw error;
        job.pct = 0; job.speed = ''; job.eta = '';
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    fs.renameSync(partFile, job.file);
    partFile = '';
    job.phase = '校验音视频';
    const streams = inspectMedia(job.file);
    if (!streams.video || !streams.audio) throw new Error('下载文件缺少画面或声音');
    job.width = streams.width; job.height = streams.height;
    job.status = 'done'; job.phase = '完成'; job.pct = 100; job.speed = ''; job.eta = '';
  } catch (error) {
    if (partFile) { try { fs.unlinkSync(partFile); } catch {} }
    if (trySessionAfterPublicFailure(job, error.message)) return;
    job.status = 'error';
    job.err = error.name === 'AbortError' ? '抖音请求超时，请重试' : (error.message || '抖音下载失败');
    job.accessIssue = classifyAccessIssue(job.err);
    if (job.cookieIssues?.length) job.err += '（浏览器会话：' + job.cookieIssues.join('；') + '。）';
  }
}

async function runYangshipinJob(job) {
  const tempDir = path.join(job.dir, '.视频下载器临时');
  let partFile = '';
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      job.attempt = attempt;
      job.phase = attempt === 1 ? '获取央视频公开播放信息' : '重新获取央视频播放地址';
      try {
        const info = await yangshipin.resolve(job.url);
        const title = safeFileName(info.title);
        const preferred = path.join(job.dir, `${title} [${info.id}].mp4`);
        job.name = path.basename(preferred);
        job.note = `央视频 · ${info.height}p`;
        if (await yangshipin.verifyFile(preferred, info)) {
          const streams = inspectMedia(preferred);
          if (streams.video && streams.audio) {
            job.file = preferred;
            job.width = streams.width; job.height = streams.height;
            job.note += ' · 此前已下载过';
            job.status = 'done'; job.phase = '完成'; job.pct = 100;
            return;
          }
        }
        fs.mkdirSync(tempDir, { recursive: true });
        partFile = path.join(tempDir, `yangshipin-${info.id}-${job.id}-${attempt}.mp4.part`);
        job.phase = `下载央视频 ${info.height}p 视频`;
        let sampleBytes = 0, sampleTime = Date.now();
        await yangshipin.download(info, partFile, (received, total) => {
          const now = Date.now();
          job.pct = Math.min(99.5, received * 100 / total);
          if (now - sampleTime >= 500) {
            const speed = (received - sampleBytes) * 1000 / (now - sampleTime);
            job.speed = formatSpeed(speed); job.eta = formatEta((total - received) / speed);
            sampleBytes = received; sampleTime = now;
          }
        });
        job.phase = '校验音视频';
        const streams = inspectMedia(partFile);
        if (!streams.video || !streams.audio) throw new Error('下载文件缺少画面或声音');
        job.width = streams.width; job.height = streams.height;
        // Hard-link only after validation: atomic publication without overwriting any existing file.
        let destination = preferred;
        try { fs.linkSync(partFile, destination); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          destination = path.join(job.dir, `${title} [${info.id}-${job.id}].mp4`);
          fs.linkSync(partFile, destination);
        }
        fs.unlinkSync(partFile); partFile = '';
        job.file = destination; job.name = path.basename(destination);
        job.status = 'done'; job.phase = '完成'; job.pct = 100; job.speed = ''; job.eta = '';
        return;
      } catch (error) {
        if (partFile) { try { fs.unlinkSync(partFile); } catch {} partFile = ''; }
        const transient = error.retryable || /AbortError|TimeoutError|TypeError/.test(error.name);
        if (attempt === 2 || !transient) throw error;
        job.pct = 0; job.speed = ''; job.eta = '';
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  } catch (error) {
    if (trySessionAfterPublicFailure(job, error.message)) return;
    job.status = 'error'; job.phase = '失败'; job.speed = ''; job.eta = '';
    job.err = /AbortError|TimeoutError/.test(error.name) ? '央视频连接超时，请重试'
      : error.name === 'TypeError' ? '连接央视频失败，请检查网络后重试' : error.message;
    if (job.cookieIssues?.length) job.err += '（浏览器会话：' + job.cookieIssues.join('；') + '。）';
  }
}

let browserQueue = Promise.resolve();
let browserPending = 0;
async function discoverPageVideo(job) {
  if (browserPending >= 3) throw new Error('正在识别其他网页，请稍后点击重试');
  browserPending++;
  const previous = browserQueue;
  let release;
  browserQueue = new Promise(resolve => { release = resolve; });
  job.phase = '等待识别网页视频';
  await previous;
  try {
    if (shuttingDown) throw new Error('下载服务正在关闭');
    job.phase = '识别网页视频（临时浏览器）';
    return await new Promise((resolve, reject) => {
      const args = [path.join(__dirname, 'scripts', 'browser-resolver.js'), job.url, ACTIVE_PROXY || ''];
      const child = shutdownCoordinator.track(spawn(JS_NODE || process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env } }), true);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      let stdout = '', stderr = '', settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => { cancelResolver(child); finish(new Error('网页识别超时，请稍后重试')); }, 55000);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 65536) { cancelResolver(child); finish(new Error('网页返回的播放信息过大')); }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-600); });
      child.on('error', () => finish(new Error('临时浏览器识别组件启动失败')));
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) return finish(new Error(stderr || '网页未提供可公开下载的视频'));
        try {
          const info = JSON.parse(stdout);
          if (!browserDiscovery.publicUrl(info.url) || !browserDiscovery.publicUrl(info.referer)
              || typeof info.userAgent !== 'string' || /[\r\n]/.test(info.userAgent)) throw new Error('地址无效');
          finish(null, { mediaUrl: info.url, referer: info.referer, userAgent: info.userAgent.slice(0, 300), title: safeFileName(info.title), fromBrowser: true });
        } catch { finish(new Error('网页返回了无效的播放信息')); }
      });
    });
  } finally { browserPending--; release(); }
}

function newJob(url, dir, selectedQuality = conf.quality) {
  if (shuttingDown) throw httpError(503, '下载服务正在关闭，请稍后重新打开软件');
  if (twitterDownload.isTwitterUrl(url)) url = twitterDownload.normalizeUrl(url);
  const quality = normalizeQuality(selectedQuality);
  if ([...jobs.values()].filter(j => j.status === 'running').length >= 3) throw httpError(429, '最多同时下载三个视频，请等待一个任务结束后重试');
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, '.write-test-' + crypto.randomBytes(6).toString('hex'));
  try { fs.writeFileSync(probe, '', { flag: 'wx' }); } catch { throw httpError(400, '保存目录无法写入，请更换保存位置'); }
  finally { try { fs.unlinkSync(probe); } catch {} }
  // Bound saved records while never removing an active download.
  for (const old of [...jobs.values()].filter(j => j.status !== 'running').sort((a, b) => a.t - b.t)) {
    if (jobs.size < MAX_HISTORY) break;
    jobs.delete(old.id);
  }
  const id = crypto.randomBytes(5).toString('hex');
  const job = trackHistory({ id, url, name: url, quality, sourceQuality: isDouyinUrl(url) || yangshipin.isYangshipinUrl(url),
    pct: 0, speed: '', eta: '', status: 'running', err: '', file: '', dir, merging: false, phase: '准备下载', attempt: 1, t: Date.now() });
  jobs.set(id, job);
  scheduleHistorySave();
  if (usesSavedSessionForBestQuality(url) && (quality === 'best' || quality === '2160p') && YTDLP_CMD) {
    const saved = findSavedCookieBrowsers(url);
    if (saved.length) {
      job.sessionTried = true;
      runYtdlpJob(job, { cookieBrowsers: saved });
      return job;
    }
  }
  runPublicJob(job);
  return job;
}

function trySessionAfterPublicFailure(job, error, force = false) {
  if (shuttingDown || job.sessionTried || !YTDLP_CMD || (!force && !classifyAccessIssue(error))) return false;
  // The original Xiaohongshu path can read a browser after the public request fails.
  // Other sites only use a previously saved session, without opening a website.
  const browsers = isXiaohongshuUrl(job.url) ? findCookieBrowsers(job.url) : findSavedCookieBrowsers(job.url);
  if (!browsers.length) return false;
  job.sessionTried = true;
  job.phase = '公开方式受限，尝试已保存的浏览器会话';
  runYtdlpJob(job, { cookieBrowsers: browsers, afterPublicFailure: true, publicError: String(error || '') });
  return true;
}

function runPublicJob(job) {
  const route = publicDownloadRoute(job.url);
  if (route === 'yangshipin') return runYangshipinJob(job);
  if (route === 'douyin') return runDouyinJob(job);
  return runYtdlpJob(job);
}

function publicDownloadRoute(url) {
  if (yangshipin.isYangshipinUrl(url)) return 'yangshipin';
  if (isDouyinUrl(url)) return 'douyin';
  return 'ytdlp';
}

function runYtdlpJob(job, options = {}) {
  const { url, dir } = job;
  const downloadUrl = options.mediaUrl || url;
  const isXhs = isXiaohongshuUrl(url);
  const isBili = !options.fromBrowser && bilibiliDownload.isBilibiliUrl(url);
  const isTwitter = twitterDownload.isTwitterUrl(url);
  const cookieBrowsers = options.cookieBrowsers || [];
  const tempDir = path.join(dir, '.视频下载器临时', job.id);
  const sizeSuffix = !options.fromBrowser && usesSavedSessionForBestQuality(url) ? resolutionSuffix(job.quality) : '';
  const args = ['--no-config', '--encoding', 'utf-8', '--newline', '--progress', '--no-playlist', '--no-overwrites', '--abort-on-unavailable-fragments', '-P', dir, '-P', `temp:${tempDir}`, '-o', `%(title).80s [%(id)s]${qualitySuffix(job.quality)}${sizeSuffix}.%(ext)s`,
    '--print', 'after_move:__FINAL_FILE__%(filepath)s',
    '--socket-timeout', '20',                       // 20秒握手/读取超时:网络抖一下就快速失败重来,不再卡 0.0% 干等
    '--retries', '10', '--fragment-retries', '10',  // 偶发失败自动重试10次:治 B站 TLS 握手偶发超时导致的硬失败
    '--concurrent-fragments', '8'];                 // 8线程并发下载:突破 YouTube 单连接限速(实测 82→870KiB/s,快10倍)
  // 新版 YouTube 需要外部 JavaScript 运行时来处理网页挑战。项目已自带 Node。
  if (JS_NODE) args.push('--js-runtimes', `node:${JS_NODE}`);
  // 不限制容器格式，优先选择最佳可用视频和音频。
  if (FFMPEG) { args.push('-f', 'bv*+ba/b', '--ffmpeg-location', FFMPEG); }
  else { args.push('-f', 'b'); }
  if (!job.sourceQuality) args.push(...qualityArgs(job.quality));
  if (!isBili && ACTIVE_PROXY) args.push('--proxy', ACTIVE_PROXY);
  if (options.fromBrowser) {
    args.push('--referer', options.referer, '--user-agent', options.userAgent);
    const videoId = crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
    args.push('-o', `${options.title.replace(/%/g, '%%')} [${videoId}]${qualitySuffix(job.quality)}.%(ext)s`);
    job.note = '已自动识别网页播放资源';
  }

  const startAttempt = (attempt, cookieIndex = -1, refreshCookie = false) => {
    if (shuttingDown) return;
    const cookieBrowser = cookieIndex >= 0 ? cookieBrowsers[cookieIndex] : '';
    job.attempt = attempt;
    job.status = 'running';
    job.phase = cookieBrowser ? `使用 ${cookieBrowser === 'extension' ? '浏览器扩展' : cookieBrowser + ' 浏览器'}会话下载` : (attempt > 1 ? '自动重试' : options.fromBrowser ? '下载网页视频' : '准备下载');
    if (!cookieBrowser && isBili) job.phase = attempt > 1 && ACTIVE_PROXY ? '切换直连并检测B站备用地址' : '检测B站可用下载地址';
    if (!cookieBrowser && isTwitter) job.phase = attempt > 1 ? '尝试 X / Twitter 公开备用通道' : '获取 X / Twitter 视频信息';
    job.err = '';
    job.accessIssue = '';
    job.pct = 0;
    job.speed = '';
    job.eta = '';
    const childEnv = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    };
    delete childEnv.VIDEO_DOWNLOADER_COOKIE_BROWSER;
    delete childEnv.VIDEO_DOWNLOADER_COOKIE_URL;
    delete childEnv.VIDEO_DOWNLOADER_COOKIE_REFRESH;
    const runArgs = args.slice();
    if (isBili) runArgs.push(...bilibiliDownload.attemptArgs(__dirname, ACTIVE_PROXY, attempt));
    if (isTwitter) runArgs.push(...twitterDownload.attemptArgs(attempt));
    if (isYouTubeUrl(url) && cookieBrowser) {
      // Retain default clients and add supported web variants. They can expose
      // additional formats, including higher resolutions on embeddable videos.
      runArgs.push('--extractor-args', 'youtube:player_client=default,web_safari,web_embedded');
    }
    if (cookieBrowser) {
      childEnv.VIDEO_DOWNLOADER_COOKIE_BROWSER = cookieBrowser;
      childEnv.VIDEO_DOWNLOADER_COOKIE_URL = url;
      if (refreshCookie) childEnv.VIDEO_DOWNLOADER_COOKIE_REFRESH = '1';
      // The trusted plugin reads the browser without a plaintext database copy.
      // No --cookies-from-browser flag: a missing plugin must fail closed.
      runArgs.push('--no-plugin-dirs', '--plugin-dirs', path.join(__dirname, 'scripts', 'yt-dlp-plugins'));
    }
    runArgs.push('--', downloadUrl);   // 原链接和识别后的地址都通过独立参数传递。
    const child = shutdownCoordinator.track(spawn(YTDLP_CMD[0], YTDLP_CMD.slice(1).concat(runArgs), { env: childEnv, windowsHide: true }));
    const buffers = { stdout: '', stderr: '' };
    let errTail = '';
    const cookieMarkers = new Set();
    const onLine = (line) => {
      let m;
      line = line.replace(/\r$/, '');
      if ((m = line.match(/__VIDEO_COOKIE_CACHE_(HIT|SAVED|SAVE_FAILED|REFRESHED|REFRESH_SAVED|EMPTY)__/))) cookieMarkers.add(m[1]);
      if ((m = line.match(/^__FINAL_FILE__(.+)$/))) {
        job.file = m[1].trim(); job.name = path.basename(job.file); job.phase = '校验音视频';
      }
      if ((m = line.match(/\[download\]\s+Destination:\s+(.+)$/))) {
        job.file = m[1].trim(); job.name = path.basename(job.file); job.merging = false;
        job.pct = 0; job.speed = ''; job.eta = '';
        job.phase = /\.f\d+\.(m4a|aac|opus|webm)$/i.test(job.file) ? '下载音频轨' : '下载视频轨';
      }
      if ((m = line.match(/\[Merger\].*?"(.+?)"/))) {
        job.file = m[1]; job.name = path.basename(job.file); job.merging = true; job.phase = '合并音视频';
      }
      if ((m = line.match(/\[download\]\s+([\d.]+)%(?:.*?at\s+([^\s]+))?(?:.*?ETA\s+([^\s]+))?/))) {
        job.pct = Math.min(100, parseFloat(m[1]) || 0);
        if (m[2]) job.speed = m[2];
        if (m[3]) job.eta = m[3];
      }
      if (/has already been downloaded/.test(line)) { job.pct = 100; job.note = '此前已下载过'; }
    };
    const eat = (stream, d) => {
      buffers[stream] += d.toString('utf8');
      let i;
      while ((i = buffers[stream].indexOf('\n')) >= 0) { onLine(buffers[stream].slice(0, i)); buffers[stream] = buffers[stream].slice(i + 1); }
      if (buffers[stream].length > 65536) buffers[stream] = buffers[stream].slice(-65536);
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => eat('stdout', d));
    child.stderr.on('data', (d) => { const s = d.toString('utf8'); errTail = (errTail + s).slice(-2400); eat('stderr', d); });
    child.on('error', (e) => { job.status = 'error'; job.err = 'yt-dlp 启动失败: ' + e.message; });
    child.on('close', async (code) => {
      if (job.status === 'error') return;
      if (buffers.stdout) onLine(buffers.stdout);
      if (buffers.stderr) onLine(buffers.stderr);
      // A failed transfer may leave playable but incomplete tracks. Never turn a nonzero exit into success.
      if (code === 0) {
        if (cookieBrowser) {
          const browserLabel = cookieBrowser === 'extension' ? '浏览器扩展' : cookieBrowser + ' 浏览器';
          if (cookieMarkers.has('SAVE_FAILED')) job.note = '浏览器会话未能保存，下次可能需要重新读取';
          else if (cookieMarkers.has('HIT')) job.note = `已尝试 ${browserLabel} 的已保存会话`;
          else if (cookieMarkers.has('SAVED')) job.note = `已尝试 ${browserLabel} 会话`;
          else if (cookieMarkers.has('REFRESHED')) job.note = `已尝试更新的 ${browserLabel} 会话`;
          else job.note = '浏览器会话未启用，已使用公开方式';
        }
        job.phase = '校验音视频';
        try { await finishVideoJob(job); }
        catch (error) { job.status = 'error'; job.phase = '失败'; job.err = error.message; }
        return;
      }
      const known = errTail.match(/ERROR:\s*([^\n]+)/);
      const message = known ? known[1].slice(0, 240) : ('退出码 ' + code);
      const youtubeIpChallenge = isYouTubeUrl(url)
        && /Sign in to confirm you(?:'|’)?re not a bot|not a bot/i.test(errTail);
      const xhsNeedsLogin = isXhs
        && /No video formats found|login|log in|cookie|captcha|forbidden|HTTP Error 403|initial state/i.test(errTail);
      const xhsCookieReadFailed = isXhs
        && /Could not copy .*cookie database|Failed to decrypt|cookie.*(?:locked|permission denied)|CookieLoadError/i.test(errTail);
      if (cookieBrowser) {
        const cookieIssue = describeCookieReadIssue(cookieBrowser, errTail, cookieMarkers.has('EMPTY'));
        if (cookieIssue) {
          job.cookieIssues ||= [];
          if (!job.cookieIssues.includes(cookieIssue)) job.cookieIssues.push(cookieIssue);
        }
        const cacheHit = cookieMarkers.has('HIT');
        const errorLines = errTail.split(/\r?\n/).filter(line => /\bERROR:/i.test(line)).join('\n');
        const accessFailure = cookieMarkers.has('EMPTY') || !!classifyAccessIssue(errTail)
          || /could not find .*cookies|failed to decrypt|unable to open database|database is locked|cookie.*(?:locked|permission denied|expired)|CookieLoadError|login required|sign in|HTTP Error (?:401|403)/i.test(errorLines)
          || (isXhs && xhsNeedsLogin)
          || (isTwitter && /no video formats|guest token|graphql/i.test(errorLines))
          || (isDouyinUrl(url) && /no video formats|fresh cookies/i.test(errorLines));
        // A blocked YouTube network address is not evidence that the saved session expired.
        if (cacheHit && accessFailure && !refreshCookie && !youtubeIpChallenge) {
          job.phase = '浏览器会话可能已过期，正在重新读取';
          return setTimeout(() => startAttempt(1, cookieIndex, true), 300);
        }
        if (accessFailure && cookieIndex + 1 < cookieBrowsers.length && !youtubeIpChallenge) {
          job.phase = '尝试另一个本机浏览器';
          return setTimeout(() => startAttempt(1, cookieIndex + 1), 300);
        }
        if (!options.afterPublicFailure) {
          job.note = '浏览器会话未能完成下载，已改用公开方式';
          return runPublicJob(job);
        }
        job.status = 'error'; job.phase = '失败';
        job.accessIssue = classifyAccessIssue(options.publicError) || classifyAccessIssue(errTail);
        const publicMessage = (options.publicError.match(/ERROR:\s*([^\n]+)/) || [])[1] || options.publicError;
        job.err = isXhs ? '小红书公开方式和浏览器会话都未能取得视频，请检查链接和登录状态。'
          : (isTwitter && twitterDownload.describeFailure(options.publicError)) || describeDownloadError(publicMessage) || '公开方式和已保存会话均未能下载。';
        if (job.cookieIssues?.length) job.err += '（浏览器会话：' + job.cookieIssues.join('；') + '。）';
        return;
      }
      if (isTwitter && attempt < 2 && twitterDownload.shouldRetry(errTail)) {
        job.phase = '准备切换 X / Twitter 公开备用通道'; job.err = ''; job.pct = 0; job.merging = false;
        return setTimeout(() => startAttempt(attempt + 1), 600);
      }
      if (!options.fromBrowser && browserDiscovery.eligible(url, errTail)) {
        job.pct = 0; job.speed = ''; job.eta = ''; job.merging = false;
        discoverPageVideo(job).then(info => runYtdlpJob(job, info)).catch(error => {
          job.status = 'error'; job.phase = '失败'; job.err = error.message;
          job.accessIssue = classifyAccessIssue(error.message) || classifyAccessIssue(errTail);
          if (job.cookieIssues?.length) job.err += '（浏览器会话：' + job.cookieIssues.join('；') + '。）';
        });
        return;
      }
      if (isBili && attempt < 2 && bilibiliDownload.isConnectionFailure(errTail)) {
        job.phase = ACTIVE_PROXY ? '准备切换直连重试' : '重新获取B站下载地址';
        job.err = ''; job.pct = 0; job.merging = false;
        return setTimeout(() => startAttempt(attempt + 1, cookieIndex), 600);
      }
      if (attempt < 2 && (/No such file|timed out|timeout|handshake|TLS|SSL|EOF|ConnectionReset|10054|reset by peer|远程主机|temporar|HTTP Error (?:4(?:12|29)|5)/i.test(errTail) || youtubeIpChallenge)) {
        job.phase = '自动重试'; job.err = '第一次下载异常，正在自动重试'; job.pct = 0; job.merging = false;
        return setTimeout(() => startAttempt(attempt + 1, cookieIndex), youtubeIpChallenge ? 1800 : 600);
      }
      if (!options.fromBrowser && trySessionAfterPublicFailure(job, errTail, isXhs && xhsNeedsLogin)) return;
      job.status = 'error';
      job.phase = '失败';
      job.accessIssue = classifyAccessIssue(errTail);
      if (youtubeIpChallenge) {
        job.err = 'YouTube 要求验证当前访问，浏览器会话或代理节点可能受到平台限制。请确认浏览器能播放，必要时切换代理节点后重试。';
      } else if (isXhs && xhsCookieReadFailed) {
        job.err = '已识别小红书链接，但 Windows 暂时无法读取浏览器登录状态。请完全退出 Chrome/Edge 后重新下载；不会删除或上传 Cookie。';
      } else if (isXhs && xhsNeedsLogin) {
        job.err = findCookieBrowsers(url).length
          ? '小红书没有返回可下载的视频。请确认这是视频笔记，并从小红书“分享→复制链接”取得最新地址后重试。'
          : '小红书页面需要登录状态，但这台电脑未找到可读取的 Chrome、Edge 或 Firefox 浏览器资料。';
      } else {
        job.err = (isTwitter && twitterDownload.describeFailure(errTail)) || (isBili && bilibiliDownload.describeFailure(errTail)) || describeDownloadError(message);
        if (isYouTubeUrl(url) && !ACTIVE_PROXY) job.err += '（YouTube 需先启动 Clash，再重启工具）';
      }
      if (job.cookieIssues?.length) job.err += '（浏览器会话：' + job.cookieIssues.join('；') + '。）';
    });
  };
  startAttempt(1, cookieBrowsers.length ? 0 : -1);
  return job;
}

// ── HTML 界面(内嵌单页) ──
// The desktop app reads this response to authenticate its local API requests.
const DESKTOP_TOKEN_RESPONSE = `const API_TOKEN=${JSON.stringify(API_TOKEN)};`;

// ── HTTP 服务 ──
let PROXY_ON = !!ACTIVE_PROXY;
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const TOKEN_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function isAllowedHost(value) {
  if (typeof value !== 'string' || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(value)) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function isAllowedOrigin(value) {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' && parsed.origin === value && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function tokenMatches(value) {
  const received = Buffer.from(String(value || ''), 'utf8');
  const expected = Buffer.from(API_TOKEN, 'utf8');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function publicJob(job) {
  let { id, name, pct, speed, eta, status, err, merging, phase, attempt, note, t, quality, sourceQuality, width, height, accessIssue } = job;
  if (historySaveError && status === 'done') note = [note, '下载记录保存失败，请检查软件目录是否可写'].filter(Boolean).join('；');
  if (historySaveError && status === 'error') err = [err, '下载记录保存失败，请检查软件目录是否可写'].filter(Boolean).join('；');
  return { id, name, pct, speed, eta, status, err, merging, phase, attempt, note, t, quality, sourceQuality, width, height, accessIssue };
}

function responseHeaders(contentType, extra = {}) {
  return { ...SECURITY_HEADERS, 'Content-Type': contentType, ...extra };
}

function json(res, obj, code = 200) {
  if (res.destroyed || res.writableEnded || res.headersSent) return;
  res.writeHead(code, responseHeaders('application/json; charset=utf-8'));
  res.end(JSON.stringify(obj));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function body(req) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined) {
      const length = Number(declared);
      if (!Number.isSafeInteger(length) || length < 0) {
        req.resume();
        return reject(httpError(400, '无效的 Content-Length'));
      }
      if (length > MAX_JSON_BODY) {
        req.resume();
        return reject(httpError(413, '请求内容过大'));
      }
    }
    let data = '';
    const decoder = new StringDecoder('utf8');
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_JSON_BODY) return fail(httpError(413, '请求内容过大'));
      data += decoder.write(chunk);
    });
    req.on('aborted', () => fail(httpError(408, '请求已中断')));
    req.on('error', () => fail(httpError(400, '请求读取失败')));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const value = JSON.parse(data + decoder.end() || '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) return reject(httpError(400, '请求内容必须是 JSON 对象'));
        resolve(value);
      }
      catch { reject(httpError(400, 'JSON 格式无效')); }
    });
  });
}

function bringExplorerToFront(folder) {
  const helper = path.join(BUNDLED_BIN, 'focus-explorer-v2.exe');
  if (!fs.existsSync(helper)) return;
  const focus = spawn(helper, [path.resolve(folder)], {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  focus.on('error', () => {});
  focus.unref();
}

async function revealInExplorer(target, showDirectory) {
  const resolved = path.resolve(target);
  const folder = showDirectory ? resolved : path.dirname(resolved);
  const helper = path.join(BUNDLED_BIN, 'reveal-file.exe');
  if (!showDirectory && fs.existsSync(helper)) {
    await new Promise((resolve, reject) => {
      const child = spawn(helper, [resolved], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('无法定位下载文件')));
    });
  } else {
    await new Promise((resolve, reject) => {
      const explorer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [folder], { windowsHide: false, detached: true, stdio: 'ignore' });
      explorer.once('error', reject);
      explorer.once('spawn', () => { explorer.unref(); resolve(); });
    });
  }
  setTimeout(() => bringExplorerToFront(folder), 500);
}

const server = http.createServer(async (req, res) => {
  try {
  if (!isAllowedHost(req.headers.host)) return json(res, { err: 'forbidden host' }, 403);
  if (req.url === '/api/extension/pair' || req.url === '/api/extension/sync') {
    const bridge = getExtensionBridge();
    if (req.headers.origin !== bridge.origin) { req.resume(); return json(res, { err: 'forbidden origin' }, 403); }
    const headers = { 'Access-Control-Allow-Origin': bridge.origin, 'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true', 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
    const reply = (value, status=200) => { res.writeHead(status, responseHeaders('application/json; charset=utf-8', headers)); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) { req.resume(); return reply({err:'请求无效'}, 400); }
    try {
      const input = await body(req);
      if (shuttingDown) return reply({err:'下载服务正在关闭'}, 503);
      if (req.url === '/api/extension/pair') return reply({key: bridge.pair(input.code)});
      if (typeof input.url !== 'string' || input.url.length > 8192) return reply({err:'网站地址无效'}, 400);
      const site = await bridge.sync(input.key, input.url, input.cookies);
      return reply({ok:true,site});
    } catch (e) { return reply({err:e.message || '会话同步失败'}, e.statusCode || 400); }
  }
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    res.writeHead(200, responseHeaders('text/plain; charset=utf-8', { 'Content-Security-Policy': TOKEN_CSP }));
    return res.end(DESKTOP_TOKEN_RESPONSE);
  }
  if (req.method === 'GET' && req.url === '/api/config') return json(res, {
    app: APP_ID,
    desktopApi: 1,
    twitter: true,
    build: BUILD_ID,
    instance: INSTANCE_ID,
    pid: process.pid,
    dir: conf.dir,
    quality: conf.quality,
    ytdlp: !!YTDLP_CMD,
    ffmpeg: !!FFMPEG,
    jsRuntime: !!JS_NODE,
    proxy: PROXY_ON,
    proxyPort: ACTIVE_PROXY ? (ACTIVE_PROXY.match(/:(\d+)\/?$/) || [])[1] || '' : '',
    xiaohongshu: true,
    yangshipin: true,
  });
  if (req.method === 'GET' && req.url === '/api/jobs') return json(res, [...jobs.values()].sort((a, b) => b.t - a.t).slice(0, MAX_HISTORY).map(publicJob));
  if (req.method !== 'POST') return json(res, { err: 'bad' }, 404);
  if (!isAllowedOrigin(req.headers.origin)
      || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
      || !tokenMatches(req.headers['x-video-downloader-token'])) {
    req.resume();
    return json(res, { err: 'forbidden request' }, 403);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    req.resume();
    return json(res, { err: 'Content-Type 必须是 application/json' }, 415);
  }
  let b;
  try { b = await body(req); }
  catch (error) { return json(res, { err: error.message || '请求无效' }, error.statusCode || 400); }
  if (shuttingDown) return json(res, { err: '下载服务正在关闭' }, 503);
  if (req.url === '/api/extension/pair-code') return json(res, {code: getExtensionBridge().issueCode()});
  if (req.url === '/api/shutdown') {
    if (b.force !== undefined && typeof b.force !== 'boolean') return json(res, { err: '请求参数无效' }, 400);
    const active = [...jobs.values()].filter(job => job.status === 'running');
    if (active.length && b.force !== true) return json(res, { ok: false, running: active.length });
    shuttingDown = true;
    try { await shutdownCoordinator.stopChildren(); }
    catch (error) { shuttingDown = false; return json(res, { err: error.message || '无法停止下载任务' }, 500); }
    for (const job of active) if (job.status !== 'done') {
      job.status = 'error'; job.phase = '已中断'; job.err = '下载已中断，可以点击“再试一次”。';
      job.speed = ''; job.eta = ''; job.merging = false;
    }
    try { saveHistoryNow(); }
    catch { shuttingDown = false; return json(res, { err: '下载记录保存失败，请检查软件目录是否可写后重试。' }, 500); }
    res.once('finish', () => {
      server.close();
      setTimeout(() => process.exit(0), 100);
    });
    return json(res, { ok: true });
  }
  if (req.url === '/api/quality') {
    if (b.quality === undefined) return json(res, { err: '请选择下载画质' }, 400);
    const quality = normalizeQuality(b.quality);
    const updated = { ...conf, quality };
    saveConf(updated);
    conf = updated;
    return json(res, { quality });
  }
  if (req.url === '/api/directory') {
    if (typeof b.dir !== 'string' || !path.isAbsolute(b.dir) || b.dir.includes('\0') || b.dir.length > 4096) {
      return json(res, { err: '请选择有效的保存文件夹' }, 400);
    }
    try {
      if (!fs.statSync(b.dir).isDirectory()) throw new Error('not a directory');
      fs.accessSync(b.dir, fs.constants.W_OK);
    } catch { return json(res, { err: '保存文件夹不存在或无法写入' }, 400); }
    const updated = { ...conf, dir: path.resolve(b.dir) };
    saveConf(updated);
    conf = updated;
    return json(res, { dir: conf.dir });
  }
  if (req.url === '/api/retry') {
    const previous = typeof b.id === 'string' ? jobs.get(b.id) : null;
    if (!previous || previous.status !== 'error') return json(res, { err: '没有找到可重试的失败任务' }, 400);
    for (const j of jobs.values()) if (j.url === previous.url && j.quality === previous.quality && j.status === 'running') return json(res, { id: j.id, note: '已在下载中' });
    return json(res, { id: newJob(previous.url, previous.dir, previous.quality).id });
  }
  if (req.url === '/api/clear-history') {
    const removed = [];
    for (const [id, job] of jobs) {
      if (job.status !== 'running') {
        removed.push([id, job]);
        jobs.delete(id);
      }
    }
    try { saveHistoryNow(); }
    catch { for (const [id, job] of removed) jobs.set(id, job); return json(res, { err: '无法保存下载记录，请检查软件目录是否可写。' }, 500); }
    return json(res, { ok: true, cleared: removed.length });
  }
  if (req.url === '/api/download') {
    const quality = normalizeQuality(b.quality === undefined ? conf.quality : b.quality);
    if (typeof b.url !== 'string' || b.url.length > 16384) return json(res, { err: '请提供有效长度的视频链接文本' }, 400);
    let url = extractUrl(b.url);
    if (!url) return json(res, { err: '没有识别到 http/https 视频链接' }, 400);
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error(); }
    catch { return json(res, { err: '视频链接格式无效或包含账号密码' }, 400); }
    if (twitterDownload.isTwitterUrl(url)) {
      try { url = twitterDownload.normalizeUrl(url); }
      catch (error) { return json(res, { err: error.message }, 400); }
    }
    if (yangshipin.isYangshipinUrl(url)) {
      try { url = yangshipin.normalizeUrl(url).href; }
      catch (error) { return json(res, { err: error.message }, 400); }
      if (!FFMPEG) return json(res, { err: '缺少音视频校验组件，请重新启动工具准备运行环境' }, 400);
    } else if (!YTDLP_CMD) return json(res, { err: '未找到可用的 yt-dlp 引擎' }, 400);
    if (!FFMPEG) return json(res, { err: '缺少通过校验的 FFmpeg，请重新运行安装入口' }, 503);
    if (isXiaohongshuUrl(url)) {
      try { url = await resolveXiaohongshuUrl(url); } catch {}
    }
    for (const j of jobs.values()) if (j.url === url && j.quality === quality && j.status === 'running') return json(res, { id: j.id, note: '已在下载中' });
    return json(res, { id: newJob(url, conf.dir, quality).id });
  }
  if (req.url === '/api/pick-dir') {
    // 异步 spawn:选择框会一直开着直到用户操作,若用 spawnSync 会阻塞整个单线程服务(下载全假卡)
    const c = IS_WIN
      ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-STA', '-NoProfile', '-Command', "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq 'OK'){Write-Output $f.SelectedPath}"]]
      : ['osascript', ['-e', 'POSIX path of (choose folder with prompt "选择视频保存位置")']];
    const ch = spawn(c[0], c[1], { windowsHide: true });
    let out = '';
    ch.stdout.on('data', (d) => (out += d.toString('utf8')));
    ch.on('error', () => json(res, { dir: null }));
    ch.on('close', (code) => {
      const dir = out.trim();
      if (code === 0 && dir) {
        try { const updated = { ...conf, dir: dir.replace(/\/$/, '') }; saveConf(updated); conf = updated; json(res, { dir: conf.dir }); }
        catch { json(res, { err: '无法保存目录设置，请确认程序目录可写' }, 500); }
      }
      else json(res, { dir: null });
    });
    return;
  }
  if (req.url === '/api/reveal') {
    const job = b.dir ? null : jobs.get(String(b.id || ''));
    if (!b.dir && (!job || job.status !== 'done')) return json(res, { err: '没有找到已完成的下载任务' }, 404);
    let selected;
    try { selected = resolveRevealTarget(job, conf.dir, !!b.dir); }
    catch (error) { return json(res, {err:error.message}, 404); }
    if (IS_WIN) await revealInExplorer(selected.target, selected.showDirectory);
    else { selected.showDirectory ? spawnSync('open', [selected.target]) : spawnSync('open', ['-R', selected.target]); }
    return json(res, { ok: 1 });
  }
  json(res, { err: 'bad' }, 404);
  } catch (error) { json(res, { err: error.statusCode ? error.message : '操作失败，请检查保存目录或重新启动工具' }, error.statusCode || 500); }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;

// 端口 3210 起顺延；重复启动复用相同版本，源码更新后避开尚未退出的旧实例。
async function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  if (IS_WIN) await openAppWindow(url).catch(error => console.error('应用窗口打开失败:', error.message));
  else spawnSync('open', [url]);
}

function probeExisting(port, cb) {
  let settled = false;
  const finish = (value) => { if (!settled) { settled = true; cb(value); } };
  const req = http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: 1000 }, (res) => {
    let data = '';
    res.on('data', (d) => (data += d));
    res.on('end', () => {
      try {
        const existing = JSON.parse(data);
        finish(existing.app === APP_ID && existing.build === BUILD_ID && existing.instance === INSTANCE_ID);
      } catch { finish(false); }
    });
  });
  req.on('timeout', () => { req.destroy(); finish(false); });
  req.on('error', () => finish(false));
}

function listen(port, tries) {
  server.once('error', (e) => {
    server.removeListener('listening', onListening);
    if (!['EADDRINUSE', 'EACCES'].includes(e.code)) { console.error('启动失败:', e.message); process.exit(1); }
    probeExisting(port, (sameApp) => {
      if (sameApp) {
        const url = `http://localhost:${port}`;
        console.log(`视频下载器已在运行 → ${url}`);
        openBrowser(url).finally(() => process.exit(0));
        return;
      }
      if (tries > 0) listen(port + 1, tries - 1);
      else { console.error('启动失败:没有可用端口'); process.exit(1); }
    });
  });
  function onListening() {
    const url = `http://localhost:${port}`;
    detectProxy((proxyUrl) => {
      ACTIVE_PROXY = proxyUrl;
      PROXY_ON = !!proxyUrl;
      if (proxyUrl) {
        process.env.HTTPS_PROXY = proxyUrl;
        process.env.HTTP_PROXY = proxyUrl;
      }
      console.log(`\n  🎬 视频下载器 → ${url}`);
      console.log(`  引擎: ${YTDLP_CMD ? (YTDLP_CMD.length > 1 ? 'zipapp+python' : 'Windows 独立版') : '❌ 无'}  ffmpeg: ${FFMPEG ? '✓' : '无'}  Node: ${JS_NODE ? '✓' : '无'}  代理: ${ACTIVE_PROXY || '未开(YouTube不可用)'}\n`);
      openBrowser(url);
    });
  }
  server.listen(port, '127.0.0.1', onListening);
}
if (require.main === module) {
  const configuredPort = Number(process.env.PORT);
  const hasConfiguredPort = Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535;
  listen(hasConfiguredPort ? configuredPort : 3210, hasConfiguredPort ? 0 : 9);
}

module.exports = {
  inspectMedia, isXiaohongshuUrl, resolveXiaohongshuUrl,
  extractDouyinVideoId, getDouyinVideoInfo, isDouyinMediaUrl, newJob, isAllowedHost, isAllowedOrigin,
  publicJob, publicDownloadRoute, MAX_JSON_BODY, BUILD_ID, INSTANCE_ID, finishVideoJob,
};
