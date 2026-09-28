# dsh-plugin-remote — 远程通道

用手机上的聊天软件远程指挥 DeepSeek Harness：**选工作区 → 派活 → 收汇报（含截图）**。

这是一个 **DSH 插件**。它挂在 DSH 的服务和事件上（会话、工作区、Agent 生命周期、工具注册），
自己不做业务；"消息怎么进出"交给可插拔的**传输层**。

```
┌──────────────┐   prompt    ┌───────────────────────────────┐
│  传输层       │ ──────────► │  DSH                          │
│  onebot (QQ) │             │  sessionController / agents    │
│  wechat-local│ ◄────────── │  workspaceRegistry            │
└──────────────┘   汇报/截图  └───────────────────────────────┘
```

---

## 1. 能力

| 能力 | 说明 |
|---|---|
| 问题通知 | `agent/error`、`ask_user_question`、审批请求发生时，主动推到你手机 |
| 远程派活 | 你发的消息作为**用户消息**进入指定会话，Agent 立刻开始干活 |
| 及时汇报 | 每轮结束把 Agent 的回答原文推回聊天 |
| 工作区选择 | `#ws` 列出工作区，`#ws <序号\|路径>` 选定 |
| 会话选择 | `#sessions` 列出会话（活动 + 已关闭，可恢复），`#use <序号\|id前缀\|完整id>` 切换 |
| 新建会话 | `#new [路径]` 在选定工作区开新会话并切过去 |
| 截图 | `#shot [窗口标题]` 把桌面截图发给你；Agent 也可用 `remote_screenshot` 工具 |
| 紧急停止 | `#stop` 取消当前会话正在跑的任务 |
| Agent 主动汇报 | `remote_notify` 工具，Agent 可以自己给你发消息 |
| 让 Agent 知道有人在看 | 插件往系统提示词注入一段 `## Remote operator`，告诉它有远程操作者、什么时候该用 `remote_notify` / `remote_screenshot`；没有通道就绪时这段自动消失 |

## 2. 传输层对比

| | `onebot`（QQ） | `wechat-local`（微信） |
|---|---|---|
| 原理 | OneBot 11 协议，本地 WebSocket | 截图 OCR 读 + 剪贴板粘贴写 |
| 碰不碰电脑 | **完全不碰** | **读取完全不碰**（`wechat.passive` 默认开）；**发送会抢键盘鼠标** |
| 稳定性 | 高（协议级，文字精确） | 中（OCR 有误差，长文本/代码易错） |
| 依赖 | NapCatQQ / Lagrange.Core / LLOneBot | 微信 PC 版 + Python + `winsdk` |
| 建议 | **首选** | 备用，只在你离开电脑时开 |

> `wechat.passive: true`（默认）保证**轮询绝不打开/切换/滚动微信窗口**：
> 它只读屏幕上已经存在的内容，聊天窗口不在就跳过，不会把窗口从你手里抢走。
> 用 `python tools/passivity_check.py --close-chat-first` 可以自己验证这一点
> （关掉聊天窗口 → 轮询若干次 → 断言窗口没被重新打开、前台窗口和鼠标位置都没变）。
> 只有**发送**那一下必须把微信切到前台，这是剪贴板粘贴的硬限制。

两个可以同时开：通知广播到所有就绪通道，回复走消息来源的那个通道。

### 安全默认值

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

## 3. 安装

插件放在 `$DSH_HOME/profiles/plugins/dsh-plugin-remote`，通过 profile 的补丁层挂载。

`$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: remote-channel
      # 必须写到入口文件：Node 的 ESM loader 不接受目录 URL
      name: ../plugins/dsh-plugin-remote/lib/index.js
      config:
        enabled: true
        transports:
          - onebot
          # - wechat-local
```

profile 的 `patchReload: live` 会**热加载配置**，改完即生效；但**代码改动不行**，
详见第 7 节「改代码之后必须重启」。

### 它和 DSH 到底是怎么绑在一起的（想单独发布时看这节）

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

配到别的机器上时注意两件事：

- 那行 `name: ../plugins/dsh-plugin-remote/lib/index.js` 是**相对补丁文件**解析的，所以插件目录
  必须在 `$DSH_HOME/profiles/plugins/` 下（或者把 `name` 写成绝对路径 / npm 包名）。
- `assets/avatars/me.png` 是作者自己的默认头像（卡片和面板都用它）。想换成自己的：直接替换这个
  文件，或者在配置里写 `avatar: <你的图片路径>`，再或者在面板里上传一张（上传的那张优先）。

仓库里还带了两个只有开发时才想跑的东西，用 `.gitignore` 排除了：`tools/one-off/`
（当初改代码用的一次性补丁脚本，纯记录）和 `ui-preview-*.png` / `.probe-state.json`（工具的产物）。

### 回滚

安装前的原始补丁留在
`$DSH_HOME/profiles/web/cordis.patch.yml.bak-before-wechat`（内容是 `[]`）。
想彻底停用插件：把插件行设 `disabled: true`（保留代码），或者用这个备份覆盖回去，
也可以直接删掉 `$DSH_HOME/profiles/plugins/dsh-plugin-remote` 整个目录。

### onebot（QQ）需要的前置

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

### wechat-local 需要的前置

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

## 4. 手机上怎么用

所有指令在聊天里发给机器人账号（QQ 好友 / 文件传输助手）：

```
#help                     用法（卡片里是一张表格，命令 + 短写一列对齐）
#status                   通道 + 会话状态（含最近一条回答、谁能发指令）
#sessions                 列出活动会话（按最近活动排序，带「刚刚 / 12 分钟前」）
#tree                     会话分叉树 + 工作区树（出图最清楚，见「可视化树」）
#reply <话>               回「刚刚给我发消息的那个会话」，不动目标；不带话就切过去
#use 2                    切到第 2 个会话（也可以 #use 名字）
#ws                       列出工作区
#ws 秋招                  按名字选定工作区（短写 #w）
#ws D:\proj\my-project    按路径选定（**目录不存在会帮你新建**，见下）
#ws new 新项目            新建一个工作区（不带路径时建在当前工作区旁边）并选定
#new [path]               在该工作区新建会话并切过去（同样会补建目录）
#clear                    取消锁定，目标改回「跟随最近活跃会话」
#shot                     截屏发过来（默认只截主屏，原生分辨率不缩放）
#shot 2                   只看一次第 2 个屏（不改默认）；#shot 全部 = 所有屏拼一张
#shot screen              看截图默认用哪个屏；#shot screen 2 / 全部 / 主屏 改默认
#shot 记事本              只截某个窗口（比整屏清楚得多）
#stop                     停止当前任务
#on / #off                总开关：关=不转发不汇报不通知，但仍接控制指令
#channels                 看每个通道（微信/QQ）的开关与就绪状态
#switch qq off            关掉某个通道（#switch wechat on 开回来；#qq off 也行）
#img on|off              回复用图片卡片（默认）还是纯文字
#again                    按当前形式重发上一条回答（卡片刷过去了/锁屏没看到时用）
#mode                     看/切换工作模式：不同模式命令不同（#mode list 列全部）
#deliver queue|steer     派活是排队等这一轮跑完，还是插入正在跑的那一轮
#perm                    看/切换目标会话的权限预设（完全权限要管理员密码）
#perm r|w|f <password>   权限简写：r=只读 w=标准 f=完全（f 要密码）
#marks                    列出可分叉的回合编号
#fork 12                  从回合 #12 分叉并切过去
#file start               开始收附件；之后发一条 # 开头的消息就连附件一起进会话（仅 QQ）
#auth                     看授权状态；设了管理员密码后，先发一次 #<password>
#lock                     立刻锁回去，下一条指令需要重新授权
#rename <name>            重命名当前会话
#rename ws <name>         重命名当前工作区

#帮我把简历投了，投完截图给我     ← 不带内置命令就是派活
```

> 文档和卡片里的命令一律用 **ASCII 占位符**（`<n|name|path>`、`<password>`），中文只出现在说明里 ——
> 中文别名（`#授权`、`#提交`、`#题2`…）照样能用，只是不再写进用法说明里。

Agent 提问（选择弹窗）时，聊天里这样答：

```
#1                        选第 1 个选项（编号不存在时，原文当自定义回答）
<text>                    自定义回答当前这一题（不带 # 也行 —— 直接回那句话）
#>  #<  #q2               下一题 / 上一题 / 直接跳到第 2 题
#1 3                      多选题：选第 1、3 项
#answer 提交              强制把「提交」两个字当自定义文字（不想被当成指令时）
#submit                   提前交卷，没答的题按「跳过」提交
#stop                     跑歪了就停掉这一轮（提问期间也照样能停）
```

> 有提问在等你答的时候，**你发的消息就是答案**：带不带 `#` 都算，`1` 和 `#1` 都是选第 1 项，
> 其它内容一律当自定义回答。
>
> **但内置指令照样能用**：`#status`、`#use`、`#tree`、`#reply`、`#help`… 在提问期间不会被当成回答
> （以前会被吞掉，于是"一个会话卡在提问上就把整台机器锁住了"）。`#stop` 也照旧能停掉那一轮。
> 判断规则很简单：带 `#` 且是**已知指令** → 执行指令；其余（纯文字、编号、切题、`#submit`）→ 当答案。

短写随命令一起写在卡片表格里（`#status (s)`），不用再对照一张单独的简写表。

派活后 Agent 开始执行，**每轮结束会把回答推回聊天**。

截图有三条来路：你主动发 `#shot`；Agent 判断画面重要时自己调 `remote_screenshot`；
或者把 `reportWithScreenshot` 打开，每条汇报都附一张（重，默认关）。

> 提醒：微信通道的截图和文字一样要抢一次前台（剪贴板限制）；QQ 通道不需要。

### 截图清晰度 & 截哪块屏

图糊过一轮，原因有两个，都改了：

1. **以前默认把整屏缩到 1600px 宽**（4480×1440 的桌面 → 1600×514，只剩 1/8 像素）。
   现在 `screenshotMaxWidth` 默认 **0 = 原生不缩放**，抓屏本来就是屏幕 DC 的 BitBlt，
   像素级精确；真要缩的时候用 LANCZOS，小字比默认滤镜清楚得多。
   顺带修了一个坑：`0` 以前会被下游 `Math.max(320, …)` 抬成 320px 宽。
2. **以前默认拼所有显示器**（两块屏并排 = 手机上每个窗口只剩 1/4 宽）。现在默认 **只截主屏**。

手机上还差一步：聊天里的图片是**压缩预览**，点开「查看原图」才是全清晰度。

| 想干什么 | 发什么 |
| --- | --- |
| 用默认屏幕截一张 | `#shot` |
| 只看一次第 2 个屏 | `#shot 2` |
| 只看一次所有屏拼图 | `#shot 全部` |
| 改默认（重启也记得） | `#shot screen 2` / `#shot screen 全部` / `#shot screen 主屏` |
| 看当前默认 + 屏幕清单 | `#shot screen` |
| 只截某个窗口（最清楚） | `#shot 记事本` |

屏幕清单由 Windows 自己枚举（`EnumDisplayMonitors`），按 `\\.\DISPLAY1`、`DISPLAY2` 排序，
所以写下来的序号插拔显示器后含义不变；序号不存在时回一句「这台机器没有第 N 个显示器」，
而记住的序号对应的屏幕被拔掉时，会自动退回主屏而不是截失败。
汇报附带的截图（`reportWithScreenshot`）同样走这个默认屏。

### 信息类回复默认出图

`#status` / `#channels` / `#help` / `#sessions` / `#ws` 这类**信息类回复默认渲染成一张 PNG 卡片**
再发出去 —— 手机聊天里按比例字体排版的多行状态很难看，同一段文字画成卡片一眼就能读完。
`#img off` 退回纯文字（或 `imageReplies: false` 改默认）。

- **每轮汇报也走同一套**：`#img on` 时 Agent 的回答同样画成卡片，`#img off` 时是纯文字 ——
  报告和回答不会一个出图一个不出。
- **通知也一样**：进度兜底、执行出错、"需要你回答"、通道掉线这些推送走同一套渲染，
  不会偷偷留成一段纯文字。
- **连一行回执也能出图**：配置项 `richAcks: true`（你的部署已经开着）让"已切换 / 已投递"这类
  短回执也画成卡片，于是**所有**回复都跟着 `#img` 一个样式。嫌吵就改成 `false`。
- **`#again` 按"当前"设置重发上一条**：设置开着就补一张卡片，关着就补一段文字。
  卡片在锁屏时漏看了、或者你刚在两种形式之间切换过，用这条补。
  （只有**渲染过的**回复才会成为重发目标 —— 否则 `#again` 会把上一条回执再发一遍。）
- 渲染在 `bridge/text_image.py`（Pillow + `msyh.ttc`），调用方是 `lib/text-image.js`；
- **任何一步失败都会退回纯文字**（没装 Pillow、没字体、通道不能发图）—— 卡片只是好看，不能让指令没人理。

#### 卡片长什么样

卡片支持一小撮 Markdown（Agent 的回答天然就是这个形状），另外带一个头像和页脚：

| 写法 | 画出来 |
| --- | --- |
| `# / ## / ###` | 分级标题（一级标题下面加一条蓝色短线） |
| `- ` `* ` `1. ` `· ` | 项目符号 / 编号，换行带悬挂缩进 |
| `> ` | 引用：灰条 + 弱化文字 |
| ` ``` ` | 代码块：灰底等宽面板 |
| `---` | 分隔线 |
| `标签：值` | 标签弱化色、值正文色，**整张卡共用一条值列（像表格）** |
| `命令 ⇥ 短写 ⇥ 说明`（TAB 分隔） | **三列表格**：前两列等宽字体，逐行严格对齐 |
| `命令 │ 短写 │ 说明` | 同上，竖线也能当列分隔符（纯文字聊天里不会塌掉） |
| `**粗**` `` `代码` `` `*斜*` | 行内加粗 / 等宽 / 斜体 |
| 行内的 `#命令` | 正文段落里给蓝色强调（表格里**不上色**，靠列对齐就够了） |
| 行内的路径（`D:\…`、`/home/…`） | **等宽 + 弱化色**，太长时中间省略成 `D:\…\DSH\秋招` |
| `标签：很长的值` | 值塞不进标签右边那一列时，自动移到**下一行**左对齐（不让长路径被挤到卡片边缘） |

#### 路径是单独一类（"一大堆路径"那种卡片就是被它毁掉的）

以前路径和正文一样画：比例字体、满色、**逐字符换行**。于是
`D:\tool\programming\DSH\test\archive-2026\branch` 会先被右推到卡片边缘，再断成
`…\branc` + `h` —— 一张卡片里出现三次这种断口，整张就废了。现在：

- 路径被识别出来单独成 run（`PATH_RE`，认盘符、UNC、`/home` 这类 POSIX 前缀，
  但**不认 `https://`**），用等宽字体 + 弱化色画 —— 一眼能看出"这是路径，不是句子"；
- 超过 `DSH_IMAGE_PATH_MAX`（默认 44 字符，`0` = 不省略）时**中间省略**，保留盘符和最后两段
  （`D:\…\archive-2026\branch`）：头是哪个盘不重要，尾是哪个项目才重要；
- **只在分隔符处换行**：`archive-2026\branch` 再也不会被切成两半；
- `标签：值` 的值放不下时**下沉到下一行**左对齐，而不是右推到边缘。

这三条由一个独立的 Python 套件盯着：`python tools/path_check.py`（14 项，省略规则、
run 切分、URL 不误判、换行原子性）。

- **`#help` 就是一张三列表**：

  ```
  #status      #s      会话名 / 工作区 / 状态
  #sessions    #ls     列出活动会话（含已关闭的）
  #ws new              新建一个工作区并选定：<name|path>
  ```

  命令、短写、说明各占一列，等宽字体保证每行的 `#status` / `#s` 从同一个 x 开始；
  参数和选项写在说明列里，命令列保持干净的纯命令名。
- **表格不上色**：列对齐本身已经把它画成表格了，再给每个命令上色只会让那列变吵；
  正文里的 `#命令` 仍然是蓝色，因为那里它是个"指路牌"而不是一列。
- 纯文字模式（`#img off` 或卡片渲染失败）里，TAB 会展开成两个空格，
  所以同一份文案在聊天里也是可读的。
- **列表也是同一张表**：`#sessions` / `#ws` / `#status` 里的「其它会话」都用
  `序号 ⇥ 名字 ⇥ 状态 · 工作区`，目录单独占一行（第二、三列留空 = 续行，渲染器把
  空的首列当成真列，所以路径会对齐在第三列下面）。两个列表长得一样，读法也一样：

  ```
  【会话】
  1  remote   ← 当前目标 · 秋招
              D:\tool\programming\DSH\秋招
  2  alpha    秋招
              D:\tool\programming\DSH\秋招
  3  gamma    已关闭
              D:\proj\gamma

  发 #use <序号|名字> 切过去（会锁定）；已关闭的会在派活时自动恢复。
  ```
- 卡片标题保持短（`【会话】`、`【工作区】`），用法提示放到底部一行 —— 33px 的长标题会把
  表格挤扁，而标题本来就只是"这是哪张卡"。`#ws` 报错时也会把同一张表贴出来（可直接选）。
- 头像默认用插件自带的 `assets/avatars/me.png`（圆形裁剪 + 超采样描边）；
  想换就设配置项 `avatar` 指到别的图片，设成 `-` 则只画标题不画头像。
- 头像文件不存在**不会报错**，只是退回没有头像的标题栏。
- 页脚是 `DeepSeek Harness · 时间`，时间取渲染那一刻。
- 布局改成只依赖 `DSH_IMAGE_AVATAR` / `DSH_IMAGE_FOOTER` 两个环境变量后，
  命令行仍然可以直接用：`python bridge/text_image.py in.txt out.png 900`（打印 `宽x高`）。

### 回答怎么回到手机：两条路，只有一条靠自觉

| 路径 | 谁负责 | 什么时候发 |
| --- | --- | --- |
| **每轮汇报**（自动） | 插件监听 `agent/turn-stopping` | 一轮结束时，把这一轮最后一条助手消息推过来 |
| **`remote_notify` 工具**（自觉） | Agent 自己决定 | 中途报进度、报卡住、报"要问你" |

**工具是"Agent 想起来才发"，插件那条是"一轮结束必然发"**。所以"执行完没收到消息"永远不该
由工具负责 —— 它只管中途插话，收尾靠插件。

插件那条的**范围**由两个开关决定：

| 配置 | 效果 |
| --- | --- |
| `reportOnlyTargetSession: true`（默认） | 只汇报**目标会话**的轮次（其它会话、子代理不推） |
| `reportOnlyRemoteTurns: false`（本部署） | 目标会话**每一轮都汇报**，包括你在网页里自己聊的那些轮次 |

> 这里默认是 `true`，也就是**只有"从聊天派活"的轮次才汇报** —— 你在浏览器里打的字、一轮跑完
> 是不会有消息的。这就是"我这段回复为什么没发到手机"的答案。现在改成 `false`：先用 `#use`
> 把要收汇报的会话锁定，之后无论是聊天派活还是网页里自己聊，收尾都会推过来。

- `#status` 里会写明当前范围：`汇报：目标会话的每一轮都汇报 / 只汇报「从聊天派活」的轮次 / 已关闭`。
- 被跳过的轮次（不是目标会话，或该模式下你在电脑上起的轮次）都会写进 debug 跟踪
  （`report-skipped` 带原因），所以"为什么这条没发"以后有据可查。
- 汇报的开头永远是 `工作区 - 会话名`，多条会话并行时也知道是谁在说话。

### 多会话：回「刚刚那个」，而不是先切过去

开着好几个会话时，真正的摩擦不是"有几个会话"，而是**每次都要先想清楚切到谁**。所以：

```
#sessions        按最近活动排序（最近的在最前），每行都带「刚刚 / 12 分钟前 / 3 小时前」
                 并标出「← 当前目标」「刚发过言」「运行中 / 已关闭」
#reply 先别动    直接发给「刚刚给我发消息的那个会话」，**目标不动**
#reply           不带话 = 把目标切到它（等于 #use，但不用查它是几号）
#use <序号|名字>  老办法，按 #sessions 的序号或名字切
```

- 「刚刚发言的那个」由插件维护：**汇报、通知、提问**都会记住是谁在说话（写进状态文件，重启也在）。
- 一条会话**多于一个**时，汇报末尾会带一行 `回它：#reply <话>`，所以你在手机上不用记这些。
- `#reply <话>` 只回它一次、不改目标；回执里会写明「目标没变」，免得你以为切过去了。
- 目标会话同时镜像进设置命名空间（`pinSessionId`），所以**网页里点树上的会话**和聊天里发 `#use`
  写的是同一份状态，两边永远不会各说各话。

### 可视化树：`#tree` 和网页里点着切

`#tree` 出**三段**（卡片里是等宽对齐的，比纯文字好读得多）：

```
【DSH 会话树】
## 最近活跃（发 #use <编号> 切过去）
1  remote             ● 运行中 · 刚刚 · ← 当前 · 秋招
2  抓岗位的 explore    ○ 空闲 · 2 分钟前 · 秋招
3  秋招助手            ○ 空闲 · 4 分钟前 · 秋招
4  分叉实验            × 已关闭 · 2 小时前 · archive-2026
## 会话分叉（谁从哪来）
remote              #1 · ● 运行中 · 刚刚 · ← 当前
├─ 抓岗位的 explore  #2 · ○ 空闲 · 2 分钟前 · 子代理
└─ 分叉实验          #4 · × 已关闭 · 2 小时前 · 分叉
## 工作区 → 会话
秋招/
├─ remote           #1 · ● 运行中 · 刚刚 · ← 当前
│  └─ 抓岗位的 explore  #2 · ○ 空闲 · 2 分钟前 · 子代理
└─ 秋招助手         #3 · ○ 空闲 · 4 分钟前
archive-2026/
└─ 分叉实验         #4 · × 已关闭 · 2 小时前 · 分叉
```

- **编号就是 `#use` 的编号**，三段用的是同一份（`#sessions` 也是它），所以在任何一张卡里看到
  `#3`，回一句 `#use 3` 都是同一个会话。编号排在右边那一列的最前面，扫一眼就能挑。
- **最近活跃**就是那台"选起来方便"的机器：按活跃时间排序的平铺列表，配 `#reply <话>` 可以
  直接回最后发言的那个。
- **分叉树**用 `header.parentSession`：`#fork` 出来的分支和子代理都在这里，一眼看出谁从哪来。
- **工作区树**是同一批会话换个分组看：不在任何工作区里的落在「未分组」——那正是 `#ws fix` 要修的。
- 字型只用等宽字体里确定有的字符（`├ └ ─ │ ● ○ × · ←`），不会出现豆腐块；这一段有 e2e 的
  "豆腐块守卫"盯着。
- 卡不下 40 个会话时后面会说明还有几个没画；`#sessions` 永远给完整编号列表。

网页里还有一棵**能点的**树：头像 → 打开配置页 → 会话树。点任意一行就是把远程目标切过去
（写 `pinSessionId`，和 `#use` 同一份状态）；「取消锁定」= 回到跟随最近活跃会话。子代理那几行是灰的
——它们不能被派活。

### 配置页：点头像打开

会话标题栏**最右边**那个小圆头像点开是个小面板（总开关 / 微信 / QQ / 工作模式按钮 / 当前目标），
再点「打开配置页」就是一整页：

- **通用**：头像（选图 → 裁剪）、昵称、签名、三个开关、回复形式（出图/纯文字）、
  投递方式（排队/插入）、管理员密码。
- **会话树**：一棵**网页该有的样子**的树 —— 缩进 + 每个祖先一条细分隔线表示层级（不再是手机卡片
  那种 `├─`/`└─` 字符画，那套只留给静态图）、CSS 画的折叠箭头（折叠时旋转，不依赖字体里有没有
  `▸`）、工作区标题后面跟它有多少个会话、当前目标整行高亮 + 左边一条蓝杠。
  **点名字 = 切目标；点名字左边那片箭头/缩进（整条 gutter）= 折叠或展开整支** —— 折叠目标不是那个
  18px 的小箭头，而是箭头加上它左边的缩进条：在一张 40 行的表里瞄小方框，就是"折叠点不动"的来源。
  工作区分组**整行都能点**（它没有别的含义），不再只有标题可点。
  折起来的行会显示 `+3`（藏了几个）；如果藏起来的里面有**当前目标**，那一行会补一个 `← 当前`
  —— 否则你一折，就再也看不出指令发到哪儿去了。折叠状态由整页持有，**切到别的标签再回来还在**。
- **每个模式一页**：模式在 profile 里自己声明字段，页面自动生成表单。

> 手机卡片上的 `#tree` 仍然用 `├─/└─` 字符画：它是一张静态图，没有缩进、没有箭头可用，等宽字符
> 画的树就是那儿最合适的表达。两个媒介，两套画法，这个差异是有意的。
>
> 树行是个 `div[role="button"]` 而不是 `<button>`：折叠箭头本身是真按钮，而按钮里不能再套按钮 ——
> React 的 DOM API 会放行，但 HTML 解析器会把整行拆开，键盘和读屏也没法用。这个坑是静态界面预览
> 抓到的（预览把组件渲染成 HTML 字符串，于是走了真正的解析器）。
>
> **树形的几何是内联的**（箭头的盒子、箭头形状、缩进分隔线），颜色/hover/动画才在样式表里。
> 原因见下面「为什么界面和你看到的不一样」——"样式表没到"这件事必须不能把折叠控件变成浏览器
> 默认按钮的方框。

#### 为什么界面和预览图不一样（一个真踩过的坑）

DSH 会**把插件的客户端 bundle 热更新进当前文档**（HMR 轮询 bundle 的 mtime/size，通过 SSE 推
重载）：模块被重新求值，但**文档没换**。于是第一版注入的那个 `<style id="dsh-plugin-remote-style">`
一直留在页面上，而 `ensureStyles()` 原来只判断"标签在不在"—— 在就直接返回。结果就是你那边一直是
**最新的 JS + 最旧的 CSS**：折叠箭头、缩进分隔线、工作区计数、当前行蓝杠这些规则全都没生效，
折叠按钮退化成浏览器默认的那个小方框。

修法三条（都在 `lib/client.js`）：

1. `ensureStyles()` 改成**对内容做核对**（inject / refresh / current 三态），热更新和刷新都能把
   样式表带到当前版本；
2. 树形的几何**内联**，任何样式表（我的、别人的、旧的）都没法把折叠控件变成方框；
3. 每次加载都把"**文档里的样式表是哪个版本**"写进设置命名空间的 `uiProbe`，宿主再把它写进
   `debugLog` 一行 `ui-probe` —— 这样"你看到的和我以为的是不是一回事"可以不靠截图来判断：

   ```bash
   python -c "import json;[print(json.loads(l)['probe']) for l in open(r'$DSH_HOME/logs/remote-channel.jsonl',encoding='utf-8') if '\"ui-probe\"' in l][-3:]"
   ```

   正常应该看到 `current css=…` 或 `refreshed css=…`（`injected` 是全新页面，`no-document` 只会在
   离线测试里出现）。

**给以后的我**：客户端改动之后，"我改了文件" ≠ "你屏幕上就是这样"。热更新只换模块、不换文档，
所以凡是**注入式**的东西（样式表、主题变量、全局事件）都要按"可能已经有一份旧的"来写。

界面上是**一套自己的样式表**（`lib/client.js` 里注入的一段 `rc-` 前缀 CSS），不是内联样式堆出来的：

- 颜色全部取自 DSH 的主题变量（`--dsw-alias-*`），所以**明暗主题跟着应用走**，不会自己发亮；
- 开关是真正的开关（滑块轨道，底下仍是一个真 checkbox，键盘和读屏照常可用）；
- 行有 hover、输入有 focus 描边、面板/整页有入场动画、树行有 hover 与当前项高亮；
- 面板 = 圆角卡片 + 阴影；配置页 = 居中 sheet + 分段式标签 + 卡片分组。

裁剪那一步的坐标换算（拖到哪、缩到多少、最后取源图哪一块）是纯函数
（`cropSourceRect` / `clampPan`），被 `tools/client-half-check.mjs` 逐个数值验过 —— 这类
"截出来的头像总是偏一点"的问题，看截图看不出来。

模式自己的表单长这样（`modes` 里加 `fields` 和 `prompt`）：

```yaml
remote-channel:
  modes:
    - name: persona
      label: 人格
      description: 换一种说话方式
      fields:
        - key: persona
          label: 人设
          type: text          # text = 多行文本框（string / bool / number / select 也有）
          rows: 6
          placeholder: 例：你是一只猫娘，说话带「喵」
          help: 会注入系统提示词
        - key: tone
          label: 语气
          type: select
          options: [冷静, 热情]
          default: 冷静
      prompt: |
        从现在起按这个设定说话：{{persona}}
        语气：{{tone}}
```

- `fields` 里填的东西存进设置命名空间的 `modeData`（一整块 JSON），**页面自动生成表单**，
  加字段不用改一行代码。
- `prompt` 是这个模式激活时**注入系统提示词**的文本，`{{字段}}` 会被替换成你填的值
  （`#mode persona` 之后下一条消息就生效，改完不用重启）。
- 只有**当前模式**会注入；切回 `default` 就清空。默认模式没有表单也没有提示词。
- 模式还能固定行为：`imageReplies` / `richAcks` / `messageMode` 写在模式里就压过全局设置，
  页面上会写清"这个模式固定了哪一项"。

### 派活的投递方式：排队 or 插入

`sessionController.prompt` 支持两种模式，插件把它做成了开关：

| 模式 | 行为 | 什么时候用 |
| --- | --- | --- |
| `queue`（默认） | 消息进队列，等当前这一轮跑完再处理 | 常规派活；回答会晚，但不打断 |
| `steer` | 立刻插入正在跑的那一轮 | 发现它跑偏了，马上纠正 |

`#deliver steer` 时如果目标会话**没有在跑**，Host 会拒绝这次 steer，插件自动退回排队并在回执里
写明「已排队投递」——不会因为模式选错就把消息弄丢。

> 这条指令原来叫 `#mode`，现在 `#mode` 是**工作模式**（见下一节），投递方式挪到了 `#deliver`
> （`#queue` / `#steer` 也能直接发）。

### 工作模式：一套行为 + 一套命令

一个「工作模式」就是一个命名包裹：**回复形式 / 投递方式 / 认哪些命令**。默认只有一个
`default`（工作），什么都能用；你在 profile 补丁里加几个，手机上就能一键切换：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
remote-channel:
  modes:
    - name: focus            # 手机上用来切换的名字
      label: 专注             # 卡片/回执里显示的名字
      description: 只看状态，别的都关掉
      commands: [status, sessions, help, mode]   # 空 = 全部命令
      imageReplies: false    # 可选：这个模式固定出纯文字
      richAcks: false
      messageMode: queue     # 可选：这个模式固定排队/插入
```

```
#mode                    列出所有模式（当前那个标「← 当前」）
#mode focus              切过去；命令表、#help、卡片按钮同时跟着变
#mode default            换回全功能
```

- **`commands` 是白名单，只对"内置命令"生效**：表外的内置命令会被拒绝并回你可用列表；
  不在命令表里的话（也就是**派活的自然语言**）照旧转发 —— 收窄的是命令，不是你的嘴。
- **`help` 永远可用**且**表格跟着模式走**：被关掉的命令直接不出现，不用自己猜。
- **`mode` / `help` / `auth` / `lock` 永远可用**，否则切进一个窄模式就出不来了。
- 模式**不持久化**：DSH 重启回到 `default`，免得某个窄模式在你忘记的时候还锁着。
- 网页右上角那个头像面板里也有模式按钮，和 `#mode` 写的是同一份状态。

### 授权：密码只用在需要权限的地方

**默认只在一处要密码：切完全权限**（`#perm f`）。普通指令 —— 派活、`#status`、截图、
`#ws`、问答 —— 都不要密码，因为这是你自己的手机、你自己的聊天窗口。

```
#perm f <password>        ← 只有这一处必须给管理员密码
```

密码在 设置 →「插件」→「远程通道」→ **管理员密码**（只写不可读，忘了就在这里重设）。

如果哪天手机可能落到别人手里，把配置项 `accessGate` 改成 `all`，**所有指令**就都要先
发一次密码：

```
#<password>              ← 授权一次（#lock 锁回去）
```

`accessGate: all` 时的细节：

- **粒度**：授权按**对话**发放（QQ 私聊 / 群 / 微信文件传输助手各算一个），群里授权的是
  "这个群"，不是某个人。
- **只在内存里**：DSH 一重启就要重新发一次密码 —— "崩了之后门自己开了"是这类功能最不能有的
  失败模式。
- **防爆破**：密码错一次回一句"密码不对（第 N 次）"，连错 `accessMaxFailures`（默认 5）次
  暂停 60 秒。普通闲聊（不带前缀）不算尝试；已经认识的内置指令（比如 `#status`）也不算尝试，
  只会回一句"需要先授权"，不会白白耗掉次数。
- `accessTtlMinutes` 设成 N 可以让一次授权 N 分钟后自动过期（默认 0 = 本次运行内有效）。

两种模式下都成立：

- **门在附件之前**：没授权时连发文件都不会落到磁盘上（`accessGate: all` 时）。
- **密码不进日志**：授权那条消息本身就是密码，插件在 debug 跟踪和通道的 info 行里都会把它打成
  `***`（`#perm f <password>` 同理）。
- 别用 `status`、`help` 这类**指令名**当密码：那会让那条指令永远被当成密码校验。
- `#auth` 随时可以看密码与指令门的状态。

> 实话说一句：密码本身存在 `$DSH_HOME/settings.yaml` 里是明文（"只写不可读"是接口层的保证，
> 磁盘上没加密）。它防的是"别人拿到你的聊天窗口"，不是"别人拿到这台电脑"。

### 用聊天回答 Agent 的提问（选择弹窗）

Agent 调 `ask_user_question` 时，网页端会把输入框变成问答面板；现在**聊天里也能答**：

| 你发 | 效果 |
| --- | --- |
| `#1` 或 `1` | 选第 1 个选项（**编号不存在就当自定义回答**，不会回你"编号无效"） |
| `周三之前投完` | 自定义回答当前这一题（`#` 可加可不加） |
| `#1 3` | 多选题：选第 1、3 项 |
| `#>` `#<` | 下一题 / 上一题（只翻页，不算作答） |
| `#题2` | 直接跳到第 2 题 |
| `#提交` | 提前交卷：没答的题按"跳过"（`{selected: []}`）提交 |
| `#答 提交` | 强制把"提交"这两个字当自定义回答，而不是指令 |
| `#stop` | 停掉卡住的那一轮；提问期间唯一还需要 `#` 的写法 |

- **两边同时有效**：插件把"网页问答面板"和"聊天"**赛跑**，谁先答就听谁的 ——
  所以你在电脑前点面板照常，在外面用手机回 `#1` 也行。网页端先答了，聊天就只是收个通知。
- **答完自动走**：单选题选完自动跳到下一题；所有题都有答案时自动交卷，
  回执里列出"哪题 → 答了什么"。
- **提问期间 `#` 消息 = 回答**：这一轮正卡在问题上，转发新指令只会排在它后面永远等不到，
  所以此时不带指令含义的 `#` 消息一律当自定义回答。想强制转发就等答完，或者用 `#stop` 取消这一轮。
- 不想让聊天接管，把配置 `answerQuestionsFromChat` 设成 `false` 就退回"只通知"。

### 权限：完全权限要密码，确认就在聊天里完成

`#perm` 列出权限预设（来自 Host 的 `permissionPresets` 服务）并显示当前值；`#perm <名字>` 切换。
**危险预设（`danger-full-access`：全盘读写且不再弹审批）必须先给密码**：

```
#perm f <password>            ← 简写：r 只读 / w 标准 / f 完全
```

- 这里的密码就是上面那个**管理员密码**（同一份，见「授权」一节）：设置 →
  「插件」→「远程通道」→ 管理员密码。
- 它是 schemastery 的 `role('secret')` 字段 —— **只写不可读**：客户端读接口把它整个抹掉，
  所以设置卡片只能写入、谁都读不回来，只有 Host 进程（也就是校验它的这段代码）能取到值。
- 密码为空时，危险预设**在远程根本无法打开**（安全默认值）：先去设置里设一个。
- 连续 5 次错密码锁定 10 分钟，日志只记"被拒绝"，**不记密码本身**。
- 这就是你要的"不要再远程确认一次"：**你的指令 + 密码本身就是确认**，
  电脑那端不需要点任何东西。（也因此，密码泄漏等于房间钥匙泄漏 —— 别用常用密码。）
- 没有设置提供者的部署（离线测试）可以用 profile 补丁里的 `fullAccessPassword` 兜底，
  但那里是明文，属于次选；配置里的 `accessPassword` 是同一个密码的别名。

### 选工作区 / 会话：按名字就行

`#ws <序号|名字|路径>` 三种写法：

```
#ws 秋招                    按名字（精确优先，其次是唯一子串）
#ws 2                       按列表序号
#ws D:\proj\new-thing       按路径 —— **目录不存在会直接建出来**（mkdir -p 语义）再注册
```

- 名字撞车时**不会乱猜**：回一句"有 N 个都叫这个名字"并列出候选。
- **不像路径的名字不会变成目录**：`#ws qiu` 打错了，只会回"没有找到工作区"，
  不会在你服务器的工作目录旁边建一个叫 `qiu` 的文件夹（这个坑以前真的会踩）。
- `#use` 同理：`#use beta`（名字）、`#use 2`（序号）、`#use session-9748…`（id 前缀）。

不想打完整路径还可以 `#ws new <name|path>`：只给名字时会建在**当前工作区旁边**（同一个父目录下），
回执写清楚"新建"还是"已存在"，并顺手帮你选定（`#new` 就会用它）。

### 新建的会话为什么会在「未分组」里，以及怎么修

DSH 的侧边栏分组不是"看目录"，而是工作区记录里的一份**成员名单**（`sessionIds`）。
两者的区别在会话创建时体现出来：

| 主机接口 | 效果 |
| --- | --- |
| `create({ cwd })` | 会话跑在那个目录里，但**不加入**任何工作区 → 侧边栏显示「未分组」 |
| `create({ workspaceId })` | 目录由工作区决定，并且 Host 会调用 `workspace.attachSession()` 把它记进成员名单 → 显示在组里 |

所以插件早期版本的 `#new`（只传 `cwd`）就会造出"目录对、但挂在未分组"的会话 —— 你那次
`#ws test` → `#new` 就是这样：它老老实实建在 `D:\tool\programming\DSH\test`，却因为
没走 `workspaceId`，`test` 项目的成员名单里没有它。

现在：

- **`#new` 走 `workspaceId`**：先按路径找到（或创建）对应项目，再把它的 id 交给 Host，
  所以新会话一定落在正确的分组里；回执会写「工作区：<名字>（<路径>）」。
- 万一项目建不出来（权限、磁盘），会退回旧的 `cwd` 方式继续建会话，并在回执里直说
  「（没有对应的项目，所以它会出现在「未分组」里）」—— 不再静默。
- **`#ws fix`**：把**已经**落在「未分组」、但目录确实属于某个工作区的会话挂回去
  （调用 `workspace.attachSession`，侧边栏通过同一个投影立刻刷新）。`#ws` 列表里如果检测到
  这种会话，会自己提示"有 N 个会话……发 `#ws fix` 把它们挂回去"。
- 路径比较做了 Windows 归一化（大小写、`/` 与 `\`、结尾反斜杠），否则 `D:/x/` 和 `D:\x`
  会被当成两个目录，然后你就会得到一个"目录明明对却没进组"的会话。

### 开关的语义（重要）

- `#off` 是**安静开关，不是杀开关**：它停掉"转发指令 / 汇报 / 通知"，但通道继续连着，
  所以你在外面随时 `#on` 就能叫醒它。真要彻底停，改配置或关掉 NapCat —— 手机上关死了
  就再也开不回来了。
- `#switch <通道> off` 会**拒绝关闭你正在用的那条通道**（"关掉它你就联系不上我了"），
  要关就从另一条通道发，或者加 `force`。
- 开关状态写进 `$DSH_HOME/storages/remote-channel.json`（`enabled` / `disabledChannels`），
  重启 DSH 依然记得。

### 在 DSH 里从哪看这个插件

- **会话标题栏最右边的小圆头像**：点开是插件的**正门**。弹出的面板放常用的那一两个开关
  （总开关、微信、QQ、工作模式按钮、当前目标），点「打开配置页」进入**整页配置**：通用
  （头像 / 昵称 / 签名 / 开关 / 回复形式 / 投递方式 / 管理员密码）、**会话树**（点一行就切目标）、
  以及**每个模式一页**（模式自己的表单，见「配置页」一节）。
  **头像是裁出来的**：选图 → 拖动 + 缩放 → 圆内那部分才会成为头像（社交软件那种做法），
  确定后导出 192×192 的 JPEG（十几 KB）存进设置，宿主再把它落成
  `$DSH_HOME/storages/remote-channel-avatar.png` 供卡片渲染；旁边的「移除」回到默认头像。
  昵称和签名会签在**每张卡片的页脚**（`昵称 · 签名 · 时间`）；头像旁边的小圆点是通道就绪指示。
  （它排在 `utilities` 那一行的**最后一个**（`order: 1000`），也就是「⋯」的右边。再往右那 28px 是
  官方「展开右侧栏」按钮占的**单占位**槽位，插件注册进去会 shadow 掉它，而它的展开动作拿不到
  （在 sidebar-right 插件自己的 store 里），所以这里选择**不占那个位置** —— 位置上只差最后一个图标。）
- **设置 → 「插件」**：同一份设置的折叠版（控制卡片，标题「远程通道」）。三个开关 ——
  总开关、微信、QQ —— 点一下即写入 Host 的 `remote-channel` 设置命名空间并**立刻生效**
  （`applies: live`），和聊天里的 `#on/#off/#switch` 是同一份状态：聊天里改，卡片立刻变；
  卡片上改，`#channels` 立刻变。连接状态、目标会话、收发计数不在卡片里，发 `#channels` /
  `#status` 看（卡片底部也这么写）。
- **设置 → 「插件列表」**：Host 的插件清单（完整名称 / 启用于 / 配置状态 / 禁用条件 /
  失败原因）。只读，能看到 `remote-channel` 这一行和它加载的文件路径。
- **命令行**：`dsh --profile web --dump-config` 打印合成后的完整配置树（包含本插件的
  `id`、`name` 和全部生效配置）；`dsh plugin --profile web list` 管 profile 的插件包。

#### 卡片是怎么实现的（给以后的自己看）

浏览器半是**手写**的 `lib/client.js`，没有构建步骤：

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-remote', factory: (require) => { … } })
```

宿主把每个插件包的 `dsh.client` 声明（在 `package.json` 里，`platform: 'web'`）变成一个
`/plugins/??…` 的 combo bundle，所以这个文件会被**原样**提供出去 —— 只要能通过
`require('react')`（react 在平台种子表里）就不需要打包器。卡片通过
`ctx.settingsScope.bind({ namespace })` 读同一份设置，用 `ctx.slots.inject('settings.plugin.item', …)`
注册进 `key = 命名空间` 的 keyed slot；头像 chip 注册在会话标题栏的
`conversation.session.header.utilities`（`order: 1000`，所以排在「本地打开」和别的插件右边）。
配置页不占新槽位：它是 chip 自己渲染的一层 fixed 覆盖层，这样模式的表单不用去改 Host 的设置
schema。会话树的数据直接用槽位给的 `useSessions` / `useWorkspaces` 标准 props，**不跟宿主来回
RPC**；"点一行切目标"就是往设置里写 `pinSessionId`，和聊天里的 `#use` 写同一个字段。
`tools/client-half-check.mjs` 用假的 loader + 假 react（按组件分格子的 hook 模型）把这条路径
离线测了一遍（注册、slot key、开关写入、面板、配置页、会话树点选、模式表单、命名空间不可用时
渲染空）。
**不许跨插件 import 组件**（客户端的 purity gate），所以卡片没复用
`PluginCard` 的样式，ui 上是自己画的；要更像原生就再引 `@deepseek-ai/dsh-client-ui-primitives`。

## 5. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `transports` | `[wechat-local]` | `onebot` / `wechat-local`，可同时开 |
| `commandPrefix` | `#` | 只有这个前缀开头的消息才当指令；设成 `''` 则全部转发 |
| `targetSession` | `auto` | `auto` 跟随最近活跃的顶层会话，也可写死会话 id |
| `remoteControl` | `true` | 是否把消息转成会话 prompt |
| `reportOnTurnEnd` | `true` | 每轮结束把回答推回聊天 |
| `reportOnlyRemoteTurns` | `true` | **只汇报本插件触发的轮次**，你在网页端自己聊天不会被推到手机 |
| `reportOnlyTargetSession` | `true` | 只汇报目标会话，避免子代理刷屏 |
| `reportWithScreenshot` | `false` | 每条汇报都附一张桌面截图（重，默认关；要图用 `#shot`） |
| `reportMaxChars` | `1500` | 单条汇报字数上限 |
| `agentAwareness` | `true` | 向模型注入一段说明：可能有远程操作者，用 `remote_notify` 主动汇报。没有通道就绪时这段自动消失 |
| `progressEveryToolCalls` | `0` | 长任务里每 N 次工具调用推一条进度（默认关，靠 Agent 自己汇报；这是它忘事时的兜底） |
| `maxCommandsPerMinute` | `20` | 每分钟最多处理多少条指令，防止刷屏排队；`0` 关闭 |
| `debugLog` | 空 | 追加式 JSONL 追踪（收到什么、匹配到哪条命令、回复有没有送达）。排查时开上 —— 你人不在机器前，DSH 自己又会缓冲 stdout，没这个日志「命令被吞了」是完全不可见的 |
| `notifyOnError` / `notifyOnQuestion` / `notifyOnApproval` | `true` | 三类"卡住"通知 |
| `notifyOnTurnEnd` | `false` | 每轮结束都发一条"本轮结束"（比 `reportOnTurnEnd` 吵） |
| `wechat.passive` | `true` | 轮询绝不打开/切换/滚动微信窗口，只读屏幕上已有的内容 |
| `screenshots` | `true` | 是否允许截图 |
| `screenshotMaxWidth` | `0` | 截图最长边；**0 = 原生不缩放**（最清楚），缩的时候用 LANCZOS |
| `screenshotMonitor` | `primary` | 截哪块屏：`primary` / `all` / 序号 `2`；`#shot screen` 在聊天里改 |
| `screenshotProvider` | `auto` | `auto` 用插件自带截图；`channel` 用传输层的 |
| `pythonPath` | `python` | 截图助手用的 Python |
| `imageReplies` | `true` | 信息类回复出图；`#img on/off` 在聊天里改 |
| `imageMaxWidth` | `900` | 卡片最长边像素 |
| `avatar` | 空 | 卡片头像路径；空=用自带的 `assets/avatars/me.png`，`-`=不画头像。面板里上传的头像优先于它 |
| `nickname` / `signature` | 空 | 卡片页脚署名（`昵称 · 签名 · 时间`）；面板里能直接改 |
| `modes` | `[]` | 工作模式：`{name, label, description, commands, imageReplies, richAcks, messageMode, fields, prompt}` 的数组；`#mode` 切换，见「工作模式」与「配置页」两节 |
| `modes[].fields` | `[]` | 模式自己的表单：`{key, label, type, placeholder, help, options, rows, default}`，`type` 为 `string`/`text`/`bool`/`number`/`select`。配置页自动生成控件，值存进 `modeData` |
| `modes[].prompt` | 空 | 这个模式激活时注入系统提示词的文本，`{{字段}}` 会替换成表单里的值 |
| `accessPassword` | 空 | 与 `fullAccessPassword` 同一个管理员密码的别名（设置卡片里的值优先） |
| `richAcks` | `false` | 连一行回执也出图；开着表示**所有**回复都跟着 `#img`（一行回执默认保持纯文本） |
| `accessGate` | `off` | `off`=密码只用于完全权限（默认）；`all`=所有指令都要先授权 |
| `accessTtlMinutes` | `0` | 一次授权有效多久；`0`=本次运行内（重启重新验证） |
| `accessMaxFailures` | `5` | 连错几次密码暂停校验（暂停 60 秒）；`0` 关掉暂停 |
| `answerQuestionsFromChat` | `true` | 是否允许聊天回答 `ask_user_question`（与网页问答面板赛跑） |
| `stateFile` | 空 | 持久化状态文件；空表示 `$DSH_HOME/storages/remote-channel.json` |
| `dedupeMs` | `45000` | 相同内容在这个窗口内只发一次 |

传输层自己的设置分别在 `wechat:` 和 `onebot:` 两个块里：

| 块 | 键 | 默认 | 说明 |
|---|---|---|---|
| `wechat` | `pollIntervalMs` | `5000` | 多久扫一次文件传输助手 |
| | `statusIntervalMs` | `60000` | 多久复查一次微信登录状态 |
| | `passive` | `true` | 轮询绝不打开/切换/滚动窗口 |
| | `pythonPath` / `bridgeScript` / `requestTimeoutMs` | — | bridge 进程相关 |
| `onebot` | `url` | `ws://127.0.0.1:3001` | NapCat 的 OneBot WebSocket 地址 |
| | `accessToken` | 空 | 和 NapCat 里设的一致 |
| | `ownerId` | 空 | 通知目标；留空则用「只有一个好友」自动发现 |
| | `target` | `private` | `private` 或 `group` |
| | `privateAllowFrom` / `groupAllowFrom` | 空 | 谁能发指令（见上文白名单规则） |
| | `acceptSelfMessages` | `true` | 接受自己账号发的消息（QQ「我的电脑」场景） |
| | `reconnectMs` | `5000` | 断线重连间隔 |

### 目标会话是怎么定的

按优先级：

1. `#use` / `#new` 显式锁定过的会话（**会写进状态文件，重启后仍然有效**）
2. `targetSession` 配置里写死的会话 id
3. 最近活跃的顶层会话
4. 最后一次派活去的会话（同样持久化）

第 4 条是专门为**重启后没有打开的会话**准备的：DSH 重启后没有任何 Agent 存活，
这时手机发来的指令会按第 4 条恢复上次那个会话，而不是回一句"没有可用会话"。

状态文件长这样（可以手工预置，让重启后仍然指向你在用的会话）：

```json
{
  "pinnedSessionId": null,
  "pinnedWorkspace": null,
  "lastTargetSessionId": "session-xxxxxxxx-....",
  "serverCwd": "D:\\tool\\programming\\DSH\\秋招",
  "updatedAt": "2026-09-27T18:00:00.000Z"
}
```

`serverCwd` 由插件自己写入（每次目标变化时刷新），`restart-dsh.py` 读它来保证
从同一个目录重启。删掉这个文件就回到纯自动探测 —— 但那样重启助手就得靠 `--cwd`。

## 6. 工具（Agent 可调）

| 工具 | 用途 |
|---|---|
| `remote_notify` | 主动给用户发消息（报错、卡住、长任务完成） |
| `remote_screenshot` | 截屏发给用户，可只截某个窗口 |
| `remote_status` | 查看各通道连接状态与目标会话 |

## 7. 开发

```bash
node --check lib/index.js
node tools/onebot-e2e.mjs         # OneBot 全链路，对着 mock 服务器跑，不需要 NapCat
node tools/card-check.mjs         # 卡片渲染：Markdown 子集、头像头栏、缺头像/空文本的降级
node tools/ratelimit-check.mjs    # 限流：超限丢弃并提示一次
node tools/bridge-reconnect-check.mjs  # 杀掉 bridge 子进程，验证插件自愈
node tools/smoke.mjs              # 微信通道冒烟（默认不发真消息，要发加 --send）
node tools/client-half-check.mjs  # 浏览器半：卡片注册、slot key、开关写入（不需要浏览器）
python tools/path_check.py        # 卡片里的路径：省略规则、run 切分、只在分隔符处换行
node tools/ui-preview.mjs --out "$DSH_HOME/logs"   # 把真实组件渲染成图（双主题），不用重启
python tools/passivity_check.py --cycles 4   # 后台读屏不碰桌面（在 poll 前后各测一次焦点/光标）
node tools/inbound-check.mjs      # 独立进程验证入站：真发一条微信，看会不会转成会话 prompt
python tools/passivity_check.py --close-chat-first   # 证明轮询不碰电脑（不开窗、不动焦点和鼠标）
python tools/image_clipboard_check.py  # 验证发图用的剪贴板 CF_DIB 往返（不发任何消息）
python tools/bridge_orphan_check.py    # 验证父进程死后 bridge 会自己退出（重启不泄漏进程）
python tools/live-check.py         # 探测「正在运行的实例」是哪个版本（旧版本会明确报出来）
python tools/drive.py '[{"id":1,"cmd":"status"}]'   # 直接戳 bridge
dsh --profile web --dump-config   # 看插件行在 profile 里组合成了什么
```

`tools/onebot-e2e.mjs` 覆盖 209 项：连接、动作回执、单好友自动发现、白名单拦截陌生人、
`#status/#help/#sessions/#tree/#reply/#use/#ws/#ws new/#new/#clear/#shot/#stop/#again/#auth/#lock`、派活转发、
**按名字选工作区与会话（`#ws 秋招`、`#use beta`，以及"不像路径的名字"必须被拒绝而不是建成目录）**、
轮次汇报（含 **`#img on` 时汇报与通知都以图片送达**）、**截图的屏幕选择**、
**多会话手感（`#sessions` 按最近活动排序并带相对时间、`#reply <话>` 发给最后发言的会话且**不改目标**、
裸 `#reply` 切过去、提问卡住时指令照样能用、提问结束后仍能正常作答）**、
**可视化树（最近活跃的编号列表 + 分叉树 + 工作区树都画出来、分叉嵌在父会话下、
标出当前目标与活跃时间、且只用等宽字体里确定有的字符）**、
**聊天回答提问（编号选择 / 越界编号当自定义 / 自由文本 / 不带 `#` 的裸回答 / `#stop` 仍能打断 / `#>` `#<` `#q2` 切题 / `#submit` 跳题交卷 /
桌面端先答也算 / 取消时按 aborted 结算）**、**管理员密码只用在完全权限上（`accessGate: off` 免密、`all` 才门控全部指令）**、
**工作模式（`#mode list` 列出并标记当前、切换、受限模式拒绝表外命令但放行自然语言、`#mode default` 回全功能、未知模式报错、
模式自己的表单存进 `modeData`、`prompt` 按表单值渲染后注入系统提示词、切走就清空）**、
**设置命名空间（模式按钮的清单、页面写 `pinSessionId` 能移动聊天里的目标、聊天改目标会镜像回去）**、
**投递方式 `#deliver queue|steer`（含 steer 被拒时自动退回排队）**、
**汇报范围（只汇报远程派活 / 目标会话每一轮都汇报）**、**来源标签（工作区 - 会话名）**、进度兜底、系统提示词注入、本地轮次不汇报、非目标会话不汇报、
状态持久化、**已关闭会话的恢复与派活**、**工作区新建**、权限预设与 `r/w/f` 简写（含密码门）、
前缀过滤、群白名单、工具注册与调用、附件收集，外加一条静态检查：
**分发器里出现的每个指令别名都必须在 `COMMAND_WORDS` 里**（授权门靠它区分"指令"和"密码"）。

> 夹具里有一个**真的（很小的）设置服务**，所以上面那两条"设置命名空间"的用例是真的走了
> `register` → `get` → `watch` → `update` 全程。它抓到了一个只有真跑才看得见的 bug：
> 注册回调在 `apply()` 期间就调用 `modeList()`，而它依赖的 `const` 声明在文件更下面 ——
> 时序死区抛错、被 try 吞掉，整个设置命名空间静默消失（卡片没了、面板也读不到东西）。

`tools/card-check.mjs` 覆盖 22 项：自带头像存在且是正方形 PNG、纯文本卡片仍然成立、
Markdown 子集（标题变大、代码围栏画成面板）、长文本换行不变宽、头像头栏更高但不更宽、
**TAB / `│` 分隔的表格行（含单行表、两格行、与普通段落混排）**、
头像文件缺失/空文本时的降级、CLI 的 `WxH` 契约。

`tools/path_check.py` 覆盖 14 项：路径省略（保留盘符与最后两段、超长单段、POSIX、`0` 关闭）、
路径 run 的切分（`#命令` 不受影响、`https://` 不误判）、以及"只在分隔符处换行"的原子性。

`tools/client-half-check.mjs` 覆盖 72 项：浏览器半（`lib/client.js`）在假 loader + 假 react 下
离线渲染一遍（hook 单元格按组件分开，`children` 也照 React 的约定放进 `props.children`，
否则"组件其实什么都没渲染"也会通过）—— 设置卡片与**标题栏头像 chip** 的 slot 注册与排序、
开关写入、模式按钮写 `mode`、面板、**配置页**（通用页写昵称/密码/投递方式、会话树点选写
`pinSessionId`、取消锁定、模式表单写 `modeData`、模式页说明文字）、命名空间不可用时两边都渲染空，
外加**裁剪坐标换算**（居中/放大/拖动/越界夹紧/竖图）、`relativeTime` 的逐值断言，以及
**树与折叠**（层级用"祖先分隔线"而不是字符画、哪些行有可用箭头、折起来子树消失且只影响那一棵树、
`+n` 计数、藏了当前目标时那一行补 `← 当前`、**再点一下就展开**、**点缩进 gutter 也能折且不会误切目标**、
工作区整行可点、全部折叠/展开、折叠不动目标、**折叠状态跨标签存活**）。

`tools/ui-preview.mjs` 覆盖 17 项，并且是**看图**用的：它不需要 DSH、不需要 React、不联网 ——
用一个 80 行的迷你渲染器把这个插件**真实的组件**（同一个 bundle，`require('react')` 换成
迷你实现）渲染成 HTML，再套上 `ensureStyles()` **真正注入的那段 CSS**（用假 `document` 截获），
最后交给系统自带的 Chrome/Edge `--headless --screenshot` 出图：

```bash
node tools/ui-preview.mjs --out "$DSH_HOME/logs"
# → ui-preview-light.png / ui-preview-dark.png：头像面板、配置页三个标签、折叠后的树、头像裁剪，双主题并排
```

> 为什么值得有：客户端的改动本来只有"重启 + 刷新 + 人眼"这一条验证路径，而重启是操作者的决定
> （见上）。静态预览把"界面长什么样"变成**重启之前**就能看的图，也顺手抓住了两个只有真渲染
> 才会暴露的问题 —— 迷你渲染器的 `createElement` 一开始没把 children 放进 `props.children`，
> 于是共享的 `Field` 包装器渲染成空；以及 hook 单元格不按组件分格子时，三个标签会拍成同一张图。

> 测试夹具一律使用**真实的 DSH 数据结构**（例如 `SessionEvent` 是
> `{ type, seq, time, data }`，负载在 `data` 里）。第 6 轮就是因为夹具编成了错误的
> 内联形状，把一个"汇报永不触发"的 bug 藏了整整几轮 —— 夹具的保真度和断言本身一样重要。

### 改代码之后必须重启

DSH 会热加载 **profile 补丁**，所以改 `cordis.patch.yml` 的配置立刻生效；
但 **Node 的 ESM 模块按 URL 缓存**，`lib/*.js` 改动后运行中的实例不会重新读文件，
只重启「实例」不重载「模块」。所以：

| 改了什么 | 需要做什么 |
|---|---|
| `cordis.patch.yml` 里的配置 | 保存即生效 |
| `lib/*.js`、`bridge/*.py` | 重启一次 `dsh web` |

重启助手（会顺带确认新服务能应答）：

```bash
python tools/restart-dsh.py --dry-run   # 先看它会停掉哪个进程、从哪个目录重启
python tools/restart-dsh.py             # 停掉端口上的 dsh web 并重新拉起
python tools/restart-dsh.py --log $DSH_HOME/logs/dsh-web.log   # 顺便留下新实例的启动输出
```

> `--log` 值得加：`dsh web` 启动时会打印**带鉴权 token 的 URL**，那是没有已登录浏览器时唯一能
> 打开或探测界面的入口（平时它进了 DEVNULL，重启后就找不回来了）。日志里那行 URL 可以直接
> `Start-Process` 打开，或用来 `Invoke-WebRequest` 验证 combo bundle 是不是新代码。

从 DSH 内部（也就是我自己在跑的那个进程里）重启时，用这个包装脚本：

```powershell
powershell -File tools/restart-and-verify.ps1                # 什么也不做，只说明它想干什么（退出码 2）
powershell -File tools/restart-and-verify.ps1 -Force          # 12 秒后重启，然后自动验证
powershell -File tools/restart-and-verify.ps1 -Force -DelaySeconds 0   # 立刻
```

> **必须显式给 `-Force`**：重启会把所有活着的会话（包括发起它的这一轮）连同正在跑的工具调用
> 一起丢掉，所以它不是"改完代码的自然收尾"，而是操作者的一个决定。默认行为是**打印它会做什么
> 然后退出 2**，避免哪天顺手又重启一次。

它做三件事：**延迟**（让当前这一轮先把话说完，因为重启会杀掉发起它的进程）、
`restart-dsh.py --log`（留下新实例的启动输出）、
`verify-live.py`（把"新进程到底在跑哪一版"变成 PASS/FAIL 写进日志）。两个日志都在
`$DSH_HOME/logs/` 下；**服务器日志里有带 token 的 URL，当凭据看待**。

`python tools/verify-live.py --log $DSH_HOME/logs/dsh-web.log` 单独跑也可以。它验证的是：

- 页面能打开，而且是真壳（有 `__DSH_BOOT__`）；
- 这个插件的 combo bundle 真的被提供出去了，且里面含有当轮新增的标记（头像 chip、配置页、
  会话树、`pinSessionId` 写入路径、模式表单）；
- **宿主半**：`lib/index.js` 启动时会打印自己内容的 sha1 前 10 位（`build=xxxxxxxxxx`），
  脚本对磁盘上的文件算同一个哈希再去日志里找 —— 值相同才说明**运行中的进程读的是当前这一版**
  （这是从外部唯一诚实可靠的判断方式：ESM 按 URL 缓存，光看文件改了没有没有意义）。

想先排练一遍而不动正在用的服务：在另一个端口起个一次性的实例，然后

```bash
dsh web --port 3099 --no-open          # 一次性实例
python tools/restart-dsh.py --port 3099   # 只对 3099 做 kill + 重启 + 验证
```

助手本身已经用这种方式排练验证过：杀掉 → 从记录目录重新拉起 → 确认应答（鉴权拒绝也算
「服务已起」，不会误报失败）→ 退出码 0。

> **助手为什么默认不杀进程树。** `taskkill /T` 会连带整棵树。如果这个脚本是从 DSH 内部
> 启动的（工具调用、内嵌终端），那脚本自己就在那棵树里 —— 树杀会在重新拉起服务器之前
> 先把自己杀掉，留下一个彻底没有服务的机器。所以默认只杀监听端口那一个进程；
> 服务器的子进程会自己退出（bridge 的契约就是「读到 stdin EOF 就结束」，
> 用 `python tools/bridge_orphan_check.py` 验证过）。
> 想要老的树杀行为加 `--tree`；脚本检测到自己就在树里时会自动退回单进程杀并打印提示。

> **重启必须从原来的目录启动。** DSH 用 `process.cwd()` 作为 sandbox 的 workspaceRoot，
> 也用它决定 GUI 按哪个工作区分组会话 —— 从别的目录重启，你的会话列表会看起来是空的。
> 插件会把启动目录记进状态文件（`serverCwd`），助手读它来重启；
> **读不到就直接拒绝重启**（退出码 3），除非你显式给 `--cwd <目录>` 或 `--force-cwd`。

> 重启会中断正在跑的那一轮对话。重启后没有任何会话存活，
> 手机发来的指令靠「最后一次派活的会话」恢复（见上一节第 4 条）。

## 8. 已知限制

- `wechat-local` 靠 OCR：代码、长英文、符号容易认错，**中文短指令最稳**；只能读到窗口里可见的消息
- `wechat-local` 发送（文字和图片）时会短暂抢焦点 —— 剪贴板粘贴的硬限制；**读取不抢**。
  所以它只适合在你离开电脑时启用，日常用 QQ
- 轮询间隔默认 5 秒，不是实时
- `onebot` 的目标账号必须是机器人登录的那个 QQ 的好友；群消息需显式加入 `groupAllowFrom`
- 微信回复偶尔会投递失败（窗口状态问题）。现在不会再静默：会打 warning，并写进 `debugLog`
- 你**正在用的那个实例**还跑着早先的模块（Node 的 ESM 缓存），重启后才是完整版；
  用 `python tools/live-check.py` 确认

### 验证到什么程度

真实 DSH 服务上的完整链路已经验证过（用一个独立实例 + `--patch` 覆盖层在另一个端口跑，
不影响你在用的会话）：真实工作区列表、真实建会话、把指令派给一个**已关闭的会话**并让它恢复执行、
真实 Agent 跑完一轮（会话日志 340 B → 15 KB）、回答按真实 `SessionEvent` 结构读出来并推回微信。
验证完已把环境完全还原（会话、补丁、状态文件、临时文件）。
