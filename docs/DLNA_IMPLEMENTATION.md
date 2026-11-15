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

远端自然结束与移动端采用同一规则：上一条有效设备回包必须为本次非空相同媒体地址的 `PLAYING`，原始位置大于零，且播放/定位控制版本仍一致。仅在该样本距今不超过 **5000ms**、时长大于 **2000ms**、仍希望播放时，才补偿两次回包间的单调时钟增量；候选位置取补偿位置与本次设备位置的较大值并封顶时长。候选位置距离结尾不超过 **1800ms**，且本次状态为 `STOPPED` 或 `NO_MEDIA_PRESENT`、URI 相同或为空时，消费一次结束证据并走原队列推进。

空 URI 只是兼容条件，并非曲终的充分证据。暂停/停止/定位/重新加载、失败轮询、`TRANSITIONING` 或其他非播放状态会撤销旧播放证据，重新收到当前控制版本的有效 `PLAYING` 后才能恢复；非空外来 URI 按切台处理。过期样本不继续外推，重复终态不重复推进，音量控制不撤销播放资格。接收端遥控器在近尾手动停止时可能返回与自然曲终相同的 SOAP 数据，仅靠这些字段仍存在歧义；客户端 Stop 以及远离尾部的接收端 Stop 不自动下一首。

## 验证

在仓库根目录运行：

```bash
pnpm check
pnpm check:native
```

原生门禁使用公开配置和本轮独占的临时目录，不读写用户数据库或系统登录凭据。包含协议解析、媒体 Range、能力限制、控制竞态、自然结束判定以及播放器集成测试。前端包含投屏面板交互与播放器事件回归。

连播专项可运行 `node scripts/check-native.mjs test dlna`。受控回归覆盖 58s/60s 后延迟 1.5s 的归零终态、两种终态 × 同/空 URI、证据过期/控制变化/中间非播放状态、短时长与重复终态；回环 SOAP 用例串接生产 `Connection::poll`、结束判定器与真实队列推进。该用例在测试中串接这些边界，并非完整 `EngineInner::route` 或真实接收端端到端验证；设备联调仍单独执行。

协议联调用例默认忽略，需显式启动仓库内的模拟设备。将下例 `192.168.1.20` 替换为本机实际局域网 IPv4，两个终端使用同一地址。SSDP 会校验响应来源与设备地址一致，因此不能用 `127.0.0.1` 进行发现联调。

```powershell
# 终端 1；stop 或 Ctrl+C 退出
node tools/dlna/emulator.mjs --host 192.168.1.20 --port 49160 --duration 30

# 终端 2
$env:DLNA_TEST_RENDERER_URL = 'http://192.168.1.20:49160/description.xml'
pnpm test:native --lib emulator_production_transport_and_media -- --ignored --nocapture
```

该用例经过生产 SSDP 发现、XML/SCPD、SOAP、本地媒体 HEAD/Range、播放/暂停/定位/音量和迟到操作隔离。模拟设备只探测媒体请求、不解码声音；通过它不代表真实电视兼容。工具详细用法见 [tools/dlna/README.md](../tools/dlna/README.md)。
