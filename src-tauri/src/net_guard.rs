//! 出网地址的准入校验（SSRF 与明文链路）。
//!
//! 两处用到：
//!
//! 1. [`ensure_public_http_url`]：音源脚本的网络出口（`builtin_request`）。
//!    URL 完全由脚本拼装，而脚本可能来自第三方音源包。原实现不校验协议与目标，
//!    脚本可以让本机去访问 `http://127.0.0.1:<port>/…`（拿本机服务当跳板）、
//!    `http://169.254.169.254/…`（云元数据）或 `file:///…`。
//! 2. [`ensure_installer_url`]：更新安装包的下载地址。安装包会被本机执行，
//!    所以"从哪下"必须收敛。
//!
//! 注意这**不是**完整的 SSRF 防护：DNS 解析发生在 reqwest 内部，这里只校验
//! URL 字面量，理论上存在 DNS rebinding。要彻底解决需要把连接绑定到已校验的
//! IP（自定义 resolver）。对本项目的实际风险面（音源脚本）而言，拦住"直接指向
//! 内网/本机/非 http 协议"已经覆盖了绝大多数滥用路径，且不引入额外依赖。

use std::net::IpAddr;

use tauri::Url;

/// 允许的协议（其它一律拒绝：`file:` 能读本机文件、`data:` 能绕来源、`ftp:` 无意义）
const ALLOWED_SCHEMES: [&str; 2] = ["http", "https"];

/// 解析并做基础准入：协议受限、不携带凭据、主机存在。
pub fn ensure_http_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("地址无法解析：{e}"))?;
    let scheme = url.scheme().to_string();
    if !ALLOWED_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!("不支持的协议 {scheme}（只允许 http/https）"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("地址里不允许携带用户名/密码".to_string());
    }
    if url.host_str().unwrap_or_default().is_empty() {
        return Err("地址缺少主机名".to_string());
    }
    Ok(url)
}

/// 主机是否为公网可访问地址（排除环回 / 内网 / 链路本地 / 组播 / 未指定 / 单标签主机）。
pub fn is_public_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    if h == "localhost" || h.ends_with(".localhost") {
        return false;
    }
    // IP 字面量要先判断：IPv6 字面量里没有点，落到下面的"单标签主机"规则会被误杀
    let bare = h.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return is_public_ip(ip);
    }
    // 单标签主机（intranet、路由器名…）都当内网处理
    if !h.contains('.') {
        return false;
    }
    true
}

/// IP 字面量是否属于公网可路由段。
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                // 0.0.0.0/8
                || a == 0
                // 100.64.0.0/10（运营商级 NAT）
                || (a == 100 && (64..128).contains(&b))
                // 192.0.0.0/24（IETF 协议专用）
                || (a == 192 && b == 0)
                // 198.18.0.0/15（基准测试）
                || (a == 198 && (b == 18 || b == 19))
                // 240.0.0.0/4（保留）
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            // ::ffff:127.0.0.1 这类 IPv4 映射地址要按 IPv4 段判断，
            // 否则 is_loopback() 会返回 false 而放行
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local())
        }
    }
}

/// 是否属于本项目自有域名（`canace.cn` 及其子域）。
///
/// 用 `== 域` 或 `ends_with(".域")`，**不能**只写 `ends_with(域)`：
/// 那样 `canace.cn.evil.com` 也会被判为自家域名。
pub fn is_own_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "canace.cn" || h.ends_with(".canace.cn")
}

/// 音源脚本网络出口的准入：必须是公网 http(s) 地址。
pub fn ensure_public_http_url(raw: &str) -> Result<Url, String> {
    let url = ensure_http_url(raw)?;
    let host = url.host_str().unwrap_or_default();
    if !is_public_host(host) {
        return Err(format!("拒绝访问非公网地址（{host}）"));
    }
    Ok(url)
}

/// 可信下载地址：必须是公网地址，且 **https 或自有 CDN**。
///
/// 用于"下载下来就会被执行/加载"的内容（音源包脚本、更新安装包）：
/// 明文链路上能替换响应体的人，只有 https 或"目标是我们自己的域名"能挡住。
pub fn ensure_trusted_download_url(raw: &str) -> Result<Url, String> {
    let url = ensure_public_http_url(raw)?;
    if url.scheme() == "https" {
        return Ok(url);
    }
    let host = url.host_str().unwrap_or_default();
    if is_own_host(host) {
        log::warn!("[net] 下载地址为明文 http 但属于自有 CDN（{host}），放行");
        return Ok(url);
    }
    Err(format!(
        "拒绝从非 https 且非自有 CDN 的地址下载可执行内容（{host}）"
    ))
}

/// 更新安装包下载地址的准入。
///
/// 明文 http 只在两种情况下放行：
/// - 后端**提供了 MD5**（下载后会校验，替换内容会被发现）；
/// - 目标是我们自己的更新 CDN（`*.canace.cn`）。
///
/// 之所以不一律要求 https：当前发布包的下载地址就是
/// `http://qt.music.canace.cn/...`（该 CDN 尚未启用 TLS，实测 https 握手失败），
/// 一律强制会直接打断更新。等后端为每个 release 填上 md5/fileSize 后，
/// 就可以把这里的规则收紧成"必须 https 且有哈希"。
pub fn ensure_installer_url(raw: &str, has_hash: bool) -> Result<Url, String> {
    if has_hash {
        // 有哈希就是可验证的：交给下载后的校验兜底（但仍要求公网地址）
        return ensure_public_http_url(raw);
    }
    ensure_trusted_download_url(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_http_schemes() {
        for raw in [
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,<script>1</script>",
            "ftp://example.com/a",
            "javascript:alert(1)",
        ] {
            assert!(ensure_http_url(raw).is_err(), "{raw} 应被拒绝");
        }
        assert!(ensure_http_url("https://example.com/a").is_ok());
        assert!(ensure_http_url("http://example.com/a").is_ok());
    }

    #[test]
    fn rejects_credentials_in_url() {
        assert!(ensure_http_url("https://user:pass@example.com/").is_err());
    }

    #[test]
    fn blocks_private_and_loopback_hosts() {
        for host in [
            "127.0.0.1",
            "127.1.2.3",
            "10.0.0.5",
            "192.168.1.1",
            "172.16.0.1",
            "172.31.255.255",
            "169.254.169.254", // 云元数据
            "0.0.0.0",
            "100.64.0.1",
            "198.18.0.1",
            "255.255.255.255",
            "::1",
            "fe80::1",
            "fc00::1",
            "::ffff:127.0.0.1",
            "localhost",
            "api.localhost",
            "intranet",
        ] {
            assert!(!is_public_host(host), "{host} 应被判为非公网");
        }
        for host in [
            "example.com",
            "astral.canace.cn",
            "qt.music.canace.cn",
            "112.45.27.155",
            "2001:4860:4860::8888",
        ] {
            assert!(is_public_host(host), "{host} 应被判为公网");
        }
    }

    #[test]
    fn own_host_check_is_not_a_suffix_trap() {
        assert!(is_own_host("canace.cn"));
        assert!(is_own_host("qt.music.canace.cn"));
        assert!(!is_own_host("canace.cn.evil.com"));
        assert!(!is_own_host("evilcanace.cn"));
    }

    #[test]
    fn installer_url_policy() {
        // 自有 CDN 的明文地址（当前真实发布形态）必须放行，否则更新直接坏掉
        assert!(ensure_installer_url(
            "http://qt.music.canace.cn/astral/x/v1/QuietMusic_1.0.8_x64-setup.exe",
            false
        )
        .is_ok());
        // https 一律放行（加速节点都是 https）
        assert!(ensure_installer_url("https://ghproxy.cn/https://github.com/a/b.exe", false).is_ok());
        // 明文 + 非自有域名 + 无哈希 → 拒绝
        assert!(ensure_installer_url("http://evil.com/setup.exe", false).is_err());
        // 明文 + 非自有域名，但后端给了哈希 → 放行（下载后会校验）
        assert!(ensure_installer_url("http://cdn.example.com/setup.exe", true).is_ok());
        // 后缀陷阱：canace.cn.evil.com 不是自有域名
        assert!(ensure_installer_url("http://canace.cn.evil.com/setup.exe", false).is_err());
        // 内网一律拒绝，无论有没有哈希
        assert!(ensure_installer_url("http://127.0.0.1/setup.exe", true).is_err());
        assert!(ensure_installer_url("http://192.168.1.9/setup.exe", true).is_err());
    }

    #[test]
    fn public_http_url_uses_same_rules() {
        assert!(ensure_public_http_url("https://c.y.qq.com/soso/fcgi-bin/search").is_ok());
        assert!(ensure_public_http_url("http://127.0.0.1:27000/api/v1/").is_err());
        assert!(ensure_public_http_url("http://localhost:8080/").is_err());
    }
}