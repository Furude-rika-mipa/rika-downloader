'use strict';
const path = require('path');
const { normalizeQuality } = require('./video-quality');

const MAX_HISTORY = 500;
const HISTORY_FIELDS = ['id', 'url', 'name', 'quality', 'sourceQuality', 'status', 'err', 'file', 'dir', 'phase', 'attempt', 'note', 't', 'width', 'height'];

function snapshotHistory(jobs) {
  return [...jobs.values()].sort((a,b) => b.t - a.t).slice(0, MAX_HISTORY).map(job => {
    const result = {};
    for (const field of HISTORY_FIELDS) {
      if (field === 'file' && job.status !== 'done') continue;
      if (job[field] !== undefined) result[field] = job[field];
    }
    return result;
  });
}

function restoreHistory(value) {
  if (!Array.isArray(value)) return [];
  const result = [], ids = new Set();
  for (const item of value.slice(0, MAX_HISTORY)) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !/^[0-9a-f]{10}$/.test(item.id) || ids.has(item.id)) continue;
    if (typeof item.url !== 'string' || item.url.length > 16384 || typeof item.dir !== 'string' || item.dir.length > 4096 || !path.isAbsolute(item.dir) || item.dir.includes('\0')) continue;
    try { const u = new URL(item.url); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) continue; } catch { continue; }
    if (!['running','done','error'].includes(item.status)) continue;
    if (item.file !== undefined && (typeof item.file !== 'string' || item.file.length > 4096 || item.file.includes('\0'))) continue;
    if (item.file) {
      if (!path.isAbsolute(item.file)) continue;
      const rel = path.relative(item.dir, item.file);
      if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) continue;
    }
    if (item.status === 'done' && !item.file) continue;
    let quality; try { quality = normalizeQuality(item.quality); } catch { quality = 'best'; }
    const interrupted = item.status === 'running';
    const text = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
    const job = {
      id: item.id, url: item.url, dir: item.dir, file: item.file || '',
      name: text(item.name, 16384) || item.url, quality, sourceQuality: item.sourceQuality === true,
      status: interrupted ? 'error' : item.status,
      err: interrupted ? '上次下载被中断，可以点击“再试一次”。' : text(item.err, 1200),
      phase: interrupted ? '已中断' : text(item.phase, 100), note: text(item.note, 500),
      t: Number.isFinite(item.t) ? item.t : 0, attempt: Number.isSafeInteger(item.attempt) ? item.attempt : 1,
      width: Number.isFinite(item.width) ? item.width : undefined, height: Number.isFinite(item.height) ? item.height : undefined,
      pct: item.status === 'done' ? 100 : 0, speed: '', eta: '', merging: false, accessIssue: ''
    };
    result.push(job); ids.add(job.id);
  }
  return result;
}
module.exports = { MAX_HISTORY, snapshotHistory, restoreHistory };
