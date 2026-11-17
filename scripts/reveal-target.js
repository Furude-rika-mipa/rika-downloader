'use strict';
const fs=require('fs');
function resolveRevealTarget(job, configuredDir, wantsDirectory) {
  const target=wantsDirectory ? configuredDir : job && job.file;
  if (!target) throw new Error(wantsDirectory?'没有可打开的保存目录':'没有找到该任务的文件位置');
  let stat;try {stat=fs.statSync(target);}catch{throw new Error(wantsDirectory?'保存目录不存在或已移动':'下载文件不存在或已移动，请检查原来的保存目录');}
  if (wantsDirectory ? !stat.isDirectory() : !stat.isFile()) throw new Error(wantsDirectory?'保存位置不是文件夹':'下载文件不存在或已移动，请检查原来的保存目录');
  return {target,showDirectory:!!wantsDirectory};
}
module.exports={resolveRevealTarget};
