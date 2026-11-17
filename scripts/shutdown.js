'use strict';
const path = require('path');
const { spawn } = require('child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exited = child => child.exitCode !== null || child.signalCode !== null;

function waitForExit(child, timeout) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(true); };
    child.once('exit', done);
    timer = setTimeout(() => { child.removeListener('exit', done); resolve(exited(child)); }, timeout);
  });
}

async function terminateTree(child) {
  if (exited(child)) return;
  if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error('无法确定下载子进程，未关闭服务。');
  if (process.platform === 'win32') {
    const command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const code = await new Promise((resolve, reject) => {
      const killer = spawn(command, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); reject(new Error('停止下载进程超时。')); }, 8000);
      killer.once('error', error => { clearTimeout(timer); reject(error); });
      killer.once('close', value => { clearTimeout(timer); resolve(value); });
    });
    if (code !== 0 && !exited(child)) throw new Error('无法停止下载子进程，未关闭服务。');
  } else if (!child.kill()) {
    throw new Error('无法停止下载子进程，未关闭服务。');
  }
  if (!(await waitForExit(child, 3000))) throw new Error('下载子进程尚未退出，未关闭服务。');
}

class ShutdownCoordinator {
  constructor() { this.children = new Map(); }
  track(child, resolver = false) {
    this.children.set(child, { resolver });
    const remove = () => this.children.delete(child);
    child.once('exit', remove);
    child.once('error', remove);
    return child;
  }
  async stopChildren() {
    // Browser resolvers can close their isolated browser and temporary profile first.
    const resolvers = [...this.children].filter(([child, info]) => info.resolver && child.connected);
    for (const [child] of resolvers) { try { child.send('cancel', () => {}); } catch {} }
    if (resolvers.length) await Promise.race([Promise.all(resolvers.map(([child]) => waitForExit(child, 3000))), delay(3000)]);
    const deadline = Date.now() + 12000;
    while (this.children.size) {
      if (Date.now() > deadline) throw new Error('下载进程未能及时停止。');
      await Promise.all([...this.children.keys()].map(terminateTree));
    }
  }
}

module.exports = { ShutdownCoordinator, terminateTree };
