# PC DLNA 实现

## 模块与接口

- `src-tauri/src/dlna/protocol.rs`：SSDP、多网卡发现、设备描述与 SCPD XML、SOAP 控制和设备能力探测。
- `src-tauri/src/dlna/media.rs`：带随机令牌的媒体 HTTP 服务、本地/在线资源的 HEAD 与 Range；在线音频检查实际响应 MIME 和内容头。
- `src-tauri/src/dlna/mod.rs`：已发现设备、连接生命周期与控制操作代次。连接只接受发现记录中的设备 ID。
- `src-tauri/src/audio/dlna_adapter.rs`：接入 AudioEngine 的队列、PlayIntent 和 SourceMount。投屏不构建本地解码器；远端进度进入现有播放事件、歌词及收听统计路径。
- `src/components/player/DlnaButton.tsx`：设备选择、刷新、断开和切回本机。

IPC 为 `dlna_discover({ timeoutMs })`、`dlna_connect({ deviceId })` 与 `dlna_disconnect({ returnToLocal })`。`PlaybackState.cast` 是可空的会话快照，包含 `sessionId`、`generation`、设备 ID/名称及 `seek/volume/pause` 能力；原播放状态字段与 `position-changed` 事件继续沿用。

## 一致性约束

连接、加载、播放意图、定位和音量分别检查所属代次。旧设备、旧曲目和旧控制操作的回执不得覆盖当前状态；音量变化不取消播放意图。不支持暂停时在修改意图前拒绝操作；Play/Pause 请求失败只回滚仍有效的当前操作，并重新查询设备状态。

远端自然结束需要同一媒体地址、最近确实在播放、接近有效时长、当前仍希望播放且收到 STOPPED。暂停、加载失败、手动停止、地址切换或迟到回包不满足自动下一首条件。

## 验证

在仓库根目录运行：

```bash
pnpm check
pnpm check:native
```

原生门禁使用公开配置和本轮独占的临时目录，不读写用户数据库或系统登录凭据。包含协议解析、媒体 Range、能力限制、控制竞态、自然结束判定以及播放器集成测试。前端包含投屏面板交互与播放器事件回归。

协议联调用例默认忽略，需显式启动仓库内的模拟设备。将下例 `192.168.1.20` 替换为本机实际局域网 IPv4，两个终端使用同一地址。SSDP 会校验响应来源与设备地址一致，因此不能用 `127.0.0.1` 进行发现联调。

```powershell
# 终端 1；stop 或 Ctrl+C 退出
node tools/dlna/emulator.mjs --host 192.168.1.20 --port 49160 --duration 30

# 终端 2
$env:DLNA_TEST_RENDERER_URL = 'http://192.168.1.20:49160/description.xml'
pnpm test:native --lib emulator_production_transport_and_media -- --ignored --nocapture
```

该用例经过生产 SSDP 发现、XML/SCPD、SOAP、本地媒体 HEAD/Range、播放/暂停/定位/音量和迟到操作隔离。模拟设备只探测媒体请求、不解码声音；通过它不代表真实电视兼容。工具详细用法见 [tools/dlna/README.md](../tools/dlna/README.md)。
