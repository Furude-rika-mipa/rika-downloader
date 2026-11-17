'use strict';

const HOSTS = new Set(['x.com', 'www.x.com', 'm.x.com', 'mobile.x.com',
  'twitter.com', 'www.twitter.com', 'm.twitter.com', 'mobile.twitter.com']);

function isTwitterUrl(value) {
  try { return HOSTS.has(new URL(value).hostname.toLowerCase()); } catch { return false; }
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (!isTwitterUrl(value) || !/^https?:$/.test(url.protocol) || url.username || url.password || url.port) {
    throw new Error('请使用 X / Twitter 官方推文链接');
  }
  const match = url.pathname.match(/^\/(?:[a-zA-Z0-9_]{1,15}\/status|i\/web\/status|statuses)\/(\d{6,25})(?:\/(video|photo)\/([1-9]\d{0,2}))?\/?$/);
  if (!match) throw new Error('请复制包含 /status/数字 的具体推文链接，目前支持帖子中的视频');
  return `https://x.com/i/web/status/${match[1]}${match[2] ? `/${match[2]}/${match[3]}` : ''}`;
}

function attemptArgs(attempt) {
  // A tweet can contain several videos. Keep the application's single-video
  // contract; an explicit /video/N URL is handled by yt-dlp's Twitter extractor.
  return ['--playlist-items', '1', ...(attempt > 1 ? ['--extractor-args', 'twitter:api=syndication'] : [])];
}

function shouldRetry(message) {
  return /guest token|graphql|syndication|querying API|Unable to extract|No video formats|HTTP Error (?:401|403|404|429|5\d\d)|timed out|timeout|TLS|SSL|ConnectionReset|reset by peer/i.test(message);
}

function describeFailure(message) {
  if (/login|log in|sign in|not authorized|private|protected|sensitive|age.?restrict/i.test(message)) {
    return '这条 X / Twitter 视频需要登录或访问权限，目前支持公开可播放的视频。';
  }
  if (/no video|not a video|only.*photo|No video formats/i.test(message)) {
    return '这条推文没有可下载的视频，或指定的视频序号不存在，请检查分享链接。';
  }
  if (/404|not found|does not exist|deleted|removed|unavailable/i.test(message)) {
    return '这条 X / Twitter 推文不存在、已删除或当前不可访问，请检查链接。';
  }
  if (/429|rate.limit|too many requests/i.test(message)) return 'X / Twitter 暂时限制了请求频率，请稍后重试。';
  if (/empty JSON|guest token|graphql|syndication|querying API|403|401/i.test(message)) {
    return 'X / Twitter 暂未提供这条视频的公开播放信息，可能需要登录或受到平台限制，请稍后重试。';
  }
  if (/timed out|timeout|TLS|SSL|handshake|proxy|ConnectionReset|reset by peer|Unable to download (?:webpage|JSON)/i.test(message)) {
    return '连接 X / Twitter 失败，请确认当前网络或代理能打开这条推文，再重试下载。';
  }
  return '';
}

module.exports = { isTwitterUrl, normalizeUrl, attemptArgs, shouldRetry, describeFailure };
