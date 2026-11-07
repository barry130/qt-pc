# DLNA 联调设备

`emulator.mjs` 是零依赖的协议模拟设备，提供 SSDP 发现、设备/SCPD XML、AVTransport、RenderingControl、ConnectionManager 和自生成静音 WAV。收到 Play 时会请求发送端媒体地址的 HEAD 和 Range，结果可从 `/state` 查看。它不解码声音，不能替代真实电视的兼容验证。

将 `192.168.1.20` 替换为本机实际局域网 IPv4：

```powershell
node tools/dlna/emulator.mjs --host 192.168.1.20 --port 49160 --duration 30
```

默认 HTTP 端口 49160、SSDP 端口 1900、曲长 12 秒。可设置 `--port 49161`、`--duration 30`、`--reject-seek` 或 `--soap-delay-ms 1500`。默认加入每个可用 IPv4 网卡的 SSDP 组播组。`--host` 是对外公布的地址；省略时的 `127.0.0.1` 只适合直接访问 HTTP 端点，不适合 SSDP 发现，因为客户端会校验设备地址与响应来源一致。

可用路径：

- `/description.xml`：设备描述，服务地址为相对路径。
- `/fixture/audio.wav`：支持 GET、HEAD、单段/后缀 Range 的音频。
- `/fixture/protected.wav`：必须带 `Referer: https://dlna-test.invalid/`，用于验证媒体代理。
- `/state`：已接收控制命令、媒体探测响应和模拟进度。

在终端输入 `stop` 或按 Ctrl+C 退出。工具只读取网络请求，不读取用户曲库。原生集成测试命令见 [DLNA_IMPLEMENTATION.md](../../docs/DLNA_IMPLEMENTATION.md)。
