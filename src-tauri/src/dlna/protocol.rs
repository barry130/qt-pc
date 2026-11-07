//! DLNA discovery and UPnP AV actions. These clients never inherit source/CDN headers or proxies.
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use quick_xml::{events::Event, Reader};
use reqwest::blocking::Client;
use serde::Serialize;
use tauri::Url;

const XML_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub seek: bool,
    pub volume: bool,
    pub pause: bool,
}

#[derive(Clone, Debug)]
pub struct Service {
    pub kind: String,
    pub control_url: Url,
    pub scpd_url: Url,
}

#[derive(Clone, Debug)]
pub struct Renderer {
    pub id: String,
    pub name: String,
    pub location: Url,
    pub transport: Service,
    pub rendering: Option<Service>,
    pub connection: Option<Service>,
    pub capabilities: Capabilities,
    pub mime_types: Vec<String>,
    pub volume_min: u32,
    pub volume_max: u32,
    pub peer_ip: Option<IpAddr>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub capabilities: Capabilities,
}

impl Renderer {
    pub fn device(&self) -> Device {
        Device {
            id: self.id.clone(),
            name: self.name.clone(),
            capabilities: self.capabilities.clone(),
        }
    }
    pub fn supports_mime(&self, mime: &str) -> bool {
        // Some older renderers omit ConnectionManager. In that case the transport remains authoritative.
        self.mime_types.is_empty()
            || self.mime_types.iter().any(|accepted| {
                matches!(accepted.as_str(), "*" | "*/*")
                    || canonical_mime(accepted) == canonical_mime(mime)
            })
    }
}

fn canonical_mime(mime: &str) -> &str {
    match mime {
        "audio/x-flac" => "audio/flac",
        "audio/mp3" | "audio/x-mp3" => "audio/mpeg",
        "audio/x-wav" | "audio/wave" => "audio/wav",
        other => other,
    }
}

#[derive(Debug, Default)]
struct Element {
    name: String,
    text: String,
    children: Vec<Element>,
}
impl Element {
    fn child(&self, name: &str) -> Option<&Self> {
        self.children.iter().find(|node| node.name == name)
    }
    fn value(&self, name: &str) -> &str {
        self.child(name).map_or("", |node| node.text.trim())
    }
    fn find(&self, name: &str) -> Option<&Self> {
        if self.name == name {
            return Some(self);
        }
        self.children.iter().find_map(|node| node.find(name))
    }
}

fn xml(raw: &str) -> Result<Element, String> {
    if raw.len() as u64 > XML_LIMIT {
        return Err("DLNA XML 超出大小限制".into());
    }
    let mut reader = Reader::from_str(raw);
    let mut stack = vec![Element::default()];
    loop {
        match reader
            .read_event()
            .map_err(|error| format!("DLNA XML 无效：{error}"))?
        {
            Event::Start(start) => {
                if stack.len() > 48 {
                    return Err("DLNA XML 嵌套过深".into());
                }
                stack.push(Element {
                    name: start.local_name().as_ref().to_string(),
                    ..Default::default()
                });
            }
            Event::Empty(start) => stack.last_mut().expect("XML root").children.push(Element {
                name: start.local_name().as_ref().to_string(),
                ..Default::default()
            }),
            Event::Text(text) => {
                let decoded = text.xml10_content();
                stack.last_mut().expect("XML root").text.push_str(
                    &quick_xml::escape::unescape(&decoded).map_err(|error| error.to_string())?,
                );
            }
            Event::CData(text) => stack
                .last_mut()
                .expect("XML root")
                .text
                .push_str(&text.xml10_content()),
            Event::End(_) => {
                if stack.len() <= 1 {
                    return Err("DLNA XML 标签未配对".into());
                }
                let child = stack.pop().expect("XML child");
                stack.last_mut().expect("XML root").children.push(child);
            }
            Event::DocType(_) => return Err("DLNA XML 不允许 DTD".into()),
            Event::GeneralRef(reference) => {
                let text = reference.xml10_content();
                let escaped = format!("&{text};");
                stack.last_mut().expect("XML root").text.push_str(
                    &quick_xml::escape::unescape(&escaped).map_err(|error| error.to_string())?,
                );
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err("DLNA XML 未完整结束".into());
    }
    Ok(stack.pop().expect("XML root"))
}

pub fn xml_value(raw: &str, name: &str) -> Result<String, String> {
    Ok(xml(raw)?
        .find(name)
        .map_or_else(String::new, |element| element.text.trim().into()))
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|error| error.to_string())
}

pub fn renderer_client(device: &Renderer) -> Result<Client, String> {
    let mut builder = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6));
    if let (Some(host), Some(ip)) = (device.location.host_str(), device.peer_ip) {
        builder = builder.resolve(host, SocketAddr::new(ip, 80));
    }
    builder.build().map_err(|error| error.to_string())
}

fn service_url(base: &Url, path: &str) -> Result<Url, String> {
    let url = base.join(path).map_err(|error| error.to_string())?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str() != base.host_str()
    {
        return Err("DLNA 服务地址与设备来源不一致".into());
    }
    Ok(url)
}

fn renderer_node(node: &Element) -> Option<&Element> {
    if node.name == "device" && node.value("deviceType").contains(":MediaRenderer:") {
        return Some(node);
    }
    node.children.iter().find_map(renderer_node)
}

pub fn parse_description(raw: &str, location: Url) -> Result<Renderer, String> {
    let tree = xml(raw)?;
    let device = renderer_node(&tree).ok_or("设备不支持 DLNA 音频接收")?;
    let id = device.value("UDN").to_string();
    if id.is_empty() {
        return Err("DLNA 设备缺少 UDN".into());
    }
    let base = tree
        .find("URLBase")
        .filter(|element| !element.text.trim().is_empty())
        .map_or_else(
            || Ok(location.clone()),
            |element| service_url(&location, element.text.trim()),
        )?;
    let mut transport = None;
    let mut rendering = None;
    let mut connection = None;
    if let Some(list) = device.child("serviceList") {
        for node in &list.children {
            let kind = node.value("serviceType").to_string();
            let service = Service {
                control_url: service_url(&base, node.value("controlURL"))?,
                scpd_url: service_url(&base, node.value("SCPDURL"))?,
                kind: kind.clone(),
            };
            if kind.contains(":AVTransport:") {
                transport = Some(service);
            } else if kind.contains(":RenderingControl:") {
                rendering = Some(service);
            } else if kind.contains(":ConnectionManager:") {
                connection = Some(service);
            }
        }
    }
    Ok(Renderer {
        id,
        name: device.value("friendlyName").to_string(),
        location,
        transport: transport.ok_or("设备没有 AVTransport 服务")?,
        rendering,
        connection,
        capabilities: Capabilities::default(),
        mime_types: Vec::new(),
        volume_min: 0,
        volume_max: 100,
        peer_ip: None,
    })
}

fn read_xml(response: reqwest::blocking::Response) -> Result<String, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    response
        .take(XML_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > XML_LIMIT {
        return Err("DLNA XML 超出大小限制".into());
    }
    String::from_utf8(bytes).map_err(|_| "DLNA XML 编码无效".into())
}

fn actions(client: &Client, service: &Service) -> (Vec<String>, Option<(u32, u32)>) {
    let response = client
        .get(service.scpd_url.clone())
        .send()
        .and_then(|response| response.error_for_status());
    let Ok(raw) = response
        .map_err(|error| error.to_string())
        .and_then(read_xml)
    else {
        return (Vec::new(), None);
    };
    let Ok(tree) = xml(&raw) else {
        return (Vec::new(), None);
    };
    let actions = tree.find("actionList").map_or_else(Vec::new, |list| {
        list.children
            .iter()
            .map(|action| action.value("name").to_string())
            .collect()
    });
    let range = tree
        .find("serviceStateTable")
        .and_then(|table| {
            table
                .children
                .iter()
                .find(|variable| variable.value("name") == "Volume")
        })
        .and_then(|variable| variable.child("allowedValueRange"))
        .and_then(|range| {
            Some((
                range.value("minimum").parse::<u32>().ok()?,
                range.value("maximum").parse::<u32>().ok()?,
            ))
        })
        .filter(|(minimum, maximum)| maximum > minimum && *maximum <= 65535);
    (actions, range)
}

pub fn inspect(client: &Client, location: Url) -> Result<Renderer, String> {
    let response = client
        .get(location.clone())
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?;
    let mut device = parse_description(&read_xml(response)?, location)?;
    let (transport_actions, _) = actions(client, &device.transport);
    device.capabilities.seek = transport_actions.iter().any(|action| action == "Seek");
    device.capabilities.pause = transport_actions.iter().any(|action| action == "Pause");
    if let Some(rendering) = &device.rendering {
        let (actions, range) = actions(client, rendering);
        device.capabilities.volume = actions.iter().any(|action| action == "SetVolume");
        if let Some((minimum, maximum)) = range {
            device.volume_min = minimum;
            device.volume_max = maximum;
        }
    }
    if let Some(connection) = &device.connection {
        if let Ok(reply) = soap(client, connection, "GetProtocolInfo", &[]) {
            let sink = xml_value(&reply, "Sink").unwrap_or_default();
            device.mime_types = sink
                .split(',')
                .filter_map(|protocol| {
                    let parts: Vec<_> = protocol.trim().split(':').collect();
                    (parts.len() >= 4 && (parts[0] == "http-get" || parts[0] == "*"))
                        .then(|| parts[2].trim().to_ascii_lowercase())
                })
                .collect();
        }
    }
    Ok(device)
}

pub fn ssdp_location(raw: &str) -> Option<&str> {
    let mut lines = raw.lines();
    if !lines.next()?.starts_with("HTTP/1.1 200") {
        return None;
    }
    lines.find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case("location").then(|| value.trim())
    })
}

pub fn discover(timeout_ms: u64) -> Result<Vec<Renderer>, String> {
    let interfaces = if_addrs::get_if_addrs().map_err(|error| error.to_string())?;
    let mut sockets = Vec::new();
    for interface in interfaces {
        let if_addrs::IfAddr::V4(address) = interface.addr else {
            continue;
        };
        if address.ip.is_loopback() || address.ip.is_unspecified() {
            continue;
        }
        let Ok(socket) = UdpSocket::bind((address.ip, 0)) else {
            continue;
        };
        socket
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let _ = socket.set_multicast_ttl_v4(2);
        let request = b"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
        if socket
            .send_to(request, (Ipv4Addr::new(239, 255, 255, 250), 1900))
            .is_ok()
        {
            sockets.push(socket);
        }
    }
    if sockets.is_empty() {
        return Err("没有可用于投屏的局域网连接".into());
    }
    let end = Instant::now() + Duration::from_millis(timeout_ms.clamp(1000, 8000));
    let mut locations = HashMap::new();
    let mut buffer = [0_u8; 8192];
    while Instant::now() < end {
        for socket in &sockets {
            while let Ok((length, peer)) = socket.recv_from(&mut buffer) {
                let Ok(raw) = std::str::from_utf8(&buffer[..length]) else {
                    continue;
                };
                let Some(location) = ssdp_location(raw).and_then(|raw| Url::parse(raw).ok()) else {
                    continue;
                };
                if location.scheme() != "http"
                    || !location.username().is_empty()
                    || location.password().is_some()
                {
                    continue;
                }
                // A responder cannot redirect discovery to unrelated services.
                let literal = location
                    .host_str()
                    .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok());
                if literal.is_none_or(|address| address == peer.ip()) && locations.len() < 16 {
                    locations.insert(location.to_string(), (location, peer.ip()));
                }
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let workers: Vec<_> = locations
        .into_values()
        .map(|(location, ip)| {
            std::thread::spawn(move || {
                let host = location.host_str().ok_or("设备地址缺少主机")?;
                let client = Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .resolve(host, SocketAddr::new(ip, 80))
                    .connect_timeout(Duration::from_secs(1))
                    .timeout(Duration::from_secs(2))
                    .build()
                    .map_err(|error| error.to_string())?;
                let mut renderer = inspect(&client, location)?;
                renderer.peer_ip = Some(ip);
                Ok::<_, String>(renderer)
            })
        })
        .collect();
    let mut result = HashMap::new();
    for worker in workers {
        match worker
            .join()
            .map_err(|_| "设备描述读取线程退出".to_string())
            .and_then(|result| result)
        {
            Ok(renderer) => {
                result.insert(renderer.id.clone(), renderer);
            }
            Err(error) => log::debug!("[dlna] 忽略不可用设备：{error}"),
        }
    }
    let mut result: Vec<_> = result.into_values().collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

pub fn escape(value: &str) -> String {
    quick_xml::escape::escape(value).into_owned()
}

pub fn soap(
    client: &Client,
    service: &Service,
    action: &str,
    args: &[(&str, String)],
) -> Result<String, String> {
    let args = args
        .iter()
        .map(|(key, value)| format!("<{key}>{}</{key}>", escape(value)))
        .collect::<String>();
    let body = format!("<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{}\">{args}</u:{action}></s:Body></s:Envelope>", escape(&service.kind));
    let response = client
        .post(service.control_url.clone())
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"{}#{action}\"", service.kind))
        .body(body)
        .send()
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let raw = read_xml(response)?;
    if !status.is_success() || !xml_value(&raw, "errorCode")?.is_empty() {
        return Err(format!(
            "设备拒绝 {action}：{} {}",
            xml_value(&raw, "errorCode").unwrap_or_default(),
            xml_value(&raw, "errorDescription").unwrap_or_default()
        ));
    }
    Ok(raw)
}

pub fn transport(
    client: &Client,
    device: &Renderer,
    action: &str,
    args: &[(&str, String)],
) -> Result<String, String> {
    let mut params = vec![("InstanceID", "0".into())];
    params.extend_from_slice(args);
    soap(client, &device.transport, action, &params)
}

pub fn parse_time(raw: &str) -> Option<u64> {
    let parts: Vec<_> = raw.trim().split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hour = parts[0].parse::<u64>().ok()?;
    let minute = parts[1].parse::<u64>().ok()?;
    let second = parts[2].parse::<f64>().ok()?;
    if minute >= 60 || !(0.0..60.0).contains(&second) {
        return None;
    }
    hour.checked_mul(3_600_000)?
        .checked_add(minute * 60_000)?
        .checked_add((second * 1000.0).round() as u64)
}

pub fn format_time(ms: u64) -> String {
    let seconds = ms / 1000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    )
}

pub fn route_ip(device: &Renderer) -> Result<std::net::IpAddr, String> {
    let peer: SocketAddr = if let Some(ip) = device.peer_ip {
        SocketAddr::new(ip, device.location.port().unwrap_or(80))
    } else {
        device
            .location
            .socket_addrs(|| Some(80))
            .map_err(|error| error.to_string())?
            .into_iter()
            .next()
            .ok_or("无法解析投屏设备地址")?
    };
    let socket = UdpSocket::bind(if peer.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    })
    .map_err(|error| error.to_string())?;
    socket.connect(peer).map_err(|error| error.to_string())?;
    socket
        .local_addr()
        .map(|address| address.ip())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn description_resolves_services_and_decodes_names() {
        let raw = r#"<root><URLBase>http://192.168.0.2:123/</URLBase><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>TV &amp; 音箱</friendlyName><UDN>uuid:test</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>av/control</controlURL><SCPDURL>/av.xml</SCPDURL></service></serviceList></device></root>"#;
        let device = parse_description(
            raw,
            Url::parse("http://192.168.0.2:123/device.xml").unwrap(),
        )
        .unwrap();
        assert_eq!(device.name, "TV & 音箱");
        assert_eq!(
            device.transport.control_url.as_str(),
            "http://192.168.0.2:123/av/control"
        );
        assert!(parse_description(
            &raw.replace("http://192.168.0.2:123/", "http://127.0.0.1/"),
            device.location
        )
        .is_err());
    }
    #[test]
    fn parser_handles_namespaces_and_rejects_dtd() {
        assert_eq!(
            xml_value("<s:Body><u:Name>A &lt; B</u:Name></s:Body>", "Name").unwrap(),
            "A < B"
        );
        assert!(xml_value(
            "<!DOCTYPE foo [<!ENTITY x SYSTEM 'file:///secret'>]><foo>&x;</foo>",
            "foo"
        )
        .is_err());
        assert!(xml_value("<foo>", "foo").is_err());
    }
    #[test]
    fn time_and_ssdp_are_strict() {
        assert_eq!(parse_time("01:02:03.125"), Some(3_723_125));
        assert_eq!(format_time(3_723_125), "01:02:03");
        assert_eq!(parse_time("00:99:00"), None);
        assert_eq!(
            ssdp_location("HTTP/1.1 200 OK\r\nLOCATION: http://192.168.0.2/d.xml\r\n"),
            Some("http://192.168.0.2/d.xml")
        );
        assert_eq!(
            ssdp_location("NOTIFY * HTTP/1.1\r\nLOCATION: http://localhost/"),
            None
        );
    }
}
