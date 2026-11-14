//! DLNA effects for the original AudioEngine queue/intent/source boundary.
use super::*;
use crate::dlna::{self, Action, Connection, Loaded, Poll};

pub(super) struct RemotePlayback {
    pub connection: Connection,
    pub loaded: bool,
    pub pending_seek: Option<super::super::render_control::BoundSeekRequest>,
    poll_pending: bool,
    last_poll: Instant,
    uri: String,
    was_playing: bool,
    last_position_ms: u64,
    duration_ms: u64,
    failures: u8,
    desired_volume: f32,
    loaded_at: Instant,
}

pub struct LoadResult {
    pub session_id: u64,
    pub request: SourceLoadRequest,
    pub result: Result<Loaded, String>,
}
pub struct PollResult {
    session_id: u64,
    generation: u64,
    result: Result<Poll, String>,
}
pub struct DisconnectResult {
    session_id: u64,
    generation: u64,
    revision: u64,
    return_to_local: bool,
    reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    result: Result<(), String>,
}
pub struct ActionResult {
    session_id: u64,
    generation: u64,
    revision: u64,
    action: Action,
    previous_playing: Option<bool>,
    seek: Option<super::super::render_control::BoundSeekRequest>,
    result: Result<(), String>,
}

fn request_pause(connection: &Connection) -> Result<(), String> {
    if !connection.device.capabilities.pause {
        return Err("此设备不支持暂停，可停止投屏".into());
    }
    connection.change_intent(false);
    Ok(())
}

/// Failed controls must not leave an unfulfilled pause intent blocking natural EOF.
/// The same action qualification also prevents late failures undoing a newer control.
fn restore_failed_transport_intent(
    connection: &Connection,
    generation: u64,
    revision: u64,
    action: Action,
    previous_playing: Option<bool>,
) -> bool {
    let Some(previous_playing) = previous_playing else {
        return false;
    };
    if !matches!(action, Action::Play | Action::Pause)
        || !connection.matches(connection.id, generation)
        || connection.effect_revision(action) != revision
    {
        return false;
    }
    // Invalidate polls started with the rejected intent; refresh from the renderer next.
    connection.change_intent(previous_playing);
    true
}

fn current(inner: &EngineInner, session: u64, generation: u64) -> bool {
    inner
        .remote
        .as_ref()
        .is_some_and(|remote| remote.connection.matches(session, generation))
        && inner.load_gen == generation
}

fn clear_local(inner: &mut EngineInner) {
    invalidate_preload(inner);
    inner.sink.pause();
    inner.sink.clear();
    inner.current_shared = None;
    inner.current_progress = None;
    if let Some(port) = inner.current_mount.take() {
        port.retire();
    }
    inner.eof_queued = false;
    inner.pause_deadline = None;
    inner.fx.clear_fade();
    *inner
        .cache_file
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
}

fn queue_resume(inner: &mut EngineInner, position_ms: u64, autoplay: bool) {
    let index = inner
        .queue
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .index;
    if let Some(index) = index {
        let ticket = inner.owner.begin_play_intent();
        inner.route_resume = Some((ticket, position_ms, autoplay));
        let _receipt = inner.owner.send_play_at(index, Some(ticket));
    }
}

fn action(
    inner: &mut EngineInner,
    action: Action,
    seek: Option<super::super::render_control::BoundSeekRequest>,
) {
    let Some(remote) = &inner.remote else {
        if let Some(seek) = seek {
            seek.external_complete(false);
        }
        return;
    };
    let connection = remote.connection.clone();
    let generation = inner.load_gen;
    let session_id = connection.id;
    let revision = connection.effect_revision(action);
    // Use the last confirmed state, not a previous unacknowledged command's intent.
    let previous_playing = matches!(action, Action::Play | Action::Pause)
        .then(|| inner.owner.snapshot().status == PlaybackStatus::Playing);
    let tx = inner.tx.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = connection.action(generation, revision, action);
        let _ = tx.send(AudioCmd::DlnaAction(Box::new(ActionResult {
            session_id,
            generation,
            revision,
            action,
            previous_playing,
            seek,
            result,
        })));
    });
}

fn remote_error(inner: &mut EngineInner, message: String) {
    if let Some(remote) = &mut inner.remote {
        remote.connection.change_intent(false);
        remote.loaded = false;
        remote.poll_pending = false;
        if let Some(request) = remote.pending_seek.take() { request.external_complete(false); }
    }
    inner.auto_next = false;
    inner.settle_listen(false, false);
    inner.mutate(|state| {
        state.status = PlaybackStatus::Error;
        state.error = Some(message);
    });
}

pub(super) fn route(inner: &mut EngineInner, cmd: AudioCmd) -> Option<AudioCmd> {
    match cmd {
        AudioCmd::DlnaConnect { device_id, reply } => {
            let snapshot = inner.owner.snapshot();
            if snapshot
                .track
                .as_ref()
                .is_some_and(|track| track.start_ms.is_some() || track.end_ms.is_some())
            {
                let _ = reply.send(Err("DLNA 暂不支持 CUE 区间曲目".into()));
                return None;
            }
            match inner.owner.dlna.select(&device_id) {
                Ok(connection) => {
                    let state = connection.state();
                    inner.settle_listen(false, true);
                    inner.load_gen = inner.load_gen.wrapping_add(1);
                    clear_local(inner);
                    inner.remote = Some(RemotePlayback {
                        connection,
                        loaded: false,
                        pending_seek: None,
                        poll_pending: false,
                        last_poll: Instant::now(),
                        uri: String::new(),
                        was_playing: false,
                        last_position_ms: 0,
                        duration_ms: 0,
                        failures: 0,
                        desired_volume: snapshot.volume,
                        loaded_at: Instant::now(),
                    });
                    inner.mutate(|snapshot| {
                        snapshot.cast = Some(state.clone());
                        snapshot.speed = 1.0;
                        snapshot.error = None;
                        snapshot.status = if snapshot.track.is_some() {
                            PlaybackStatus::Loading
                        } else {
                            PlaybackStatus::Stopped
                        };
                    });
                    queue_resume(
                        inner,
                        snapshot.position_ms,
                        snapshot.status == PlaybackStatus::Playing,
                    );
                    let _ = reply.send(Ok(state));
                }
                Err(error) => {
                    let _ = reply.send(Err(error));
                }
            }
            None
        }
        AudioCmd::DlnaDisconnect {
            return_to_local,
            reply,
        } => {
            if inner.remote.is_none() {
                let _ = reply.send(Ok(()));
                return None;
            }
            inner.load_gen = inner.load_gen.wrapping_add(1);
            let remote = inner.remote.as_mut().expect("selected remote");
            remote.connection.begin_load(inner.load_gen, false);
            remote.loaded = false;
            if let Some(request) = remote.pending_seek.take() { request.external_complete(false); }
            inner.auto_next = false;
            let connection = remote.connection.clone();
            let session_id = connection.id;
            let generation = inner.load_gen;
            let revision = connection.effect_revision(Action::Stop);
            let tx = inner.tx.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let result = connection.stop_for_transition(generation, revision);
                let _ = tx.send(AudioCmd::DlnaDisconnected(Box::new(DisconnectResult {
                    session_id,
                    generation,
                    revision,
                    return_to_local,
                    reply,
                    result,
                })));
            });
            None
        }
        AudioCmd::DlnaDisconnected(result) => {
            let DisconnectResult {
                session_id,
                generation,
                revision,
                return_to_local,
                reply,
                result,
            } = *result;
            if !current(inner, session_id, generation)
                || inner.remote.as_ref().is_none_or(|remote| {
                    remote.connection.effect_revision(Action::Stop) != revision
                })
            {
                let _ = reply.send(Err("断开操作已被新的播放动作替代".into()));
                return None;
            }
            let position_ms = inner.owner.snapshot().position_ms;
            let warning = result.err().map(|error| {
                format!("投屏设备未响应停止指令，连接已断开；电视可能仍在播放：{error}")
            });
            inner.owner.dlna.disconnect();
            inner.remote = None;
            inner.load_gen = inner.load_gen.wrapping_add(1);
            inner.settle_listen(false, true);
            clear_local(inner);
            let speed = inner.speed;
            inner.mutate(|state| {
                state.cast = None;
                state.speed = speed;
                state.status = PlaybackStatus::Stopped;
                state.error = warning.clone();
            });
            if let Some(warning) = warning {
                let _ = inner.app.emit("dlna-notice", warning);
            }
            queue_resume(inner, position_ms, return_to_local);
            let _ = reply.send(Ok(()));
            None
        }
        AudioCmd::DlnaLoaded(result) => {
            let LoadResult {
                session_id,
                request,
                result,
            } = *result;
            if !current(inner, session_id, request.gen) {
                if let Some(port) = request.port {
                    port.retire();
                }
                return None;
            }
            let Some(port) = request.port else {
                remote_error(inner, "投屏缺少播放资格".into());
                return None;
            };
            if request.target.as_ref() != inner.play_target.as_ref() {
                port.retire();
                return None;
            }
            match result {
                Ok(loaded) => {
                    port.external_position(loaded.position_ms);
                    port.set_paused(!loaded.playing);
                    if !inner.owner.complete_source_mount(&port) {
                        return None;
                    }
                    clear_local(inner);
                    inner.current_progress = Some(port.progress());
                    inner.current_mount = Some(port.clone());
                    let duration_ms = meta_duration_ms(&request.track);
                    let mut snapshot = inner.owner.snapshot();
                    snapshot.status = if loaded.playing {
                        PlaybackStatus::Playing
                    } else {
                        PlaybackStatus::Paused
                    };
                    snapshot.is_local = loaded.is_local;
                    snapshot.position_ms = loaded.position_ms;
                    snapshot.duration_ms = duration_ms;
                    snapshot.buffered_ms = 0;
                    snapshot.url_fetched_at = loaded.fetched_at;
                    snapshot.play_url = loaded.play_url;
                    snapshot.error = None;
                    snapshot.cast = inner
                        .remote
                        .as_ref()
                        .map(|remote| remote.connection.state());
                    if !inner.owner.publish_source_state(&port, snapshot) {
                        return None;
                    }
                    if let Some(remote) = &mut inner.remote {
                        remote.loaded = true;
                        remote.uri = loaded.uri;
                        remote.was_playing = false;
                        remote.last_position_ms = loaded.position_ms;
                        remote.duration_ms = duration_ms;
                        remote.failures = 0;
                        remote.last_poll = Instant::now() - Duration::from_secs(2);
                        remote.loaded_at = Instant::now();
                    }
                    let pending_seek = inner.remote.as_mut().and_then(|remote| remote.pending_seek.take());
                    if let Some(request) = pending_seek {
                        if request.external_ready() {
                            action(inner, Action::Seek(request.position_ms()), Some(request));
                        } else { request.external_complete(false); }
                    }
                    let desired = inner
                        .remote
                        .as_ref()
                        .expect("loaded remote")
                        .connection
                        .desired_play
                        .load(Ordering::Acquire);
                    if desired != loaded.playing {
                        action(
                            inner,
                            if desired { Action::Play } else { Action::Pause },
                            None,
                        );
                    }
                    inner.begin_listen(&request.track, duration_ms);
                    inner.publish();
                    inner.tick_anchor = None;
                    emit_position_tick(inner);
                    if inner
                        .remote
                        .as_ref()
                        .is_some_and(|remote| remote.connection.device.capabilities.volume)
                    {
                        action(inner, Action::Volume(inner.effective_volume()), None);
                    }
                }
                Err(message) => {
                    port.retire();
                    remote_error(inner, message);
                    action(inner, Action::Stop, None);
                }
            }
            None
        }
        AudioCmd::DlnaPoll(result) => {
            let PollResult {
                session_id,
                generation,
                result,
            } = *result;
            if !current(inner, session_id, generation) {
                return None;
            }
            if let Some(remote) = &mut inner.remote {
                remote.poll_pending = false;
            }
            match result {
                Ok(poll) => {
                    let remote = inner.remote.as_mut().expect("qualified remote");
                    if poll.revision != remote.connection.revision.load(Ordering::Acquire) {
                        return None;
                    }
                    remote.failures = 0;
                    let same_uri = !remote.uri.is_empty() && poll.uri == remote.uri;
                    if !poll.uri.is_empty() && !same_uri {
                        remote_error(inner, "电视已切换到其他内容，轻听投屏已停止".into());
                        return None;
                    }
                    let duration_ms = poll
                        .duration_ms
                        .filter(|duration| *duration > 0)
                        .unwrap_or(remote.duration_ms);
                    let ended = dlna::natural_end(
                        remote.was_playing,
                        &poll.phase,
                        remote.last_position_ms,
                        duration_ms,
                        remote.connection.desired_play.load(Ordering::Acquire),
                        same_uri,
                    );
                    let unconfirmed_stop = !ended
                        && poll.phase == "STOPPED"
                        && remote.connection.desired_play.load(Ordering::Acquire)
                        && (remote.was_playing
                            || remote.loaded_at.elapsed() >= Duration::from_secs(3));
                    let position_ms = if ended {
                        duration_ms
                    } else if matches!(poll.phase.as_str(), "STOPPED" | "NO_MEDIA_PRESENT")
                        && poll.position_ms == Some(0)
                    {
                        remote.last_position_ms
                    } else {
                        poll.position_ms.unwrap_or(remote.last_position_ms)
                    };
                    remote.last_position_ms = position_ms;
                    remote.duration_ms = duration_ms;
                    remote.was_playing = poll.phase == "PLAYING";
                    let status = if ended {
                        PlaybackStatus::Playing
                    } else {
                        match poll.phase.as_str() {
                            "PLAYING" => PlaybackStatus::Playing,
                            "PAUSED_PLAYBACK" => PlaybackStatus::Paused,
                            "TRANSITIONING" => PlaybackStatus::Buffering,
                            "STOPPED" | "NO_MEDIA_PRESENT" => PlaybackStatus::Stopped,
                            _ => PlaybackStatus::Buffering,
                        }
                    };
                    if let Some(port) = &inner.current_mount {
                        port.external_position(position_ms);
                        if status == PlaybackStatus::Playing {
                            port.set_paused(false);
                        } else if status == PlaybackStatus::Paused {
                            port.set_paused(true);
                        }
                    }
                    let old = inner.owner.snapshot();
                    inner.mutate(|state| {
                        state.status = status;
                        state.position_ms = position_ms;
                        state.duration_ms = duration_ms;
                        if unconfirmed_stop {
                            state.error =
                                Some("电视已停止播放，未确认自然结束；可重试播放或切回本机".into());
                        }
                    });
                    if old.status == PlaybackStatus::Playing && status != PlaybackStatus::Playing {
                        inner.settle_listen(false, false);
                    }
                    inner.tick_anchor = None;
                    emit_position_tick(inner);
                    if ended
                        && inner
                            .current_mount
                            .as_ref()
                            .is_some_and(|port| port.external_finished())
                    {
                        advance(inner, true);
                    }
                }
                Err(error) => {
                    let remote = inner.remote.as_mut().expect("qualified remote");
                    remote.failures = remote.failures.saturating_add(1);
                    if remote.failures >= 3 {
                        remote_error(inner, format!("投屏设备连接中断：{error}"));
                    }
                }
            }
            None
        }
        AudioCmd::DlnaAction(result) => {
            let ActionResult {
                session_id,
                generation,
                revision,
                action: operation,
                previous_playing,
                seek,
                result,
            } = *result;
            if !current(inner, session_id, generation) {
                if let Some(seek) = seek {
                    seek.external_complete(false);
                }
                return None;
            }
            if inner
                .remote
                .as_ref()
                .is_none_or(|remote| revision != remote.connection.effect_revision(operation))
            {
                if let Some(seek) = seek {
                    seek.external_complete(false);
                }
                return None;
            }
            if let Some(seek) = seek {
                seek.external_complete(result.is_ok());
            }
            match result {
                Ok(()) => {
                    match operation {
                        Action::Play | Action::Pause => {}
                        Action::Stop => {
                            inner.mutate(|state| state.status = PlaybackStatus::Stopped);
                            if let Some(remote) = &mut inner.remote {
                                remote.loaded = false;
                            }
                        }
                        Action::Seek(position_ms) => {
                            if let Some(port) = &inner.current_mount {
                                port.external_position(position_ms);
                            }
                            if let Some(remote) = &mut inner.remote {
                                remote.last_position_ms = position_ms;
                            }
                            inner.mutate(|state| state.position_ms = position_ms);
                            inner.tick_anchor = None;
                            emit_position_tick(inner);
                        }
                        Action::Volume(volume) => {
                            inner.mutate(|state| {
                                if !state.muted {
                                    state.volume = volume;
                                }
                            });
                            inner.persist_state();
                        }
                    }
                    if let Some(remote) = &mut inner.remote {
                        remote.last_poll = Instant::now() - Duration::from_secs(2);
                    }
                }
                Err(error) => {
                    if let Some(remote) = &mut inner.remote {
                        if restore_failed_transport_intent(
                            &remote.connection,
                            generation,
                            revision,
                            operation,
                            previous_playing,
                        ) {
                            remote.last_poll = Instant::now() - Duration::from_secs(2);
                        }
                    }
                    inner.mutate(|state| state.error = Some(error));
                }
            }
            None
        }
        AudioCmd::DlnaBoundPause { target, original, session_id, generation, paused } => {
            if current(inner, session_id, generation) && inner.play_target.as_ref() == Some(&target)
                && inner.owner.source_mount(&target).is_some_and(|port| Arc::ptr_eq(&port, &original))
            {
                let operation = if paused {
                    AudioCmd::Pause
                } else {
                    AudioCmd::Play
                };
                let _ = route(inner, operation);
            }
            None
        }
        AudioCmd::DlnaBoundSeek { request, session_id, generation } => {
            if current(inner, session_id, generation)
                && inner.play_target.as_ref() == Some(request.original_target())
            {
                let position_ms = request.position_ms();
                if let Some(remote) = &inner.remote {
                    remote.connection.change_seek();
                }
                if inner.remote.as_ref().is_some_and(|remote| !remote.loaded) {
                    if let Some(old) = inner.remote.as_mut().expect("selected remote").pending_seek.replace(request) {
                        old.external_complete(false);
                    }
                } else if request.external_ready() {
                    action(inner, Action::Seek(position_ms), Some(request));
                } else { request.external_complete(false); }
            } else {
                request.external_complete(false);
            }
            None
        }
        cmd if inner.remote.is_none() => Some(cmd),
        AudioCmd::Play => {
            inner.mutate(|state| state.error = None);
            let remote = inner.remote.as_ref().expect("remote");
            remote.connection.change_intent(true);
            if remote.loaded {
                action(inner, Action::Play, None);
            } else if let Some(track) = inner.owner.snapshot().track {
                let position_ms = inner.owner.snapshot().position_ms;
                load_queue_track(inner, track, true, position_ms);
            }
            None
        }
        AudioCmd::Pause => {
            let remote = inner.remote.as_ref().expect("remote");
            if let Err(error) = request_pause(&remote.connection) {
                inner.mutate(|state| state.error = Some(error));
                return None;
            }
            if remote.loaded {
                action(inner, Action::Pause, None);
            }
            None
        }
        AudioCmd::Stop => {
            inner.settle_listen(false, true);
            inner.load_gen = inner.load_gen.wrapping_add(1);
            let remote = inner.remote.as_mut().expect("remote");
            remote.connection.begin_load(inner.load_gen, false);
            remote.loaded = false;
            if let Some(request) = remote.pending_seek.take() { request.external_complete(false); }
            inner.auto_next = false;
            action(inner, Action::Stop, None);
            inner.mutate(|state| {
                state.status = PlaybackStatus::Stopped;
                state.error = None;
            });
            None
        }
        AudioCmd::Seek(position_ms) => {
            if let Some(remote) = &inner.remote {
                remote.connection.change_seek();
            }
            action(inner, Action::Seek(position_ms), None);
            None
        }
        AudioCmd::SetVolume(volume) => {
            if !volume.is_finite() {
                return None;
            }
            let volume = volume.clamp(0.0, 1.0);
            if let Some(remote) = &mut inner.remote {
                remote.desired_volume = volume;
                remote.connection.change_volume();
            }
            let effective = if inner.owner.snapshot().muted {
                0.0
            } else {
                volume
            };
            action(inner, Action::Volume(effective), None);
            None
        }
        AudioCmd::SetMuted(muted) => {
            inner.mutate(|state| state.muted = muted);
            let volume = inner
                .remote
                .as_ref()
                .map_or(0.8, |remote| remote.desired_volume);
            if let Some(remote) = &inner.remote {
                remote.connection.change_volume();
            }
            action(
                inner,
                Action::Volume(if muted { 0.0 } else { volume }),
                None,
            );
            None
        }
        AudioCmd::LoadReady { .. }
        | AudioCmd::PreloadFailed { .. }
        | AudioCmd::LoadFailed { .. }
        | AudioCmd::StreamError { .. } => None,
        AudioCmd::SetSpeed(_)
        | AudioCmd::NativeSpeedSetting(_)
        | AudioCmd::SourceSpeedSetting(_) => {
            inner.mutate(|state| state.error = Some("DLNA 投屏不支持倍速播放".into()));
            None
        }
        AudioCmd::SetOutputDevice { .. } => {
            inner.mutate(|state| state.error = Some("请先切回本机，再更换本地输出设备".into()));
            None
        }
        AudioCmd::ClearQueue => {
            let _ = route(inner, AudioCmd::Stop);
            Some(AudioCmd::ClearQueue)
        }
        AudioCmd::Shutdown => {
            inner.owner.dlna.disconnect();
            Some(AudioCmd::Shutdown)
        }
        cmd => Some(cmd),
    }
}

pub(super) fn tick(inner: &mut EngineInner) {
    let Some(remote) = &mut inner.remote else {
        return;
    };
    if !remote.loaded || remote.poll_pending || remote.last_poll.elapsed() < Duration::from_secs(1)
    {
        return;
    }
    remote.poll_pending = true;
    remote.last_poll = Instant::now();
    let connection = remote.connection.clone();
    let session_id = connection.id;
    let generation = inner.load_gen;
    let tx = inner.tx.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = connection.poll(generation);
        let _ = tx.send(AudioCmd::DlnaPoll(Box::new(PollResult {
            session_id,
            generation,
            result,
        })));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::types::SourceId;

    #[test]
    fn unsupported_dlna_pause_keeps_natural_eof_eligible() {
        let (connection, _run) = dlna::loopback_test_connection(
            false,
            tauri::Url::parse("http://127.0.0.1:1/control").unwrap(),
        );
        connection.begin_load(1, true);
        let revision = connection.effect_revision(Action::Pause);
        assert!(request_pause(&connection).unwrap_err().contains("不支持暂停"));
        assert_eq!(connection.effect_revision(Action::Pause), revision);
        assert!(dlna::natural_end(
            true, "STOPPED", 29_000, 30_000,
            connection.desired_play.load(Ordering::Acquire), true,
        ));
    }

    #[test]
    fn rejected_dlna_pause_restores_playing_intent_and_natural_eof() {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = tauri::Url::parse(&format!("http://{}/control", listener.local_addr().unwrap())).unwrap();
        let renderer = std::thread::spawn(move || {
            let started = Instant::now();
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(started.elapsed() < Duration::from_secs(5), "Pause was not sent");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept Pause: {error}"),
                }
            };
            // Winsock may inherit FIONBIO from the nonblocking listener. Only accept
            // is polled; the bounded request/response exchange must use blocking IO.
            socket.set_nonblocking(false).unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            socket.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut reader = BufReader::new(&socket);
            let mut headers = String::new();
            let mut content_length = 0;
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" { break; }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        content_length = value.trim().parse::<usize>().unwrap();
                    }
                }
                headers.push_str(&line);
            }
            let mut request = vec![0; content_length];
            reader.read_exact(&mut request).unwrap();
            assert!(headers.contains("#Pause"));
            drop(reader);
            let body = "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError><errorCode>701</errorCode><errorDescription>Transition not available</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>";
            write!(socket, "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        let (connection, _run) = dlna::loopback_test_connection(true, url);
        connection.begin_load(1, true);
        request_pause(&connection).unwrap();
        let revision = connection.effect_revision(Action::Pause);
        let error = connection.action(1, revision, Action::Pause).unwrap_err();
        renderer.join().unwrap();
        assert!(error.contains("701"), "expected renderer SOAP rejection: {error}");
        assert!(restore_failed_transport_intent(&connection, 1, revision, Action::Pause, Some(true)));
        assert!(dlna::natural_end(
            true, "STOPPED", 29_000, 30_000,
            connection.desired_play.load(Ordering::Acquire), true,
        ));
        // A repeated delivery cannot restore a second time or invalidate newer polls.
        assert!(!restore_failed_transport_intent(&connection, 1, revision, Action::Pause, Some(true)));
    }

    #[test]
    fn late_dlna_control_failure_cannot_restore_over_a_new_intent_or_load() {
        let (connection, _run) = dlna::loopback_test_connection(
            true,
            tauri::Url::parse("http://127.0.0.1:1/control").unwrap(),
        );
        connection.begin_load(1, true);
        request_pause(&connection).unwrap();
        let old_pause = connection.effect_revision(Action::Pause);
        request_pause(&connection).unwrap();
        assert!(!restore_failed_transport_intent(&connection, 1, old_pause, Action::Pause, Some(true)));
        assert!(!connection.desired_play.load(Ordering::Acquire));
        let paused = connection.effect_revision(Action::Pause);
        connection.change_intent(true);
        assert!(!restore_failed_transport_intent(&connection, 1, paused, Action::Pause, Some(false)));
        assert!(connection.desired_play.load(Ordering::Acquire));
        let play = connection.effect_revision(Action::Play);
        connection.begin_load(2, false);
        assert!(!restore_failed_transport_intent(&connection, 1, play, Action::Play, Some(true)));
        assert!(!connection.desired_play.load(Ordering::Acquire));
    }

    #[test]
    fn dlna_volume_does_not_prevent_failed_transport_intent_restoration() {
        let (connection, _run) = dlna::loopback_test_connection(
            true,
            tauri::Url::parse("http://127.0.0.1:1/control").unwrap(),
        );
        connection.begin_load(1, false);
        connection.change_intent(true);
        let revision = connection.effect_revision(Action::Play);
        connection.change_volume();
        assert!(restore_failed_transport_intent(&connection, 1, revision, Action::Play, Some(false)));
        assert!(!connection.desired_play.load(Ordering::Acquire));
    }

    fn track(id: &str) -> Track {
        Track {
            id: id.into(),
            platform: SourceId::new("local"),
            title: id.into(),
            singer: String::new(),
            album: String::new(),
            pic_url: String::new(),
            duration: 1.0,
            recording: Default::default(), music_id: None,
            start_ms: None,
            end_ms: None,
        }
    }
    fn mounted() -> (
        AudioEngine,
        AudioCommandInbox,
        Arc<super::super::super::render_control::SourceSeekPort>,
        u64,
    ) {
        let (engine, inbox) = AudioEngine::command_channel();
        let _reply = engine.send_queue(vec![track("first"), track("second")], 0, None);
        let mut generation = 0;
        let AudioDelivery::Playback(plan) = inbox
            .recv_timeout(Duration::from_secs(1), &mut generation)
            .unwrap()
        else {
            panic!("queue commit");
        };
        let target = plan.target.unwrap();
        let port = engine.reserve_source_mount(target).unwrap();
        port.external_position(0);
        assert!(engine.complete_source_mount(&port));
        let mut state = engine.snapshot();
        state.status = PlaybackStatus::Playing;
        state.duration_ms = 1000;
        assert!(engine.publish_source_state(&port, state));
        (engine, inbox, port, generation)
    }
    #[test]
    fn dlna_external_eof_uses_the_real_queue_and_rejects_old_eof() {
        let (engine, inbox, port, mut generation) = mounted();
        port.external_position(1000);
        assert!(port.external_finished());
        engine.source_finished(port.clone());
        let AudioDelivery::AutomaticPlayback { advance, .. } = inbox
            .recv_timeout(Duration::from_secs(1), &mut generation)
            .unwrap()
        else {
            panic!("automatic queue commit");
        };
        assert_eq!(advance.track.unwrap().id, "second");
        assert_eq!(engine.queue_snapshot().index, Some(1));
        assert_eq!(engine.snapshot().status, PlaybackStatus::Loading);
        engine.source_finished(port);
        assert!(matches!(
            inbox
                .recv_timeout(Duration::from_secs(1), &mut generation)
                .unwrap(),
            AudioDelivery::Rejected
        ));
        assert_eq!(engine.queue_snapshot().index, Some(1));
    }
    #[test]
    fn dlna_late_bound_seek_cannot_touch_a_new_queue_target() {
        let (engine, inbox, port, mut generation) = mounted();
        let (request, mut pending) = super::super::super::render_control::BoundSeekRequest::new(
            port.stamp().clone(),
            port.clone(),
            800,
            1.0,
        )
        .unwrap();
        let _reply = engine.send_play_at(1, None);
        assert!(matches!(
            inbox
                .recv_timeout(Duration::from_secs(1), &mut generation)
                .unwrap(),
            AudioDelivery::ManualPlayback(_)
        ));
        request.external_complete(true);
        assert!(pending.try_recv().unwrap().is_err());
        assert_eq!(engine.snapshot().position_ms, 0);
        assert_eq!(engine.snapshot().track.unwrap().id, "second");
        assert_eq!(port.position_ms(), 0);
    }
}
