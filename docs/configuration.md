# 配置项

全部字段、默认值，以及它们实际做什么。改完即生效（profile 的 `patchReload: live`），
不需要重启。

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
| `avatar` | 空 | 卡片头像路径；空=用自带的 `assets/avatars/default.png`，`-`=不画头像。面板里上传的头像优先于它 |
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
| | `privateAllowFrom` / `groupAllowFrom` | 空 | 谁能发指令（白名单规则见 [install.md](install.md#安全默认值)） |
| | `acceptSelfMessages` | `true` | 接受自己账号发的消息（QQ「我的电脑」场景） |
| | `reconnectMs` | `5000` | 断线重连间隔 |

## 目标会话是怎么定的

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
  "serverCwd": "D:\\proj\\my-project",
  "updatedAt": "2026-09-27T18:00:00.000Z"
}
```

`serverCwd` 由插件自己写入（每次目标变化时刷新），`restart-dsh.py` 读它来保证
从同一个目录重启。删掉这个文件就回到纯自动探测 —— 但那样重启助手就得靠 `--cwd`。
