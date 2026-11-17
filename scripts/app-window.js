'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');

function appUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !url.port || Number(url.port) < 1024) {
    throw new Error('应用窗口只能打开本机下载器地址');
  }
  url.hostname = '127.0.0.1';
  return url.href;
}

function buildDesktop() {
  return new Promise((resolve, reject) => {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'build-desktop.ps1')],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = data => { output = (output + data.toString('utf8')).slice(-1500); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('桌面程序构建失败：' + output.trim())));
  });
}

async function openAppWindow(value, { executable = path.join(root, '梨花下载器.exe'), spawnImpl = spawn,
  existsImpl = fs.existsSync, buildImpl = buildDesktop } = {}) {
  const args = value === undefined ? [] : ['--url', appUrl(value)];
  if (!existsImpl(executable)) await buildImpl();
  if (!existsImpl(executable)) throw new Error('未找到桌面程序，请运行 scripts/build-desktop.ps1 重新构建');
  const child = spawnImpl(executable, args, { cwd: root, detached: true, windowsHide: false, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
  return executable;
}

if (require.main === module) {
  openAppWindow(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { appUrl, openAppWindow };
