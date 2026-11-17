# 给安装者和 Agent

这是 Windows 10/11 x64 本地应用。这里说明安装和验收流程，不授予读取账号、上传文件或更改系统安全设置的权限。

## 用户可复制的指令

> 请从我给的仓库地址安装视频下载器。先检查 README、AGENTS.md、安装脚本和固定依赖清单，按我的安装位置偏好选择可写目录。克隆或解压源码，找到下载器根目录，运行 `scripts/install-windows.ps1 -Json`。只有返回 `ok: true`、`started: true`，且实际服务的构建与组件状态匹配，才告诉我安装成功并启动桌面程序。不要复制他人的配置、账号或 Cookie，不要修改全局执行策略；失败时报告原因，不跳过校验。

项目根目录是独立的 Windows 电脑版。已有 `梨花下载器.exe` 时直接双击；源码包缺少 EXE 时使用项目根目录中的启动脚本构建。

## 安装与验收

1. 确认 Windows 10/11 x64，遵循接收者的安装位置偏好，选择有写权限的目录。不需要管理员权限；不要覆盖同名目录里的其他项目。
2. 使用用户提供的项目文件夹，或先解压用户提供的源码包。不要在压缩包内运行，不要直接执行网页返回的脚本字符串。
3. 阅读 `README.md`、`AGENTS.md`、两个安装脚本和依赖清单。只使用固定版本与仓库内 SHA-256；无需 `npm install`，无需全局安装 Node、Python 或 FFmpeg。
4. 在下载器根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Json
```

安装入口准备并校验运行组件，启动隐藏的本地服务，返回一行 JSON。`-Json` 不打开窗口，Agent 可使用 `bin/node.exe scripts/app-window.js <返回的 url>` 按需构建并打开原生桌面程序。普通用户双击 `梨花下载器.exe`；源码包不含 EXE 时，在项目根目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-desktop.ps1 -Launch` 构建并启动。桌面界面使用 Windows Forms，不依赖浏览器窗口或 WebView。

| 字段 | 验收条件或用途 |
|---|---|
| `ok`、`started` | 均为 `true` |
| `url` | 实际选中的 localhost 地址，不可猜成固定的 3210 端口 |
| `build` | 与该地址 `/api/config` 的 `build` 一致 |
| `instance` | 与 `/api/config` 一致，区分不同安装目录 |
| `root` | 本次选择的安装目录 |
| `pid` | 该实例的服务进程号，仅供本机诊断 |
| `log` | 本地安装日志；可读，不自动上传 |

5. 读取返回地址的 `/api/config`，确认 `ytdlp`、`ffmpeg`、`jsRuntime` 都是 `true`。重复运行只复用同目录、同构建的实例，不会混用另一份安装的配置。
6. 只准备组件、不启动时，安装入口可增加 `-NoStart`，此时 `started: false` 属于预期结果。本机测试文件不包含在源码仓库中。

## 下载用户指定的视频

优先操作桌面程序。程序方式操作时，先 GET 本地服务根路径，读取响应中的进程临时 `API_TOKEN`，再向同源 `/api/download` POST `{"url":"用户提供的视频链接"}`，带上 `X-Video-Downloader-Token` 和 `Content-Type: application/json; charset=utf-8`。

取得任务 ID 后，轮询 `/api/jobs` 的对应任务。`running` 是进行中，`done` 才是完成，`error` 必须报告原因。不要把任务创建成功或进度到 100% 当成验证成功。失败任务可向 `/api/retry` 提交原 ID。临时令牌只用于本机，不保存到仓库或发送给第三方。

只安装工具时，不要自行选取长视频测试，也不要读取个人浏览器账号；用户提出下载任务后，再使用对应功能。

## 失败、更新与卸载

- 下载或 SHA-256 校验失败：查看本地日志，检查网络后重试；不能删掉校验或接受任意文件。
- 目录不可写：更换可写位置，不关闭安全软件、不修改全局执行策略、不盲目提权。
- 已有安装目录：先检查项目身份和未提交改动；不执行 `git reset --hard`，不覆盖个人配置。
- 更新前确认没有运行中的下载。Windows 锁定旧组件时，先正常结束该实例再重试，不反复使用 `-Force`。
- 停止服务只针对已核对的本工具 PID：程序路径须是本次安装的 `bin/node.exe`，命令行须指向该目录的 `server.js`。禁止结束所有 Node、Chrome 或 Edge 进程。
- 卸载先停止已核对的实例，再删除本工具安装目录。下载视频保存在用户选定位置，应单独保留。

## 分享

Windows 发布包包含桌面程序、源码和说明，不包含运行组件、个人配置、Cookie、数据库和媒体文件；首次启动时会准备运行组件。

私有仓库需要访问权限，不能作为陌生人无需登录的公开地址。公开发布前应核对源码包内容与依赖许可；本地打包不会自动上传或修改仓库可见性。
