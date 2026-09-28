# 安装与传输层

将插件挂载到 DSH 并接入 QQ / 微信通道。快速上手见 [README § 安装](../README.md#安装)。

## 与 DSH 的绑定

插件是自包含包，代码不依赖 DSH 内部实现。DSH 侧仅以下位置涉及插件：

| 内容 | 路径 | 入库 |
|---|---|---|
| 挂载行（插件唯一的"配置"） | `$DSH_HOME/profiles/web/cordis.patch.yml` 的 `insert` 条目 | 否，仓库提供模板 `cordis.patch.yml` |
| 运行期设置（管理员密码、通道开关等） | `$DSH_HOME/settings.yaml` | 否（含密码） |
| 运行期状态（会话锁定、截图区域等） | `$DSH_HOME/storages/remote-channel.json` | 否 |
| 日志与预览图 | `$DSH_HOME/logs/` | 否 |

部署与依赖：

- 复制 `profiles/plugins/dsh-remote` 到目标机器的相同相对路径，将模板中的挂载行加入 profile 补丁。
- Python 依赖：`pip install -r requirements.txt`（Pillow）。
- `ws` 由 DSH 提供，插件从 profile 的 `node_modules` 解析；仅运行 `tools/*.mjs` 时需要 `npm install`。
- 挂载行的 `name` 相对补丁文件解析，插件目录须位于 `$DSH_HOME/profiles/plugins/` 下，否则改为绝对路径或 npm 包名。
- 默认头像 `assets/avatars/default.png`，可通过配置项 `avatar: <路径>` 或面板上传替换（上传优先）。
- `tools/one-off/`、`ui-preview-*.png`、`.probe-state.json` 仅供开发使用，已被 `.gitignore` 排除。

## onebot（QQ）前置条件

目标：将你自己的 QQ 号接入为可编程账号。这不是官方机器人——官方机器人是独立身份，无法使用你的账号。

> **不使用一键包（OneKey）。** `NapCatInstaller.exe` 会自行下载 QQ，其写死的 `dldir1.qq.com` 地址已 404，流程停在「… → HTTP状态码: 404 → 下载QQ失败」。请使用下面的 Shell 版，直接复用已安装的 QQ。

### 1. 检查环境

- QQNT 版本 ≥ 40768。默认路径 `C:\Program Files\Tencent\QQNT`；`launcher.bat` 通过注册表 `HKLM\SOFTWARE\WOW6432Node\...\Uninstall\QQ` 的 `UninstallString` 推导该路径，安装路径变更后需留意。
- 缺少运行库时安装 [VC++ 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe)。

### 2. 部署 NapCat

从 [NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 `NapCat.Shell.zip`（约 30 MB，非 OneKey 版），解压到任意目录。

本次实测环境：

```
解压目录：D:\tool\programming_tools\NapCat\NapCat.Shell
sha256  ：bcdd8bdb9e44bd0cf6a90908e572141787fd9e98cb8d8eecc5adf25bbdcabb94
```

### 3. 启动

1. 完全退出 QQ（可用 `KillQQ.bat`）。
2. 在解压目录中**以管理员身份运行** `launcher.bat`（Windows 10 用 `launcher-win10.bat`）。

约束：

- 须以管理员身份运行：脚本需要改写 `...\QQNT\versions\<版本>\resources\app\package.json`，而 `C:\Program Files` 对普通用户不可写。非管理员运行时脚本会尝试通过 `wt.exe` 提权，UAC 被拒或 `wt.exe` 缺失会导致窗口一闪而过。
- 不得从 DSH 的工具调用中启动：NapCat / QQ 会挂在 DSH 进程树下，DSH 重启时一并结束，须由用户手动启动。

### 4. 登录

首次登录只能扫码：二维码输出到控制台，同时写入 `cache\qrcode.png`。该文件在二维码刷新时不会同步更新，扫描它必然报「二维码已过期」（`ErrType: 1 ErrCode: 3`）。

登录一次后改用快速登录：

```bat
cd /d D:\tool\programming_tools\NapCat
launcher.bat <QQ号>
```

启动日志出现 `正在快速登录 <QQ号>` 即生效。控制台启动时会列出可用于快速登录的 QQ 候选。

### 5. 开启 OneBot WebSocket 服务端

修改 `config\onebot11_<QQ号>.json` 的 `network.websocketServers`。字段名须与 NapCat 内部 schema 一致（`name/enable/host/port/messagePostFormat/reportSelfMessage/token/enableForcePushEvent/debug/heartInterval`）：

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

- `reportSelfMessage: true`：上报「手机 QQ → 我的电脑」等发给自己的消息。
- 该文件不热加载，修改后须重启 NapCat。启动日志出现 `WebSocket服务: 127.0.0.1:3001 ... 已启用` 即生效。

### 6. 配置插件

```yaml
        transports:
          - onebot
          # - wechat-local

        onebot:
          url: ws://127.0.0.1:3001
          accessToken: ''      # 与 NapCat 中的设置一致
          ownerId: ''          # 留空：仅有一个好友时自动使用该好友
          target: private
```

`ownerId` 留空时插件连接后调用 `get_friend_list`：仅有一个好友时，该好友成为收件人，同时也是唯一可下发指令的账号（白名单）。好友多于一个时须显式填写 `ownerId`，并将允许操控的账号写入 `privateAllowFrom`。发件人为自己的消息由 `acceptSelfMessages: true` 放行。

### 已知输出

以下输出不影响功能，无需处理：

| 输出 | 说明 |
|---|---|
| `[Core] [Packet] PacketBackend 不支持当前QQ版本架构：9.9.36-53489-x64` | Packet 后端不识别该 QQ 构建，NapCat 退回 hook 路径；登录、收发消息（含 733 字 `#status` 卡片）均正常 |
| `launch.log` 中文乱码（`cmd /c '... 2>&1' \| Tee-Object`） | PowerShell 按 GBK 解码 UTF-8 的输出问题。可先执行 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`，或改用 cmd 重定向 `cmd /c "launcher.bat <QQ号> > launch.log 2>&1"` |

链路验证，按顺序出现：

```
正在快速登录 <QQ号>
WebSocket服务: 127.0.0.1:3001 ... 已启用
onebot (...): ready
```

已验证组合：QQ `9.9.36-53489` + NapCat `v4.18.28`（Shell 版）。

排查入口：

- `$DSH_HOME/logs/remote-channel.jsonl`：按 `inbound → command → reply` 分段，可确认消息是否进入、回执是否发出。
- NapCat `launch.log`：`接收 <- 私聊` / `发送 -> 私聊`。

## wechat-local（微信）前置条件

```powershell
python -m pip install -r requirements.txt
```

安装 Windows **简体中文 OCR 语言包**：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 可选语言功能 → 光学字符识别。

约束：

- 微信须由用户自行打开并登录。插件不启动微信，也不拉取窗口。从 DSH 的工具调用中启动的进程会挂在 DSH 进程树下，DSH 重启时一并结束。
- 发送消息要求文件传输助手窗口位于前台（受剪贴板限制）。如需避免打断，改用 QQ。
- 微信未运行、未登录，或文件传输助手窗口不在屏幕上时，插件会：在另一可用通道（如 QQ）发送「通道掉线」提醒；并在 `#status` / `#channels` 中标注 `未就绪（ready）`、`（上一次读取被跳过：…）` 与「→ 需要你自己打开微信并登录」。

## 安全默认值

插件可在本机执行命令，默认值偏保守：

- **普通文本直接投递到当前会话**；`commandPrefix`（默认 `#`）仅用于区分插件管理命令。
- **`onebot` 私聊白名单按顺序推导**（留空不等于任何人可发送）：
  1. `privateAllowFrom`
  2. `ownerId`
  3. 唯一好友
  4. 均未配置：放开，但每次告警并在 `#status` 中标记 ⚠
- **群消息默认全部忽略**，须显式写入 `groupAllowFrom`。
- **限流**：`maxCommandsPerMinute` 默认 20，超出后丢弃并提示一次。
- **`wechat-local` 发送前用 OCR 确认当前窗口为文件传输助手**，否则拒绝发送。
- **`wechat.passive` 默认开启**：轮询只读取屏幕已有内容，不打开、切换或滚动窗口。
- 报告内容按 `reportMaxChars` 截断。

`#status` 显示当前可下发指令的账号：

```
· QQ · OneBot (ws://127.0.0.1:3001) [onebot]：就绪
    可发指令者：20002（来自 the single friend）
```

## 回滚

补丁备份：`$DSH_HOME/profiles/web/cordis.patch.yml.bak-before-wechat`（内容为 `[]`）。

停用方式任选其一：

- 挂载行改为 `disabled: true`（保留代码）。
- 以备份覆盖 `cordis.patch.yml`。
- 删除 `$DSH_HOME/profiles/plugins/dsh-remote` 目录。
