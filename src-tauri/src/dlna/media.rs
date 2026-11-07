//! Token-addressed, read-only HTTP media relay. No query selects a path or an upstream URL.
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use reqwest::blocking::Client;
use ring::rand::{SecureRandom, SystemRandom};

#[derive(Clone, Debug)]
pub enum Resource {
    File(PathBuf),
    Online { url: String, referer: String },
}

#[derive(Clone)]
struct Entry {
    resource: Resource,
    mime: String,
}

pub struct MediaInfo {
    pub mime: String,
    pub seek: bool,
}

struct Server {
    port: u16,
    stop: AtomicBool,
    active: AtomicUsize,
    entries: Mutex<HashMap<String, Entry>>,
    http: Client,
}

#[derive(Clone)]
pub struct MediaServer(Arc<Server>);

type MediaWorkers = Arc<Mutex<Vec<JoinHandle<()>>>>;

/// Explicit ownership of a loopback relay's actual listener and connection workers.
/// The production `start` entry retains its detached lifecycle.
pub struct MediaServerRun {
    server: Weak<Server>,
    listener: Option<JoinHandle<()>>,
    workers: MediaWorkers,
}

impl MediaServerRun {
    pub fn finish(mut self) -> Result<(), String> {
        self.stop_and_join()
    }

    fn stop_and_join(&mut self) -> Result<(), String> {
        if let Some(server) = self.server.upgrade() {
            server.stop.store(true, Ordering::Release);
        }
        let mut panicked = false;
        if let Some(listener) = self.listener.take() {
            panicked |= listener.join().is_err();
        }
        let workers = std::mem::take(
            &mut *self
                .workers
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        );
        for worker in workers {
            panicked |= worker.join().is_err();
        }
        if panicked {
            Err("投屏媒体服务线程异常结束".into())
        } else {
            Ok(())
        }
    }
}

impl Drop for MediaServerRun {
    fn drop(&mut self) {
        let _ = self.stop_and_join();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

impl MediaServer {
    pub fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("0.0.0.0:0")
            .map_err(|error| format!("无法启动投屏媒体服务：{error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let http = crate::net_config::configure_blocking(
            Client::builder()
                .user_agent("Mozilla/5.0")
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(90)),
        )
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5
                || crate::net_guard::ensure_public_http_url(attempt.url().as_str()).is_err()
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| error.to_string())?;
        let server = Arc::new(Server {
            port,
            stop: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            entries: Mutex::new(HashMap::new()),
            http,
        });
        // Dropping the returned handle preserves the original production lifecycle.
        let _ = spawn_media_listener(listener, &server, None)?;
        Ok(Self(server))
    }

    /// Run the same relay on a caller-owned numeric loopback listener and client.
    /// The returned owner joins the actual listener and every accepted worker.
    pub fn start_owned_loopback(
        listener: TcpListener,
        http: Client,
    ) -> Result<(Self, MediaServerRun), String> {
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        if !address.ip().is_loopback() {
            return Err("受控媒体服务必须绑定数字回环地址".into());
        }
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let server = Arc::new(Server {
            port: address.port(),
            stop: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            entries: Mutex::new(HashMap::new()),
            http,
        });
        let workers = Arc::new(Mutex::new(Vec::new()));
        let listener = spawn_media_listener(listener, &server, Some(Arc::clone(&workers)))?;
        let run = MediaServerRun {
            server: Arc::downgrade(&server),
            listener: Some(listener),
            workers,
        };
        Ok((Self(server), run))
    }

    pub fn register(
        &self,
        address: IpAddr,
        resource: Resource,
        mime: &str,
    ) -> Result<String, String> {
        if let Resource::Online { url, .. } = &resource {
            crate::net_guard::ensure_public_http_url(url)?;
        }
        let mut bytes = [0_u8; 24];
        SystemRandom::new()
            .fill(&mut bytes)
            .map_err(|_| "无法生成投屏资源令牌")?;
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut entries = self
            .0
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if entries.len() >= 8 {
            return Err("投屏资源数量超出限制".into());
        }
        entries.insert(
            token.clone(),
            Entry {
                resource,
                mime: mime.into(),
            },
        );
        let host = if address.is_ipv6() {
            format!("[{address}]")
        } else {
            address.to_string()
        };
        Ok(format!("http://{host}:{}/media/{token}", self.0.port))
    }

    pub fn probe(&self, resource: &Resource, fallback: &str) -> Result<MediaInfo, String> {
        let mut sample = [0_u8; 32];
        let (length, declared, seek) = match resource {
            Resource::File(path) => {
                let mut input = std::fs::File::open(path)
                    .map_err(|error| format!("本地音乐不可读取：{error}"))?;
                (
                    input.read(&mut sample).map_err(|error| error.to_string())?,
                    String::new(),
                    true,
                )
            }
            Resource::Online { url, referer } => {
                crate::net_guard::ensure_public_http_url(url)?;
                let mut request = self
                    .0
                    .http
                    .get(url)
                    .header("Range", "bytes=0-31")
                    .timeout(Duration::from_secs(8));
                if !referer.is_empty() {
                    request = request.header("Referer", referer);
                }
                let response = request
                    .send()
                    .and_then(|response| response.error_for_status())
                    .map_err(|error| format!("媒体地址不可读取：{error}"))?;
                let declared = response
                    .headers()
                    .get("content-type")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .split(';')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let seek = response.status().as_u16() == 206
                    && response
                        .headers()
                        .get("content-range")
                        .and_then(|value| value.to_str().ok())
                        .and_then(content_range)
                        .is_some();
                let mut prefix = Vec::with_capacity(32);
                response
                    .take(32)
                    .read_to_end(&mut prefix)
                    .map_err(|error| format!("媒体地址不可读取：{error}"))?;
                let length = prefix.len();
                sample[..length].copy_from_slice(&prefix);
                (length, declared, seek)
            }
        };
        let signature = detect_mime(&sample[..length]);
        if signature.is_none()
            && (declared.starts_with("text/")
                || matches!(declared.as_str(), "application/json" | "application/xml"))
        {
            return Err("媒体地址不可读取：服务器返回了文本内容".into());
        }
        if length == 0 {
            return Err("媒体地址不可读取：空音频".into());
        }
        Ok(MediaInfo {
            mime: signature.map_or_else(
                || {
                    if declared.starts_with("audio/") {
                        declared
                    } else {
                        fallback.to_string()
                    }
                },
                str::to_string,
            ),
            seek,
        })
    }

    pub fn clear(&self) {
        self.0
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
    pub fn stop(&self) {
        self.clear();
        self.0.stop.store(true, Ordering::Release);
    }
}

fn spawn_media_listener(
    listener: TcpListener,
    server: &Arc<Server>,
    workers: Option<MediaWorkers>,
) -> Result<JoinHandle<()>, String> {
    let weak = Arc::downgrade(server);
    std::thread::Builder::new()
        .name("dlna-media-listener".into())
        .spawn(move || loop {
            let Some(server) = weak.upgrade() else {
                return;
            };
            if server.stop.load(Ordering::Acquire) {
                return;
            }
            match listener.accept() {
                Ok((mut stream, _)) => {
                    if server.active.fetch_add(1, Ordering::AcqRel) >= 8 {
                        server.active.fetch_sub(1, Ordering::AcqRel);
                        let _ = simple(&mut stream, 503, "Busy", &[]);
                        continue;
                    }
                    let worker =
                        std::thread::Builder::new()
                            .name("dlna-media".into())
                            .spawn(move || {
                                let result = serve(&server, &mut stream);
                                server.active.fetch_sub(1, Ordering::AcqRel);
                                if let Err(error) = result {
                                    log::debug!("[dlna] 媒体连接结束：{error}");
                                }
                            });
                    if let (Some(workers), Ok(worker)) = (workers.as_ref(), worker) {
                        workers
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .push(worker);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    drop(server);
                    std::thread::sleep(Duration::from_millis(30));
                }
                Err(_) => return,
            }
        })
        .map_err(|error| error.to_string())
}

pub fn detect_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"fLaC") {
        Some("audio/flac")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE") {
        Some("audio/wav")
    } else if bytes.get(4..8) == Some(b"ftyp") {
        Some("audio/mp4")
    } else if bytes.starts_with(b"OggS") {
        Some("audio/ogg")
    } else if bytes.starts_with(b"ID3") {
        Some("audio/mpeg")
    } else if bytes.first() == Some(&0xff) && bytes.get(1).is_some_and(|byte| byte & 0xf6 == 0xf0) {
        Some("audio/aac")
    } else if bytes.first() == Some(&0xff) && bytes.get(1).is_some_and(|byte| byte & 0xe0 == 0xe0) {
        Some("audio/mpeg")
    } else {
        None
    }
}

fn headers(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    fields: &[(&str, String)],
) -> Result<(), String> {
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nConnection: close\r\n"
    )
    .map_err(|error| error.to_string())?;
    for (key, value) in fields {
        if value.contains(['\r', '\n']) {
            return Err("媒体响应头无效".into());
        }
        write!(stream, "{key}: {value}\r\n").map_err(|error| error.to_string())?;
    }
    stream.write_all(b"\r\n").map_err(|error| error.to_string())
}
fn simple(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    fields: &[(&str, String)],
) -> Result<(), String> {
    let mut fields = fields.to_vec();
    fields.push(("Content-Length", "0".into()));
    headers(stream, status, reason, &fields)
}

pub fn parse_range(raw: &str, length: u64) -> Result<(u64, u64), String> {
    let raw = raw.strip_prefix("bytes=").ok_or("不支持的 Range")?;
    if raw.contains(',') || length == 0 {
        return Err("不支持的 Range".into());
    }
    let (start, end) = raw.split_once('-').ok_or("Range 无效")?;
    if start.is_empty() {
        let suffix: u64 = end.parse().map_err(|_| "Range 无效")?;
        if suffix == 0 {
            return Err("Range 无效".into());
        }
        Ok((length.saturating_sub(suffix), length - 1))
    } else {
        let start: u64 = start.parse().map_err(|_| "Range 无效")?;
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| "Range 无效")?
                .min(length - 1)
        };
        if start >= length || end < start {
            return Err("Range 超出媒体长度".into());
        }
        Ok((start, end))
    }
}

fn content_range(raw: &str) -> Option<(u64, u64, u64)> {
    let raw = raw.strip_prefix("bytes ")?;
    let (range, total) = raw.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total) = (
        start.parse::<u64>().ok()?,
        end.parse::<u64>().ok()?,
        total.parse::<u64>().ok()?,
    );
    (start <= end && end < total).then_some((start, end, total))
}

fn serve(server: &Server, stream: &mut TcpStream) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(12)))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    let mut byte = [0_u8; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() >= 16_384 {
            return simple(stream, 431, "Headers Too Large", &[]);
        }
        stream
            .read_exact(&mut byte)
            .map_err(|error| error.to_string())?;
        bytes.push(byte[0]);
    }
    let raw = String::from_utf8(bytes).map_err(|_| "请求头编码无效")?;
    let mut lines = raw.lines();
    let mut request = lines.next().unwrap_or_default().split_whitespace();
    let method = request.next().unwrap_or_default();
    let path = request.next().unwrap_or_default();
    if !matches!(method, "GET" | "HEAD") {
        return simple(
            stream,
            405,
            "Method Not Allowed",
            &[("Allow", "GET, HEAD".into())],
        );
    }
    let Some(token) = path
        .strip_prefix("/media/")
        .filter(|token| token.len() == 48 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
    else {
        return simple(stream, 404, "Not Found", &[]);
    };
    let entry = server
        .entries
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(token)
        .cloned();
    let Some(entry) = entry else {
        return simple(stream, 404, "Not Found", &[]);
    };
    let fields: HashMap<_, _> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    let range = fields.get("range").map(String::as_str);
    match entry.resource {
        Resource::File(path) => {
            let Ok(mut file) = std::fs::File::open(path) else {
                return simple(stream, 404, "Not Found", &[]);
            };
            let length = file.metadata().map_err(|error| error.to_string())?.len();
            let selected = if method == "GET" {
                match range.map(|range| parse_range(range, length)).transpose() {
                    Ok(selected) => selected,
                    Err(_) => {
                        return simple(
                            stream,
                            416,
                            "Range Not Satisfiable",
                            &[("Content-Range", format!("bytes */{length}"))],
                        )
                    }
                }
            } else {
                None
            };
            let (start, end) = selected.unwrap_or((0, length.saturating_sub(1)));
            let response_len = if selected.is_some() {
                end - start + 1
            } else {
                length
            };
            let mut fields = vec![
                ("Content-Type", entry.mime),
                ("Accept-Ranges", "bytes".into()),
                ("Content-Length", response_len.to_string()),
                ("transferMode.dlna.org", "Streaming".into()),
            ];
            if selected.is_some() {
                fields.push(("Content-Range", format!("bytes {start}-{end}/{length}")));
            }
            headers(
                stream,
                if selected.is_some() { 206 } else { 200 },
                if selected.is_some() {
                    "Partial Content"
                } else {
                    "OK"
                },
                &fields,
            )?;
            if method == "GET" {
                file.seek(SeekFrom::Start(start))
                    .map_err(|error| error.to_string())?;
                copy_limited(server, file.take(response_len), stream)?;
            }
            Ok(())
        }
        Resource::Online { url, referer } => {
            let mut request = if method == "HEAD" {
                server.http.head(&url)
            } else {
                server.http.get(&url)
            };
            if method == "HEAD" {
                request = request.timeout(Duration::from_secs(8));
            }
            if !referer.is_empty() {
                request = request.header("Referer", &referer);
            }
            if method == "GET" {
                if let Some(range) = range {
                    if range.contains(',') || !range.starts_with("bytes=") {
                        return simple(stream, 416, "Range Not Satisfiable", &[]);
                    }
                    request = request.header("Range", range);
                }
            }
            let mut response = match request.send() {
                Ok(response) => response,
                Err(_) => return simple(stream, 502, "Bad Gateway", &[]),
            };
            if method == "HEAD" && !response.status().is_success() {
                let mut fallback = server
                    .http
                    .get(&url)
                    .header("Range", "bytes=0-0")
                    .timeout(Duration::from_secs(8));
                if !referer.is_empty() {
                    fallback = fallback.header("Referer", &referer);
                }
                response = match fallback.send() {
                    Ok(response) => response,
                    Err(_) => return simple(stream, 502, "Bad Gateway", &[]),
                };
            }
            let status = response.status();
            if !status.is_success() && status.as_u16() != 416 {
                return simple(stream, 502, "Bad Gateway", &[]);
            }
            if method == "GET" && status.as_u16() == 206 {
                let actual = response
                    .headers()
                    .get("content-range")
                    .and_then(|value| value.to_str().ok())
                    .and_then(content_range);
                let valid = actual.is_some_and(|(start, end, total)| {
                    let requested =
                        range.map_or(Ok((0, total - 1)), |range| parse_range(range, total));
                    requested.is_ok_and(|(wanted_start, wanted_end)| {
                        start == wanted_start && end <= wanted_end
                    })
                });
                if !valid {
                    return simple(stream, 502, "Bad Gateway", &[]);
                }
            }
            let mut fields = vec![
                ("Content-Type", entry.mime),
                ("transferMode.dlna.org", "Streaming".into()),
            ];
            if method == "HEAD" {
                let total = response
                    .headers()
                    .get("content-range")
                    .and_then(|value| value.to_str().ok())
                    .and_then(content_range)
                    .map(|(_, _, total)| total);
                if let Some(total) = total {
                    fields.push(("Content-Length", total.to_string()));
                } else if let Some(length) = response
                    .headers()
                    .get("content-length")
                    .and_then(|value| value.to_str().ok())
                {
                    fields.push(("Content-Length", length.to_string()));
                }
                if let Some(ranges) = response
                    .headers()
                    .get("accept-ranges")
                    .and_then(|value| value.to_str().ok())
                {
                    fields.push(("Accept-Ranges", ranges.to_string()));
                }
                return headers(stream, 200, "OK", &fields);
            }
            for name in ["content-length", "content-range", "accept-ranges"] {
                if let Some(value) = response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                {
                    fields.push((name, value.to_string()));
                }
            }
            // Upstreams ignoring Range keep their 200 response; never invent a 206.
            headers(
                stream,
                status.as_u16(),
                status.canonical_reason().unwrap_or("OK"),
                &fields,
            )?;
            if method == "GET" {
                copy_limited(server, response, stream)?;
            }
            Ok(())
        }
    }
}

fn copy_limited(
    server: &Server,
    mut input: impl Read,
    output: &mut TcpStream,
) -> Result<(), String> {
    let mut buffer = [0_u8; 64 * 1024];
    while !server.stop.load(Ordering::Acquire) {
        let length = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if length == 0 {
            break;
        }
        output
            .write_all(&buffer[..length])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn mime(raw: &str, cover: bool) -> &'static str {
    let path = raw.split('?').next().unwrap_or(raw).to_ascii_lowercase();
    if cover {
        if path.ends_with(".png") {
            "image/png"
        } else if path.ends_with(".webp") {
            "image/webp"
        } else {
            "image/jpeg"
        }
    } else if path.ends_with(".flac") {
        "audio/flac"
    } else if path.ends_with(".wav") {
        "audio/wav"
    } else if path.ends_with(".m4a") || path.ends_with(".mp4") {
        "audio/mp4"
    } else if path.ends_with(".aac") {
        "audio/aac"
    } else if path.ends_with(".ogg") {
        "audio/ogg"
    } else {
        "audio/mpeg"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_cover_prefix_suffix_open_and_invalid() {
        assert_eq!(parse_range("bytes=0-4", 10).unwrap(), (0, 4));
        assert_eq!(parse_range("bytes=4-", 10).unwrap(), (4, 9));
        assert_eq!(parse_range("bytes=-4", 10).unwrap(), (6, 9));
        assert_eq!(parse_range("bytes=-20", 10).unwrap(), (0, 9));
        for raw in [
            "bytes=10-",
            "bytes=5-2",
            "bytes=-0",
            "bytes=0-1,5-8",
            "x=0-1",
        ] {
            assert!(parse_range(raw, 10).is_err(), "{raw}");
        }
        assert!(parse_range("bytes=0-", 0).is_err());
    }
    #[test]
    fn token_file_server_returns_exact_ranges_and_invalidates_urls() {
        let fixture = crate::lyric_access::native_fixture::NativeFixture::new("dlna-media");
        let path = fixture.file("track.mp3", b"0123456789");
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let (server, run) = MediaServer::start_owned_loopback(listener, client.clone()).unwrap();
        let url = server
            .register(
                "127.0.0.1".parse().unwrap(),
                Resource::File(path.clone()),
                "audio/mpeg",
            )
            .unwrap();
        let response = client
            .get(&url)
            .header("Range", "bytes=2-5")
            .send()
            .unwrap();
        assert_eq!(response.status().as_u16(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
        assert_eq!(response.headers()["content-length"], "4");
        assert_eq!(response.bytes().unwrap().as_ref(), b"2345");
        let head = client
            .head(&url)
            .header("Range", "bytes=2-5")
            .send()
            .unwrap();
        assert_eq!(head.status().as_u16(), 200);
        assert_eq!(head.headers()["content-length"], "10");
        assert!(head.bytes().unwrap().is_empty());
        let invalid = client
            .get(&url)
            .header("Range", "bytes=10-")
            .send()
            .unwrap();
        assert_eq!(invalid.status().as_u16(), 416);
        assert_eq!(invalid.headers()["content-range"], "bytes */10");
        assert_eq!(
            client
                .get(format!("{url}?path=C:/Windows"))
                .send()
                .unwrap()
                .status()
                .as_u16(),
            404
        );
        server.clear();
        assert_eq!(client.get(&url).send().unwrap().status().as_u16(), 404);
        server.stop();
        run.finish().expect("owned media listener and workers join");
        fixture.remove_file(&path);
    }
    #[test]
    fn signature_detection_does_not_trust_a_signed_url_suffix() {
        assert_eq!(detect_mime(b"fLaC\x00\x00"), Some("audio/flac"));
        assert_eq!(detect_mime(b"ID3\x04\x00"), Some("audio/mpeg"));
        assert_eq!(detect_mime(b"\0\0\0\x18ftypM4A "), Some("audio/mp4"));
        assert_eq!(detect_mime(b"<html>403</html>"), None);
    }
}
