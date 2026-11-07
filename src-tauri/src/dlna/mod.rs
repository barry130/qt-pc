//! Native DLNA controller. Logical playback remains owned by AudioEngine.
pub mod media;
pub mod protocol;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use reqwest::blocking::Client;
use serde::Serialize;

use crate::audio::engine::PlaySource;
use crate::provider::types::Track;
use media::{MediaServer, Resource};
use protocol::{Capabilities, Device, Renderer};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CastState {
    pub session_id: u64,
    pub generation: u64,
    pub device_id: String,
    pub device_name: String,
    pub capabilities: Capabilities,
}

struct ManagerInner {
    devices: Mutex<HashMap<String, Renderer>>,
    selected: Mutex<Option<Connection>>,
    nonce: AtomicU64,
    io: Arc<Mutex<()>>,
}

#[derive(Clone)]
pub struct DlnaManager(Arc<ManagerInner>);
impl Default for DlnaManager {
    fn default() -> Self {
        Self(Arc::new(ManagerInner {
            devices: Mutex::new(HashMap::new()),
            selected: Mutex::new(None),
            nonce: AtomicU64::new(0),
            io: Arc::new(Mutex::new(())),
        }))
    }
}

pub struct ConnectionInner {
    pub id: u64,
    pub device: Renderer,
    pub client: Client,
    pub generation: AtomicU64,
    pub revision: AtomicU64,
    play_revision: AtomicU64,
    seek_revision: AtomicU64,
    volume_revision: AtomicU64,
    pub desired_play: AtomicBool,
    active: AtomicBool,
    io: Arc<Mutex<()>>,
    server: MediaServer,
    capabilities: Mutex<Capabilities>,
    ready: Arc<SwitchBarrier>,
}

struct SwitchBarrier {
    result: Mutex<Option<Result<(), String>>>,
    changed: Condvar,
}

#[derive(Clone)]
pub struct Connection(Arc<ConnectionInner>);
impl std::ops::Deref for Connection {
    type Target = ConnectionInner;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DlnaManager {
    pub fn discover(&self, timeout_ms: u64) -> Result<Vec<Device>, String> {
        let found = protocol::discover(timeout_ms)?;
        let result = found.iter().map(Renderer::device).collect();
        *self
            .0
            .devices
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = found
            .into_iter()
            .map(|device| (device.id.clone(), device))
            .collect();
        Ok(result)
    }
    pub fn selected(&self) -> Option<Connection> {
        self.0
            .selected
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
    pub fn select(&self, id: &str) -> Result<Connection, String> {
        let device = self
            .0
            .devices
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(id)
            .cloned()
            .ok_or("设备已失效，请重新搜索")?;
        let client = protocol::renderer_client(&device)?;
        let connection = Connection(Arc::new(ConnectionInner {
            capabilities: Mutex::new(device.capabilities.clone()),
            ready: Arc::new(SwitchBarrier {
                result: Mutex::new(Some(Ok(()))),
                changed: Condvar::new(),
            }),
            id: self.0.nonce.fetch_add(1, Ordering::AcqRel).wrapping_add(1),
            device,
            client,
            generation: AtomicU64::new(0),
            revision: AtomicU64::new(0),
            play_revision: AtomicU64::new(0),
            seek_revision: AtomicU64::new(0),
            volume_revision: AtomicU64::new(0),
            active: AtomicBool::new(true),
            desired_play: AtomicBool::new(false),
            io: self.0.io.clone(),
            server: MediaServer::start()?,
        }));
        let previous = self
            .0
            .selected
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .replace(connection.clone());
        if let Some(previous) = previous {
            let completion = if previous.device.id != connection.device.id {
                *connection
                    .ready
                    .result
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = None;
                Some(connection.ready.clone())
            } else {
                None
            };
            self.retire(previous, completion);
        }
        Ok(connection)
    }
    pub fn disconnect(&self) {
        let previous = self
            .0
            .selected
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(previous) = previous {
            self.retire(previous, None);
        }
    }
    fn retire(&self, previous: Connection, completion: Option<Arc<SwitchBarrier>>) {
        previous.active.store(false, Ordering::Release);
        previous.server.stop();
        let manager = self.clone();
        std::thread::spawn(move || {
            let _gate = previous
                .io
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            // Reconnecting to the same UDN must never deliver an old Stop to the new session.
            let result = if manager
                .selected()
                .is_none_or(|current| current.device.id != previous.device.id)
            {
                protocol::transport(&previous.client, &previous.device, "Stop", &[])
                    .map(|_| ())
                    .map_err(|error| format!("上一个投屏设备未确认停止：{error}"))
            } else {
                Ok(())
            };
            if let Some(completion) = completion {
                *completion
                    .result
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()) = Some(result);
                completion.changed.notify_all();
            }
        });
    }
}

impl Connection {
    fn await_previous_stop(&self) -> Result<(), String> {
        let result = self
            .ready
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (result, _) = self
            .ready
            .changed
            .wait_timeout_while(result, Duration::from_secs(20), |result| result.is_none())
            .unwrap_or_else(|error| error.into_inner());
        result
            .clone()
            .unwrap_or_else(|| Err("等待上一个投屏设备停止超时".into()))
    }
    pub fn stop_for_transition(&self, generation: u64, revision: u64) -> Result<(), String> {
        let previous = self.await_previous_stop();
        self.action(generation, revision, Action::Stop)?;
        previous
    }
    pub fn state(&self) -> CastState {
        CastState {
            session_id: self.id,
            generation: self.generation.load(Ordering::Acquire),
            device_id: self.device.id.clone(),
            device_name: self.device.name.clone(),
            capabilities: self
                .capabilities
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone(),
        }
    }
    pub fn matches(&self, id: u64, generation: u64) -> bool {
        self.id == id
            && self.active.load(Ordering::Acquire)
            && self.generation.load(Ordering::Acquire) == generation
    }
    pub fn begin_load(&self, generation: u64, autoplay: bool) {
        self.generation.store(generation, Ordering::Release);
        self.revision.fetch_add(1, Ordering::AcqRel);
        self.play_revision.fetch_add(1, Ordering::AcqRel);
        self.desired_play.store(autoplay, Ordering::Release);
        self.server.clear();
    }
    pub fn change_intent(&self, autoplay: bool) {
        self.desired_play.store(autoplay, Ordering::Release);
        self.revision.fetch_add(1, Ordering::AcqRel);
        self.play_revision.fetch_add(1, Ordering::AcqRel);
    }
    pub fn change_seek(&self) {
        self.revision.fetch_add(1, Ordering::AcqRel);
        self.seek_revision.fetch_add(1, Ordering::AcqRel);
    }
    pub fn change_volume(&self) {
        self.volume_revision.fetch_add(1, Ordering::AcqRel);
    }
    pub fn effect_revision(&self, action: Action) -> u64 {
        match action {
            Action::Play | Action::Pause | Action::Stop => {
                self.play_revision.load(Ordering::Acquire)
            }
            Action::Seek(_) => self.seek_revision.load(Ordering::Acquire),
            Action::Volume(_) => self.volume_revision.load(Ordering::Acquire),
        }
    }
    fn qualify(&self, generation: u64) -> Result<(), String> {
        if self.matches(self.id, generation) {
            Ok(())
        } else {
            Err("投屏操作已被新的播放动作替代".into())
        }
    }
    pub fn load(
        &self,
        generation: u64,
        source: PlaySource,
        track: &Track,
        start_ms: u64,
    ) -> Result<Loaded, String> {
        self.await_previous_stop()?;
        let _gate = self.io.lock().unwrap_or_else(|error| error.into_inner());
        self.qualify(generation)?;
        self.server.clear();
        if track.start_ms.is_some() || track.end_ms.is_some() {
            return Err("DLNA 暂不支持 CUE 区间曲目".into());
        }
        let address = protocol::route_ip(&self.device)?;
        let (resource, raw, is_local, fetched_at) = match source {
            PlaySource::Local { path } => (Resource::File(path.clone().into()), path, true, None),
            PlaySource::Online {
                url,
                referer,
                fetchedAt,
            } => {
                crate::net_guard::ensure_public_http_url(&url)?;
                (
                    Resource::Online {
                        url: url.clone(),
                        referer,
                    },
                    url,
                    false,
                    Some(fetchedAt),
                )
            }
        };
        let info = self.server.probe(&resource, media::mime(&raw, false))?;
        let mime = info.mime;
        if !self.device.supports_mime(&mime) {
            return Err(format!("设备未声明支持此音频格式（{mime}）"));
        }
        self.qualify(generation)?;
        let seekable = self.device.capabilities.seek && info.seek;
        self.capabilities
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .seek = seekable;
        let uri = self.server.register(address, resource, &mime)?;
        let cover = if track.pic_url.is_empty() {
            String::new()
        } else {
            let resource = if track.pic_url.starts_with("http") {
                Some(Resource::Online {
                    url: track.pic_url.clone(),
                    referer: String::new(),
                })
            } else if std::path::Path::new(&track.pic_url).is_absolute() {
                Some(Resource::File(track.pic_url.clone().into()))
            } else {
                None
            };
            resource
                .and_then(|resource| {
                    self.server
                        .register(address, resource, media::mime(&track.pic_url, true))
                        .ok()
                })
                .unwrap_or_default()
        };
        let metadata = metadata(track, &uri, &mime, &cover);
        protocol::transport(&self.client, &self.device, "Stop", &[]).ok();
        self.qualify(generation)?;
        protocol::transport(
            &self.client,
            &self.device,
            "SetAVTransportURI",
            &[
                ("CurrentURI", uri.clone()),
                ("CurrentURIMetaData", metadata),
            ],
        )?;
        self.qualify(generation)?;
        let mut playing = false;
        if start_ms > 0 && seekable {
            // Devices accepting Seek only after Play are handled by seeking after start.
            if self.desired_play.load(Ordering::Acquire) {
                protocol::transport(&self.client, &self.device, "Play", &[("Speed", "1".into())])?;
                playing = true;
            }
            self.qualify(generation)?;
            protocol::transport(
                &self.client,
                &self.device,
                "Seek",
                &[
                    ("Unit", "REL_TIME".into()),
                    ("Target", protocol::format_time(start_ms)),
                ],
            )?;
        } else if self.desired_play.load(Ordering::Acquire) {
            protocol::transport(&self.client, &self.device, "Play", &[("Speed", "1".into())])?;
            playing = true;
        }
        self.qualify(generation)?;
        if playing && !self.desired_play.load(Ordering::Acquire) {
            protocol::transport(
                &self.client,
                &self.device,
                if self.device.capabilities.pause {
                    "Pause"
                } else {
                    "Stop"
                },
                &[],
            )?;
            playing = false;
        } else if !playing && self.desired_play.load(Ordering::Acquire) {
            protocol::transport(&self.client, &self.device, "Play", &[("Speed", "1".into())])?;
            playing = true;
        }
        Ok(Loaded {
            uri,
            play_url: (!is_local).then_some(raw),
            is_local,
            fetched_at,
            playing,
            position_ms: if seekable { start_ms } else { 0 },
        })
    }
    pub fn action(&self, generation: u64, revision: u64, action: Action) -> Result<(), String> {
        let _gate = self.io.lock().unwrap_or_else(|error| error.into_inner());
        self.qualify(generation)?;
        if self.effect_revision(action) != revision {
            return Err("投屏控制已被新的同类操作替代".into());
        }
        match action {
            Action::Play => {
                protocol::transport(&self.client, &self.device, "Play", &[("Speed", "1".into())])
                    .map(|_| ())
            }
            Action::Pause => {
                if !self.device.capabilities.pause {
                    return Err("此设备不支持暂停，可停止投屏".into());
                }
                protocol::transport(&self.client, &self.device, "Pause", &[]).map(|_| ())
            }
            Action::Stop => {
                protocol::transport(&self.client, &self.device, "Stop", &[]).map(|_| ())
            }
            Action::Seek(ms) => {
                if !self
                    .capabilities
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .seek
                {
                    return Err("此设备或当前音频不支持进度拖动".into());
                }
                protocol::transport(
                    &self.client,
                    &self.device,
                    "Seek",
                    &[
                        ("Unit", "REL_TIME".into()),
                        ("Target", protocol::format_time(ms)),
                    ],
                )
                .map(|_| ())
            }
            Action::Volume(value) => {
                if !self.device.capabilities.volume {
                    return Err("此设备不支持远程音量".into());
                }
                let service = self.device.rendering.as_ref().ok_or("设备没有音量服务")?;
                let range = self
                    .device
                    .volume_max
                    .saturating_sub(self.device.volume_min);
                let volume =
                    self.device.volume_min + (value.clamp(0.0, 1.0) * range as f32).round() as u32;
                protocol::soap(
                    &self.client,
                    service,
                    "SetVolume",
                    &[
                        ("InstanceID", "0".into()),
                        ("Channel", "Master".into()),
                        ("DesiredVolume", volume.to_string()),
                    ],
                )
                .map(|_| ())
            }
        }
    }
    pub fn poll(&self, generation: u64) -> Result<Poll, String> {
        let _gate = self.io.lock().unwrap_or_else(|error| error.into_inner());
        self.qualify(generation)?;
        let revision = self.revision.load(Ordering::Acquire);
        let transport = protocol::transport(&self.client, &self.device, "GetTransportInfo", &[])?;
        self.qualify(generation)?;
        let position = protocol::transport(&self.client, &self.device, "GetPositionInfo", &[])?;
        self.qualify(generation)?;
        Ok(Poll {
            phase: protocol::xml_value(&transport, "CurrentTransportState")?,
            position_ms: protocol::parse_time(&protocol::xml_value(&position, "RelTime")?),
            duration_ms: protocol::parse_time(&protocol::xml_value(&position, "TrackDuration")?),
            uri: protocol::xml_value(&position, "TrackURI")?,
            revision,
        })
    }
}

#[tauri::command(rename = "dlna_discover")]
pub async fn cmd_discover(
    state: tauri::State<'_, crate::AppState>,
    timeout_ms: Option<u64>,
) -> Result<Vec<Device>, String> {
    let manager = state.engine.dlna_manager();
    tauri::async_runtime::spawn_blocking(move || manager.discover(timeout_ms.unwrap_or(3000)))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command(rename = "dlna_connect")]
pub async fn cmd_connect(
    state: tauri::State<'_, crate::AppState>,
    device_id: String,
) -> Result<CastState, String> {
    state.engine.connect_dlna(device_id).await
}

#[tauri::command(rename = "dlna_disconnect")]
pub async fn cmd_disconnect(
    state: tauri::State<'_, crate::AppState>,
    return_to_local: Option<bool>,
) -> Result<(), String> {
    state
        .engine
        .disconnect_dlna(return_to_local.unwrap_or(false))
        .await
}

pub struct Loaded {
    pub uri: String,
    pub play_url: Option<String>,
    pub is_local: bool,
    pub fetched_at: Option<u64>,
    pub playing: bool,
    pub position_ms: u64,
}

#[derive(Clone, Copy)]
pub enum Action {
    Play,
    Pause,
    Stop,
    Seek(u64),
    Volume(f32),
}

pub struct Poll {
    pub phase: String,
    pub position_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub uri: String,
    pub revision: u64,
}

pub fn metadata(track: &Track, uri: &str, mime: &str, cover: &str) -> String {
    let cover = if cover.is_empty() {
        String::new()
    } else {
        format!(
            "<upnp:albumArtURI>{}</upnp:albumArtURI>",
            protocol::escape(cover)
        )
    };
    let duration = if track.duration.is_finite()
        && (0.0..=86400.0).contains(&track.duration)
        && track.duration > 0.0
    {
        format!(
            " duration=\"{}\"",
            protocol::format_time((track.duration * 1000.0) as u64)
        )
    } else {
        String::new()
    };
    format!("<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"0\" restricted=\"1\"><dc:title>{}</dc:title><upnp:artist>{}</upnp:artist><upnp:album>{}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class>{cover}<res protocolInfo=\"http-get:*:{mime}:*\"{duration}>{}</res></item></DIDL-Lite>",
        protocol::escape(&track.title), protocol::escape(&track.singer), protocol::escape(&track.album), protocol::escape(uri))
}

/// A pause, fresh load, missing duration, foreign URI or network failure is never EOF.
pub fn natural_end(
    was_playing: bool,
    phase: &str,
    previous_ms: u64,
    duration_ms: u64,
    desired_play: bool,
    same_uri: bool,
) -> bool {
    was_playing
        && desired_play
        && same_uri
        && phase == "STOPPED"
        && duration_ms > 0
        && previous_ms > 0
        && previous_ms.saturating_add(1800) >= duration_ms
}

/// Isolated real transport for adapter regressions; never discovers LAN devices.
#[cfg(test)]
pub(crate) fn loopback_test_connection(
    pause: bool,
    control_url: tauri::Url,
) -> (Connection, media::MediaServerRun) {
    assert_eq!(control_url.host_str(), Some("127.0.0.1"));
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let (server, run) = MediaServer::start_owned_loopback(listener, client.clone()).unwrap();
    let capabilities = Capabilities { pause, ..Capabilities::default() };
    let device = Renderer {
        id: "uuid:pause-regression".into(),
        name: "Pause regression".into(),
        location: control_url.clone(),
        transport: protocol::Service {
            kind: "urn:schemas-upnp-org:service:AVTransport:1".into(),
            control_url: control_url.clone(),
            scpd_url: control_url,
        },
        rendering: None,
        connection: None,
        capabilities: capabilities.clone(),
        mime_types: Vec::new(),
        volume_min: 0,
        volume_max: 100,
        peer_ip: None,
    };
    let connection = Connection(Arc::new(ConnectionInner {
        id: 1,
        device,
        client,
        generation: AtomicU64::new(0),
        revision: AtomicU64::new(0),
        play_revision: AtomicU64::new(0),
        seek_revision: AtomicU64::new(0),
        volume_revision: AtomicU64::new(0),
        desired_play: AtomicBool::new(false),
        active: AtomicBool::new(true),
        io: Arc::new(Mutex::new(())),
        server,
        capabilities: Mutex::new(capabilities),
        ready: Arc::new(SwitchBarrier {
            result: Mutex::new(Some(Ok(()))),
            changed: Condvar::new(),
        }),
    }));
    (connection, run)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stopped_requires_qualified_near_end_playback() {
        assert!(natural_end(true, "STOPPED", 29_000, 30_000, true, true));
        assert!(!natural_end(false, "STOPPED", 29_000, 30_000, true, true));
        assert!(!natural_end(true, "STOPPED", 0, 30_000, true, true));
        assert!(!natural_end(true, "STOPPED", 29_000, 30_000, false, true));
        assert!(!natural_end(true, "STOPPED", 29_000, 30_000, true, false));
        assert!(!natural_end(true, "STOPPED", 29_000, 0, true, true));
        assert!(!natural_end(
            true,
            "PAUSED_PLAYBACK",
            29_000,
            30_000,
            true,
            true
        ));
    }

    #[test]
    #[ignore = "requires tools/dlna/emulator.mjs and DLNA_TEST_RENDERER_URL"]
    fn emulator_production_transport_and_media() {
        use crate::provider::types::SourceId;
        let location = std::env::var("DLNA_TEST_RENDERER_URL").expect("renderer device.xml URL");
        let client = protocol::client().unwrap();
        let device = protocol::inspect(&client, tauri::Url::parse(&location).unwrap()).unwrap();
        let discovered = protocol::discover(1000).unwrap();
        assert!(discovered.iter().any(|renderer| renderer.id == device.id),
            "production SSDP discovery did not find the running emulator");
        let manager = DlnaManager::default();
        manager
            .0
            .devices
            .lock()
            .unwrap()
            .insert(device.id.clone(), device.clone());
        let connection = manager.select(&device.id).unwrap();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/self-authored-silence.wav");
        let track = Track {
            id: path.to_string_lossy().into_owned(),
            platform: SourceId::new("local"),
            title: "DLNA <test> & 本地".into(),
            singer: "QuietMusic".into(),
            album: "test".into(),
            pic_url: String::new(),
            duration: 30.0,
            music_id: None,
            start_ms: None,
            end_ms: None,
        };
        connection.begin_load(1, true);
        let loaded = connection
            .load(
                1,
                PlaySource::Local {
                    path: track.id.clone(),
                },
                &track,
                0,
            )
            .unwrap();
        let state = connection.poll(1).unwrap();
        assert_eq!(state.phase, "PLAYING");
        assert_eq!(state.uri, loaded.uri);
        let head = client.head(&loaded.uri).send().unwrap();
        assert_eq!(head.status().as_u16(), 200);
        assert!(head.headers().contains_key("content-length"));
        let range = client
            .get(&loaded.uri)
            .header("Range", "bytes=0-15")
            .send()
            .unwrap();
        assert_eq!(range.status().as_u16(), 206);
        assert_eq!(range.bytes().unwrap().len(), 16);
        connection.change_intent(false);
        connection
            .action(1, connection.effect_revision(Action::Pause), Action::Pause)
            .unwrap();
        assert_eq!(connection.poll(1).unwrap().phase, "PAUSED_PLAYBACK");
        connection.change_intent(true);
        let play_revision = connection.effect_revision(Action::Play);
        connection.change_volume();
        // A later volume operation must not revoke an independent Play.
        connection.action(1, play_revision, Action::Play).unwrap();
        connection
            .action(
                1,
                connection.effect_revision(Action::Volume(0.4)),
                Action::Volume(0.4),
            )
            .unwrap();
        assert_eq!(connection.poll(1).unwrap().phase, "PLAYING");
        connection.change_seek();
        connection
            .action(
                1,
                connection.effect_revision(Action::Seek(5000)),
                Action::Seek(5000),
            )
            .unwrap();
        assert!(connection.poll(1).unwrap().position_ms.unwrap() >= 5000);
        connection.begin_load(2, false);
        assert!(connection.action(1, play_revision, Action::Play).is_err());
        connection
            .action(2, connection.effect_revision(Action::Stop), Action::Stop)
            .unwrap();
        assert_eq!(connection.poll(2).unwrap().phase, "STOPPED");
        manager.disconnect();
    }
}
