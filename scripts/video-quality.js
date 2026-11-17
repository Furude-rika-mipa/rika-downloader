'use strict';

const PRESETS = Object.freeze({
  best: { label: '自动最佳', height: 0 },
  '2160p': { label: '4K 优先', height: 2160 },
  '1080p': { label: '1080p 优先', height: 1080 },
  '720p': { label: '720p 优先', height: 720 },
});

function normalizeQuality(value = 'best') {
  if (typeof value !== 'string' || !Object.hasOwn(PRESETS, value)) {
    const error = new Error('请选择自动最佳、4K、1080p 或 720p');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function qualityArgs(value) {
  const preset = PRESETS[normalizeQuality(value)];
  // Prefer the largest available resolution at or below the target. A single
  // higher-resolution source remains usable; no transcoding or upscaling occurs.
  return preset.height ? ['--format-sort-force', '--format-sort', `res:${preset.height}`] : [];
}

function qualitySuffix(value) {
  const quality = normalizeQuality(value);
  return quality === 'best' ? '' : ` [${PRESETS[quality].label.replace(' ', '')}]`;
}

function resolutionSuffix(value) {
  const quality = normalizeQuality(value);
  return quality === 'best' || quality === '2160p' ? ' [%(width)sx%(height)s]' : '';
}

module.exports = { PRESETS, normalizeQuality, qualityArgs, qualitySuffix, resolutionSuffix };
