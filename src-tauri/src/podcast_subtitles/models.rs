use crate::{ai_local::AiProfile, AppState};
use serde::Deserialize;
use std::{sync::OnceLock, time::Duration};
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPreset {
    id: String,
    response_format: String,
}

// 与下拉框共用一份名单，避免前后端支持范围与格式漂移。
fn presets() -> &'static [ModelPreset] {
    static PRESETS: OnceLock<Vec<ModelPreset>> = OnceLock::new();
    PRESETS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/lib/podcast-transcription-models.json"))
            .expect("bundled transcription model catalog")
    })
}

pub(super) fn validate_options(model: &str, format: &str, custom: bool) -> Result<(), String> {
    if model.trim().is_empty() || model.len() > 200 {
        return Err("请填写有效的语音转写模型名称".into());
    }
    if !["verbose_json", "diarized_json", "json", "text"].contains(&format) {
        return Err("请选择有效的转写返回格式".into());
    }
    if !custom {
        let preset = presets().iter().find(|item| item.id == model.trim())
            .ok_or("请选择内置转写模型，或在下拉框中选择「自定义（不保证可用）」")?;
        if preset.response_format != format {
            return Err(format!("{} 需要使用 {}，请重新保存字幕设置", preset.id, preset.response_format));
        }
    }
    Ok(())
}

fn parse_inventory(text: &str) -> Result<Vec<String>, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| "供应商模型列表不是有效 JSON")?;
    let items = value.get("data").or_else(|| value.get("models")).unwrap_or(&value)
        .as_array().ok_or("供应商未返回可识别的模型列表，无法核实模型是否可用")?;
    let mut ids = Vec::new();
    for item in items {
        let id = item.as_str().or_else(|| item.get("id").and_then(|v| v.as_str()))
            .or_else(|| item.get("name").and_then(|v| v.as_str()))
            .filter(|id| !id.trim().is_empty())
            .ok_or("供应商模型列表包含无效条目，无法核实模型是否可用")?;
        ids.push(id.trim().to_owned());
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

async fn list_with_client(profile: &AiProfile, client: &reqwest::Client) -> Result<Vec<String>, String> {
    // 从同一个标准化端点派生，始终使用明确选中的档案，绝不回退到当前聊天档案的 Key。
    let mut endpoint = crate::ai_local::podcast_transcription_endpoint(&profile.base_url)?;
    let path = endpoint.path().strip_suffix("audio/transcriptions").ok_or("供应商地址无效")?;
    endpoint.set_path(&format!("{path}models"));
    let mut request = client.get(endpoint);
    if !profile.api_key.is_empty() {
        request = request.bearer_auth(&profile.api_key);
    }
    let response = request.send().await.map_err(|_| "无法连接供应商模型列表，请检查网络与供应商设置")?;
    let text = super::audio::read_response(response, 4 * 1024 * 1024).await?;
    parse_inventory(&text)
}

pub(super) async fn list(profile: &AiProfile) -> Result<Vec<String>, String> {
    if !["openai", "openai-responses"].contains(&profile.protocol.as_str()) {
        return Err("请选择支持音频转写接口的兼容供应商".into());
    }
    let client = crate::net_config::configure(reqwest::Client::builder())
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .tls_danger_accept_invalid_certs(profile.skip_cert_verify)
        .build().map_err(|_| "模型列表客户端初始化失败")?;
    list_with_client(profile, &client).await
}

fn ensure_available(profile: &AiProfile, model: &str, ids: &[String]) -> Result<(), String> {
    if ids.iter().any(|id| id == model.trim()) { return Ok(()); }
    let provider = if profile.name.trim().is_empty() { "当前供应商" } else { profile.name.trim() };
    Err(format!("{provider} 的模型列表中没有 {}，请选择其他模型或供应商", model.trim()))
}

pub(super) async fn validate_available(profile: &AiProfile, model: &str) -> Result<(), String> {
    let ids = list(profile).await.map_err(|error| format!("无法核实转写模型：{error}；请在字幕设置中重试，或选择「自定义（不保证可用）」"))?;
    ensure_available(profile, model, &ids)
}

#[tauri::command(rename = "podcast_transcription_models")]
pub async fn cmd_podcast_transcription_models(state: State<'_, AppState>, profile_id: String) -> Result<Vec<String>, String> {
    let profile = crate::ai_local::podcast_profile(&state, &profile_id)?;
    list(&profile).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_require_their_format_and_custom_is_explicit() {
        assert_eq!(presets().len(), 2);
        assert!(validate_options("whisper-1", "verbose_json", false).is_ok());
        assert!(validate_options("gpt-4o-transcribe-diarize", "diarized_json", false).is_ok());
        assert!(validate_options("whisper-1", "diarized_json", false).is_err());
        assert!(validate_options("Qwen3-ASR-1.7B", "json", false).is_err());
        assert!(validate_options("Qwen3-ASR-1.7B", "json", true).is_ok());
        assert!(validate_options("Qwen3-ASR-1.7B", "text", true).is_ok());
        assert!(validate_options(" ", "json", true).is_err());
        assert!(validate_options("Qwen3-ASR-1.7B", "unsupported", true).is_err());
    }

    #[test]
    fn malformed_inventory_is_not_reported_as_absent_model() {
        assert!(parse_inventory("<html>no list</html>").is_err());
        assert!(parse_inventory(r#"{"error":"bad key"}"#).is_err());
        assert!(parse_inventory(r#"{"data":[{}]}"#).is_err());
        assert!(parse_inventory(r#"{"data":[]}"#).unwrap().is_empty());
        assert_eq!(parse_inventory(r#"{"data":[{"id":"whisper-1"},{"id":"whisper-1"}]}"#).unwrap(), vec!["whisper-1"]);
        assert_eq!(parse_inventory(r#"{"models":["Qwen3-ASR-1.7B"]}"#).unwrap(), vec!["Qwen3-ASR-1.7B"]);
    }

    #[tokio::test]
    async fn inventory_uses_selected_profile_credentials_and_reports_absence() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => panic!("fixture accept: {error}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0u8; 4096];
                let size = socket.read(&mut buffer).unwrap();
                assert!(size > 0);
                bytes.extend_from_slice(&buffer[..size]);
                if bytes.windows(4).any(|part| part == b"\r\n\r\n") { break; }
            }
            let body = r#"{"data":[{"id":"Qwen3-ASR-1.7B"},{"id":"whisper-1"}]}"#;
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let profile: AiProfile = serde_json::from_value(serde_json::json!({
            "id": "selected", "name": "crouter", "baseUrl": format!("http://{address}/gateway/v1/chat/completions"),
            "apiKey": "fixture-selected-key", "protocol": "openai", "models": ["chat-only"]
        })).unwrap();
        let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
        let ids = list_with_client(&profile, &client).await.unwrap();
        assert!(ensure_available(&profile, "whisper-1", &ids).is_ok());
        let error = ensure_available(&profile, "gpt-4o-transcribe-diarize", &ids).unwrap_err();
        assert!(error.contains("crouter 的模型列表中没有 gpt-4o-transcribe-diarize"));
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /gateway/v1/models HTTP/1.1"));
        assert!(request.to_ascii_lowercase().contains("authorization: bearer fixture-selected-key"));
        assert!(!request.contains("chat-only"));
    }
}
