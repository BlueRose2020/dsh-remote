# 安装与传输层

把插件挂进 DSH、把 QQ / 微信接上，以及出事时怎么退回来。
只想跑起来的话看 README 的「安装」一节，这里是细节和排查。

## 它和 DSH 到底是怎么绑在一起的

**插件本身是一个自包含的包，代码里没有一行属于 DSH。** DSH 只有三处知道它存在：

| 谁 | 在哪 | 提交到 git 吗 |
|---|---|---|
| **挂载行**（唯一的"配置"） | `$DSH_HOME/profiles/web/cordis.patch.yml` 里的那个 `insert` 条目 | 不提交；仓库里给的是同名**模板** `cordis.patch.yml`，复制过去即可 |
| 运行期设置（管理员密码、通道开关…） | `$DSH_HOME/settings.yaml` | 不提交（有密码） |
| 运行期状态（锁定的会话、截哪块屏…） | `$DSH_HOME/storages/remote-channel.json` | 不提交 |
| 追踪日志 / 预览图 | `$DSH_HOME/logs/` | 不提交 |

也就是说：**把 `profiles/plugins/dsh-plugin-remote` 整个目录搬到别处（或推到 GitHub），
插件就是完整的**；别人拿到之后放到自己机器的同一个相对位置、把模板里那一行粘进自己的 profile
补丁，就装好了。运行需要的只有 Python 侧依赖：`pip install -r requirements.txt`（Pillow）。
`ws`（OneBot 的 WebSocket 客户端）不用装：它是 **DSH 自己**的依赖，插件跑在 DSH 进程里，
按 profile 的 `node_modules` 解析 —— 只有在本机跑 `tools/*.mjs` 里的测试时才要 `npm install`。

配到别的机器上时注意两件事：

- 那行 `name: ../plugins/dsh-plugin-remote/lib/index.js` 是**相对补丁文件**解析的，所以插件目录
  必须在 `$DSH_HOME/profiles/plugins/` 下（或者把 `name` 写成绝对路径 / npm 包名）。
- `assets/avatars/default.png` 是插件自带的默认头像（卡片和面板都用它）。想换成自己的：
  把自己的图存成同目录下的 `me.png`（本地覆盖，`.gitignore` 排除），或者在配置里写
  `avatar: <你的图片路径>`，再或者在面板里上传一张（上传的那张优先）。

仓库里还带了两个只有开发时才想跑的东西，用 `.gitignore` 排除了：`tools/one-off/`
（当初改代码用的一次性补丁脚本，纯记录）和 `ui-preview-*.png` / `.probe-state.json`（工具的产物）；
`assets/avatars/me.png` 也在排除之列 —— 那是"本机的头像"，不属于仓库。

## onebot（QQ）需要的前置

目标：让**你自己的 QQ 号**变成可编程的（不是官方机器人，官方机器人是独立身份，用不了你的号）。

> **别用一键包（OneKey）：它现在是坏的。** 2026-09 实测，`NapCatInstaller.exe` 会先
> 自己下载 QQ，而它写死的 `dldir1.qq.com` 下载地址已经 404，必然停在
> 「检查QQ安装包… → 开始下载QQ… → HTTP状态码: 404 → 下载QQ失败」。
> 所以走下面的 **Shell 版**：直接用你已经装好的 QQ，根本不需要下载 QQ。

1. **确认 QQNT 版本 ≥ 40768**。当前安装的是 QQNT，路径 `C:\Program Files\Tencent\QQNT`
   （`launcher.bat` 是从注册表 `HKLM\SOFTWARE\WOW6432Node\...\Uninstall\QQ` 的
   `UninstallString` 反推出这个目录的，路径改动过就要留神）。缺运行库时装
   [VC++ 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe)。
2. 从 [NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载
   **`NapCat.Shell.zip`**（约 30 MB，不是 OneKey 那个），解压到任意目录即可 ——
   本次实测解压在 `D:\tool\programming_tools\NapCat\NapCat.Shell`，
   校验值 sha256 `bcdd8bdb9e44bd0cf6a90908e572141787fd9e98cb8d8eecc5adf25bbdcabb94`。
3. **完全退出 QQ**（`KillQQ.bat` 可代劳），然后在解压目录里
   **以管理员身份运行** `launcher.bat`（Windows 11 用 `launcher.bat`，
   Windows 10 用 `launcher-win10.bat`）。它会以 NapCat 方式拉起 QQ。
   - 必须管理员：它要改写 `...\QQNT\versions\<版本>\resources\app\package.json`
     （`C:\Program Files` 普通用户不可写）。非管理员时 `launcher.bat` 会尝试用
     `wt.exe` 自我提权，一旦 UAC 被拒/`wt.exe` 不可用就**一闪而过** —— 直接右键
     「以管理员身份运行」最稳。
   - **不要从 DSH 的工具调用里启动它**：那样 NapCat/QQ 会挂在 DSH 进程树下，
     DSH 一重启就把 QQ 一起带走（微信就是这样被关过一次）。必须你自己右键运行。
4. **登录**。首次只能扫码：控制台会打出二维码，`cache\qrcode.png` 也会写一份，
   但**刷新二维码时那个文件不会同步更新**，扫它必然报「二维码已过期」
   （`ErrType: 1 ErrCode: 3` 就是过期，不是版本问题）。登录过一次之后改用
   **快速登录**，再也不需要扫码：

   ```bat
   cd /d D:\tool\programming_tools\NapCat
   launcher.bat <你的QQ号>
   ```

   启动日志里出现 `正在快速登录 <QQ号>` 就是走了快速登录；控制台启动时也会列出
   「可用于快速登录的 QQ」候选。
5. **开 OneBot WebSocket 服务端**。不用点 WebUI，直接改
   `config\onebot11_<QQ号>.json` 的 `network.websocketServers` 最快 —— 字段名必须和
   NapCat 内部 schema 一致（`name/enable/host/port/messagePostFormat/reportSelfMessage/
   token/enableForcePushEvent/debug/heartInterval`）：

   ```json
   "websocketServers": [
     {
       "name": "dsh",
       "enable": true,
       "host": "127.0.0.1",
       "port": 3001,
       "messagePostFormat": "array",
       "reportSelfMessage": true,
       "token": "",
       "enableForcePushEvent": true,
       "debug": false,
       "heartInterval": 30000
     }
   ]
   ```

   `reportSelfMessage: true` 让「手机 QQ → 我的电脑」这类**发给自己的消息**也能上报。
   这个文件**不热加载**：改完必须重启 NapCat，启动日志里出现
   `WebSocket服务: 127.0.0.1:3001 ... 已启用` 才算生效。
6. 配置插件：

```yaml
        transports:
          - onebot
          # - wechat-local

        onebot:
          url: ws://127.0.0.1:3001
          accessToken: ''      # 和 NapCat 里设的保持一致
          ownerId: ''          # 留空：只有一个好友时自动用它
          target: private
```

> **只有一个好友不用填号**：`ownerId` 留空时，插件连上后会调 `get_friend_list`，
> 唯一的好友自动成为收件人，同时也成为**唯一能下指令的人**（白名单）。好友多于一个时，
> 插件不再猜，要把目标 QQ 号写进 `ownerId`，把允许操控的号写进 `privateAllowFrom`。
> 「我的电脑」（发件人=自己）由 `acceptSelfMessages: true` 放行。

> **2026-09-27 实测通过的组合**（QQ `9.9.36-53489` + NapCat `v4.18.28` + Shell 版）：
> 启动时会看到这条 error：
> `[Core] [Packet] PacketBackend 不支持当前QQ版本架构：9.9.36-53489-x64` ——
> **它是无害的**：登录、收消息、发消息（含 733 字的 `#status` 卡片）全部正常，
> NapCat 会退回到 hook 路径。只要看到
> `正在快速登录 <QQ号>` → `WebSocket服务: 127.0.0.1:3001 ... 已启用` → 插件侧
> `onebot (...): ready`，这条路就是通的。
>
> 排查时看两个地方：`$DSH_HOME/logs/remote-channel.jsonl`（inbound → command → reply
> 三段，能看出消息进没进、回执发没发出去）和 NapCat 的 `launch.log`（`接收 <- 私聊`
> / `发送 -> 私聊`）。
>
> NapCat 的 `launch.log` 如果用 `cmd /c '... 2>&1' | Tee-Object` 抓，中文会变成乱码
> （PowerShell 按 GBK 解了 UTF-8）—— 那是**显示问题，不是错误**。想不留乱码就先用
> `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`，或者干脆
> 用纯 cmd 重定向 `cmd /c "launcher.bat <QQ号> > launch.log 2>&1"`。

## wechat-local（微信）需要的前置

```powershell
python -m pip install -r requirements.txt
```

还要装 Windows 的**简体中文 OCR 语言包**：
设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 可选语言功能 → 光学字符识别。

> **插件既不启动微信、也不拉它的窗口来"自我修复"。** 微信必须由你自己打开并登录 ——
> 从 DSH 的工具调用里启动的进程挂在 DSH 进程树下，DSH 一重启就会把它一起带走
> （这正是"关掉 DSH 微信也跟着关"的原因）。
> 微信没在跑 / 没登录 / 文件传输助手窗口不在屏幕上时，插件做两件事：
> ① 在**另一个还有效的通道**（比如 QQ）发一条「通道掉线」提醒；
> ② 在 `#status` / `#channels` 里标注 `未就绪（ready）`、`（上一次读取被跳过：…）`
> 和「→ 需要你自己打开微信并登录」。
> 发送仍然需要文件传输助手窗口在前台（剪贴板限制），这是微信通道的固有代价；不想被打断就用 QQ。

---

## 安全默认值

这个插件能在你机器上执行命令，所以默认值必须偏保守：

- **只处理带 `commandPrefix`（默认 `#`）的消息**，其他一律忽略
- **`onebot` 私聊有一个推导出来的白名单**（空 ≠ 任何人）：
  1. 配了 `privateAllowFrom` → 用它
  2. 否则配了 `ownerId` → 只用它
  3. 否则只有一个好友 → 就用那个好友
  4. 三个都没有 → 放开但**每次都会告警**，并在 `#status` 里标 ⚠
- **群消息默认全部忽略**，必须显式加进 `groupAllowFrom`
- **限流**：`maxCommandsPerMinute`（默认 20），超了丢弃并提示一次，防止有人刷屏排队
- **`wechat-local` 发送前会 OCR 确认当前打开的是文件传输助手**，否则拒发，绝不误发到别的聊天
- **`wechat.passive`（默认开）**：轮询只读屏幕上已有的内容，绝不打开/切换/滚动窗口
- 报告内容会截断（`reportMaxChars`），不会把整篇日志发到聊天里

`#status` 会直接告诉你当前谁能发指令，方便核对：

```
· QQ · OneBot (ws://127.0.0.1:3001) [onebot]：就绪
    可发指令者：20002（来自 the single friend）
```

---

## 回滚

安装前的原始补丁留在
`$DSH_HOME/profiles/web/cordis.patch.yml.bak-before-wechat`（内容是 `[]`）。
想彻底停用插件：把插件行设 `disabled: true`（保留代码），或者用这个备份覆盖回去，
也可以直接删掉 `$DSH_HOME/profiles/plugins/dsh-plugin-remote` 整个目录。
