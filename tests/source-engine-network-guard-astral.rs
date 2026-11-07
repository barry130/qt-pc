//! Public native lifecycle regressions. HTTP is fake or owned loopback; credentials are fake;
//! the client, reply decoding, SQLite settings and session vault are production code.
use crate::astral::{
    AstralClient, AstralHttpRequest, AstralHttpResponse, AstralHttpTransport,
    AstralProxyPutRequest, AstralUploadRequest,
};
use crate::credential_store::tests::{stored, test_db, FakeCredentialStore};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

const SESSION_TTL: i64 = 7200;

enum FakeReply {
    Ready(Result<AstralHttpResponse, String>),
    Deferred(tokio::sync::oneshot::Receiver<Result<AstralHttpResponse, String>>),
}

#[derive(Default)]
struct FakeHttp {
    replies: Mutex<VecDeque<FakeReply>>,
    requests: Mutex<Vec<AstralHttpRequest>>,
    uploads: Mutex<Vec<AstralUploadRequest>>,
    upload_replies: Mutex<VecDeque<tokio::sync::oneshot::Receiver<Result<(), String>>>>,
    proxy_puts: Mutex<Vec<AstralProxyPutRequest>>,
    proxy_replies: Mutex<VecDeque<FakeReply>>,
    sent: tokio::sync::Notify,
}

impl FakeHttp {
    fn reply(&self, status: u16, data: Value) {
        self.replies
            .lock()
            .unwrap()
            .push_back(FakeReply::Ready(Ok(AstralHttpResponse {
                status,
                body: json!({ "code": status, "data": data }).to_string(),
            })));
    }

    fn fail(&self, message: &str) {
        self.replies
            .lock()
            .unwrap()
            .push_back(FakeReply::Ready(Err(message.to_owned())));
    }

    fn defer(&self) -> tokio::sync::oneshot::Sender<Result<AstralHttpResponse, String>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.replies
            .lock()
            .unwrap()
            .push_back(FakeReply::Deferred(receiver));
        sender
    }

    fn defer_upload(&self) -> tokio::sync::oneshot::Sender<Result<(), String>> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.upload_replies.lock().unwrap().push_back(receiver);
        sender
    }

    fn proxy_reply(&self, status: u16, data: Value) {
        self.proxy_replies
            .lock()
            .unwrap()
            .push_back(FakeReply::Ready(Ok(AstralHttpResponse {
                status,
                body: json!({ "code": 200, "data": data }).to_string(),
            })));
    }

    async fn wait_for_uploads(&self, count: usize) {
        loop {
            if self.uploads.lock().unwrap().len() >= count {
                return;
            }
            self.sent.notified().await;
        }
    }

    async fn wait_for_requests(&self, count: usize) {
        loop {
            let received = self.requests.lock().unwrap().len();
            if received >= count {
                return;
            }
            self.sent.notified().await;
        }
    }
}

impl AstralHttpTransport for FakeHttp {
    fn upload(
        &self,
        request: AstralUploadRequest,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        self.uploads.lock().unwrap().push(request);
        self.sent.notify_one();
        let reply = self.upload_replies.lock().unwrap().pop_front();
        Box::pin(async move {
            match reply {
                Some(receiver) => receiver
                    .await
                    .map_err(|_| "synthetic upload cancelled".to_owned())?,
                None => Ok(()),
            }
        })
    }

    fn send(
        &self,
        request: AstralHttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AstralHttpResponse, String>> + Send + '_>> {
        self.requests.lock().unwrap().push(request);
        self.sent.notify_one();
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected native HTTP request: no fake reply");
        Box::pin(async move {
            match reply {
                FakeReply::Ready(reply) => reply,
                FakeReply::Deferred(receiver) => receiver
                    .await
                    .map_err(|_| "synthetic HTTP reply cancelled".to_owned())?,
            }
        })
    }

    fn proxy_put(
        &self,
        request: AstralProxyPutRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AstralHttpResponse, String>> + Send + '_>> {
        self.proxy_puts.lock().unwrap().push(request);
        self.sent.notify_one();
        let reply = self
            .proxy_replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected proxy content PUT: no fake reply");
        Box::pin(async move {
            match reply {
                FakeReply::Ready(reply) => reply,
                FakeReply::Deferred(receiver) => receiver
                    .await
                    .map_err(|_| "synthetic proxy reply cancelled".to_owned())?,
            }
        })
    }
}

fn client_with_fakes() -> (
    AstralClient,
    Arc<crate::db::Database>,
    Arc<FakeCredentialStore>,
    Arc<FakeHttp>,
) {
    client_with_fakes_at("https://backend.audit.invalid")
}

fn client_with_fakes_at(base_url: &str) -> (
    AstralClient,
    Arc<crate::db::Database>,
    Arc<FakeCredentialStore>,
    Arc<FakeHttp>,
) {
    let db = test_db();
    let store = Arc::new(FakeCredentialStore::default());
    let http = Arc::new(FakeHttp::default());
    let client = AstralClient::new_with_transport_and_metadata(
        base_url,
        http.clone(),
        crate::astral::ClientMetadata {
            device: "synthetic-owned-device".into(),
            os: "Synthetic Test OS 1.0".into(),
        },
    );
    client.set_session_store(
        Some(db.clone()),
        std::path::Path::new("synthetic-native-root"),
        store.clone(),
    );
    (client, db, store, http)
}

#[tokio::test]
async fn captured_cover_clear_invalidates_owned_cached_cover() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "COVER_CLEAR_ACCOUNT_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "cover-clear-owner" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "cover-clear-owner", || {
            db.with(|conn| {
                crate::db::store::set_setting(conn, "like.sync.owner", "cover-clear-owner")
            })
        })
        .unwrap();
    let pid = "native-captured-clear";
    db.with(|conn| {
        crate::db::store::add_liked_playlist(
            conn,
            "local",
            pid,
            "Synthetic cached cover",
            Some("https://cdn.audit.invalid/old-cover.png"),
            "0",
        )
    })
    .unwrap();
    let permit = client
        .with_session_epoch(epoch, || {
            db.with(|conn| crate::playlist_cloud::capture_playlist_permit(conn, "local", pid))
        })
        .unwrap();
    http.reply(200, Value::Null);
    crate::commands::astral_clear_playlist_cover_captured(
        Arc::new(client),
        db.clone(),
        epoch,
        String::from(pid),
        String::from("local"),
        permit,
    )
    .await
    .expect("the registered tail's actual cloud clear must succeed");
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        3,
        "actual login, identity verification and one cloud clear"
    );
    assert_eq!(requests[2].method, reqwest::Method::DELETE);
    assert!(requests[2]
        .url
        .ends_with("app/user/like/playlist/native-captured-clear/cover"));
    assert_eq!(
        requests[2].query,
        vec![(String::from("platform"), String::from("local"))]
    );
    drop(requests);
    let cards = db.with(crate::db::store::list_liked_playlists).unwrap();
    let card = cards
        .into_iter()
        .find(|card| card.platform == "local" && card.id == pid)
        .expect("the same owned favorite must remain after the actual cloud clear");
    assert_eq!(
        card.pic_url, "",
        "the registered clear tail must invalidate the owned cached remote cover"
    );
}

#[tokio::test]
async fn captured_cover_clear_reports_partial_success_when_cache_write_fails() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "COVER_CACHE_FAILURE_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "cover-cache-owner" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "cover-cache-owner", || {
            db.with(|conn| {
                crate::db::store::set_setting(conn, "like.sync.owner", "cover-cache-owner")
            })
        })
        .unwrap();
    let pid = "native-clear-cache-failure";
    let old_cover = "https://cdn.audit.invalid/retained-cover.png";
    db.with(|conn| {
        crate::db::store::add_liked_playlist(
            conn,
            "local",
            pid,
            "Synthetic cache failure",
            Some(old_cover),
            "0",
        )
    })
    .unwrap();
    let permit = client
        .with_session_epoch(epoch, || {
            db.with(|conn| crate::playlist_cloud::capture_playlist_permit(conn, "local", pid))
        })
        .unwrap();
    db.with(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER reject_cover_cache_write BEFORE UPDATE OF pic_url ON liked_playlists
         BEGIN SELECT RAISE(ABORT, 'synthetic cache write denied'); END;",
        )
    })
    .unwrap();
    http.reply(200, Value::Null);
    let error = crate::commands::astral_clear_playlist_cover_captured(
        Arc::new(client),
        db.clone(),
        epoch,
        String::from(pid),
        String::from("local"),
        permit,
    )
    .await
    .expect_err("actual cloud success and cache failure must report partial success");
    assert!(
        error.starts_with("云封面已清除，但本地缓存更新失败: "),
        "wrong error classification: {error}"
    );
    assert!(error.contains("synthetic cache write denied"));
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        3,
        "cloud success must not be retried as cloud failure"
    );
    assert_eq!(requests[2].method, reqwest::Method::DELETE);
    drop(requests);
    let cards = db.with(crate::db::store::list_liked_playlists).unwrap();
    assert_eq!(
        cards
            .into_iter()
            .find(|card| card.platform == "local" && card.id == pid)
            .unwrap()
            .pic_url,
        old_cover
    );
}

#[tokio::test]
async fn captured_cover_clear_preserves_cached_cover_on_cloud_failure() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "COVER_CLOUD_FAILURE_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "cover-cloud-owner" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "cover-cloud-owner", || {
            db.with(|conn| {
                crate::db::store::set_setting(conn, "like.sync.owner", "cover-cloud-owner")
            })
        })
        .unwrap();
    let pid = "native-cloud-clear-failure";
    let old_cover = "https://cdn.audit.invalid/cloud-failed-cover.png";
    db.with(|conn| {
        crate::db::store::add_liked_playlist(
            conn,
            "local",
            pid,
            "Synthetic cloud failure",
            Some(old_cover),
            "0",
        )
    })
    .unwrap();
    let permit = client
        .with_session_epoch(epoch, || {
            db.with(|conn| crate::playlist_cloud::capture_playlist_permit(conn, "local", pid))
        })
        .unwrap();
    http.reply(500, Value::Null);
    let error = crate::commands::astral_clear_playlist_cover_captured(
        Arc::new(client),
        db.clone(),
        epoch,
        String::from(pid),
        String::from("local"),
        permit,
    )
    .await
    .expect_err("actual cloud failure must fail the registered clear tail");
    assert!(
        !error.starts_with("云封面已清除，但本地缓存更新失败: "),
        "cloud failure was mislabeled: {error}"
    );
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        3,
        "one actual cloud attempt, without a cache-failure retry"
    );
    assert_eq!(requests[2].method, reqwest::Method::DELETE);
    drop(requests);
    let cards = db.with(crate::db::store::list_liked_playlists).unwrap();
    assert_eq!(
        cards
            .into_iter()
            .find(|card| card.platform == "local" && card.id == pid)
            .unwrap()
            .pic_url,
        old_cover
    );
}

#[tokio::test]
async fn captured_cover_clear_cannot_invalidate_next_accounts_cover() {
    let (client, db, _store, http) = client_with_fakes();
    let client = Arc::new(client);
    http.reply(
        200,
        json!({ "token": "COVER_ACCOUNT_A_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-a", "synthetic-password")
        .await
        .unwrap();
    let epoch_a = client.session_epoch();
    http.reply(200, json!({ "id": "cover-owner-a" }));
    client.me_for_epoch(epoch_a).await.unwrap();
    let pid = "native-clear-account-race";
    client
        .with_like_owner_commit(epoch_a, "cover-owner-a", || {
            db.with(|conn| {
                crate::db::store::set_setting(conn, "like.sync.owner", "cover-owner-a")?;
                crate::db::store::add_liked_playlist(
                    conn,
                    "local",
                    pid,
                    "Account A cover",
                    Some("https://cdn.audit.invalid/a-cover.png"),
                    "0",
                )
                .map(|_| ())
            })
        })
        .unwrap();
    let permit = client
        .with_session_epoch(epoch_a, || {
            db.with(|conn| crate::playlist_cloud::capture_playlist_permit(conn, "local", pid))
        })
        .unwrap();
    let delayed_clear = http.defer();
    let clear_client = client.clone();
    let clear_db = db.clone();
    let clear = tokio::spawn(async move {
        crate::commands::astral_clear_playlist_cover_captured(
            clear_client,
            clear_db,
            epoch_a,
            String::from(pid),
            String::from("local"),
            permit,
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), http.wait_for_requests(3))
        .await
        .unwrap();

    http.reply(
        200,
        json!({ "token": "COVER_ACCOUNT_B_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-b", "synthetic-password")
        .await
        .unwrap();
    let epoch_b = client.session_epoch();
    assert_ne!(epoch_a, epoch_b);
    http.reply(200, json!({ "id": "cover-owner-b" }));
    client.me_for_epoch(epoch_b).await.unwrap();
    let b_cover = "https://cdn.audit.invalid/b-cover.png";
    client
        .with_like_owner_commit(epoch_b, "cover-owner-b", || {
            db.with(|conn| {
                crate::db::store::set_setting(conn, "like.sync.owner", "cover-owner-b")?;
                crate::db::store::add_liked_playlist(
                    conn,
                    "local",
                    pid,
                    "Account B cover",
                    Some(b_cover),
                    "0",
                )?;
                crate::db::store::set_liked_playlist_pic(conn, "local", pid, b_cover).map(|_| ())
            })
        })
        .unwrap();
    assert!(delayed_clear
        .send(Ok(AstralHttpResponse {
            status: 200,
            body: String::from("{\"code\":200,\"data\":null}"),
        }))
        .is_ok());
    tokio::time::timeout(std::time::Duration::from_secs(2), clear)
        .await
        .unwrap()
        .unwrap()
        .expect_err("A's actual cloud response cannot commit into the new B session");
    assert_eq!(client.session_epoch(), epoch_b);
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 5, "A login/me/clear and B login/me only");
    assert_eq!(requests[2].method, reqwest::Method::DELETE);
    drop(requests);
    let cards = db.with(crate::db::store::list_liked_playlists).unwrap();
    assert_eq!(
        cards
            .into_iter()
            .find(|card| card.platform == "local" && card.id == pid)
            .unwrap()
            .pic_url,
        b_cover
    );
}

#[tokio::test]
async fn captured_cover_clear_keeps_smart_denial_after_local_row_is_deleted() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "COVER_SMART_ACCOUNT_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "cover-smart-owner" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "cover-smart-owner", || {
            db.with(|conn| {
                crate::db::store::set_setting(conn, "like.sync.owner", "cover-smart-owner")
            })
        })
        .unwrap();
    let pid = db
        .with(|conn| {
            crate::smart_playlist::create_smart_playlist(
                conn,
                "Captured smart cover",
                &crate::smart_playlist::SmartRules::default(),
                None,
                "added_desc",
            )
        })
        .unwrap();
    let old_cover = "https://cdn.audit.invalid/smart-cover.png";
    db.with(|conn| {
        crate::db::store::add_liked_playlist(
            conn,
            "local",
            &pid,
            "Synthetic smart favorite",
            Some(old_cover),
            "0",
        )
    })
    .unwrap();
    let permit = client
        .with_session_epoch(epoch, || {
            db.with(|conn| crate::playlist_cloud::capture_playlist_permit(conn, "local", &pid))
        })
        .unwrap();
    db.with(|conn| conn.execute("DELETE FROM playlists WHERE pid = ?1", [&pid]))
        .unwrap();
    http.reply(200, Value::Null);
    let error = crate::commands::astral_clear_playlist_cover_captured(
        Arc::new(client),
        db.clone(),
        epoch,
        pid.clone(),
        String::from("local"),
        permit,
    )
    .await
    .expect_err("the original captured smart denial must not be looked up again");
    assert_eq!(error, "智能歌单只保存在本机，不支持云端封面");
    assert_eq!(
        http.requests.lock().unwrap().len(),
        2,
        "denied clear must not dispatch a cloud request"
    );
    let cards = db.with(crate::db::store::list_liked_playlists).unwrap();
    assert_eq!(
        cards
            .into_iter()
            .find(|card| card.platform == "local" && card.id == pid)
            .unwrap()
            .pic_url,
        old_cover
    );
}

#[tokio::test]
async fn initial_login_persists_secure_reference_before_reporting_session() {
    let (client, db, store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "LOGIN_TOKEN_CANARY", "expiresIn": SESSION_TTL }),
    );
    let session = client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    assert_eq!(client.token().as_deref(), Some("LOGIN_TOKEN_CANARY"));
    assert!(!format!("{session:?}").contains("LOGIN_TOKEN_CANARY"));
    // This return value is consumed directly by native auth commands: it must
    // already be the tokenless IPC projection, not a later read of global state.
    assert_eq!(
        serde_json::to_value(session).unwrap(),
        json!({
            "expiresAt": session.expires_at, "persistence": "secure"
        }),
        "initial authentication must return only its own safe session status"
    );
    let saved = stored(&db);
    let metadata: Value = serde_json::from_str(&saved)
        .expect("initial login must persist a secure reference through the native vault");
    assert_eq!(metadata["version"], 1);
    assert_eq!(metadata["expiresAt"], session.expires_at);
    assert!(session.expires_at > crate::astral::now_ms() + 7_000_000);
    assert!(!saved.contains("LOGIN_TOKEN_CANARY"));
    assert_eq!(
        store
            .secrets
            .lock()
            .unwrap()
            .get(metadata["credentialTarget"].as_str().unwrap())
            .map(String::as_str),
        Some("LOGIN_TOKEN_CANARY")
    );
    assert_eq!(
        serde_json::to_value(client.session_status().unwrap()).unwrap(),
        json!({ "expiresAt": session.expires_at, "persistence": "secure" })
    );
    assert!(http.requests.lock().unwrap()[0].satoken.is_none());
}

#[tokio::test]
async fn restored_native_session_requires_fresh_identity_and_owner_commit() {
    let (client, db, store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "RESTORED_NATIVE_CANARY", "expiresIn": SESSION_TTL }),
    );
    let initial = client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "restored-owner"))
        .unwrap();
    let fresh_http = Arc::new(FakeHttp::default());
    let restarted = AstralClient::new_with_transport_and_metadata(
        "https://backend.audit.invalid",
        fresh_http.clone(),
        crate::astral::ClientMetadata {
            device: "synthetic-owned-device".into(),
            os: "Synthetic Test OS 1.0".into(),
        },
    );
    restarted.set_session_store(
        Some(db.clone()),
        std::path::Path::new("synthetic-native-root"),
        store,
    );
    let restored = restarted.restore_session().await.unwrap().unwrap();
    assert_eq!(restored, initial);
    assert_eq!(restarted.token().as_deref(), Some("RESTORED_NATIVE_CANARY"));
    assert!(!serde_json::to_string(&restored)
        .unwrap()
        .contains("RESTORED_NATIVE_CANARY"));
    let epoch = restarted.session_epoch();
    assert!(restarted
        .like_playlist_for_epoch(epoch, "add", "pid", "synthetic", "Playlist", None)
        .await
        .is_err());
    assert!(fresh_http.requests.lock().unwrap().is_empty());
    fresh_http.reply(200, json!({ "id": "restored-owner" }));
    restarted.me_for_epoch(epoch).await.unwrap();
    assert!(restarted
        .like_playlist_for_epoch(epoch, "add", "pid", "synthetic", "Playlist", None)
        .await
        .is_err());
    assert_eq!(fresh_http.requests.lock().unwrap().len(), 1);
    restarted
        .with_like_owner_commit(epoch, "restored-owner", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "restored-owner"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    fresh_http.reply(200, json!({ "seq": 17 }));
    assert_eq!(
        restarted
            .like_playlist_for_epoch(epoch, "add", "pid", "synthetic", "Playlist", None)
            .await
            .unwrap(),
        17
    );
    assert_eq!(
        fresh_http.requests.lock().unwrap()[1].satoken.as_deref(),
        Some("RESTORED_NATIVE_CANARY")
    );
}

#[tokio::test]
async fn renewal_io_failure_preserves_the_original_secure_session() {
    let (client, db, store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "RENEW_IO_ORIGINAL_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "io-owner" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "io-owner", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "io-owner"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let saved = stored(&db);
    let secrets = store.secrets.lock().unwrap().clone();
    *store.error.lock().unwrap() = Some(crate::credential_store::CredentialError::Failed);
    http.reply(
        200,
        json!({ "token": "RENEW_IO_NEW_CANARY", "expiresIn": SESSION_TTL }),
    );
    assert!(client.refresh_for_epoch(epoch).await.is_err());
    assert_eq!(client.session_epoch(), epoch);
    assert_eq!(client.token().as_deref(), Some("RENEW_IO_ORIGINAL_CANARY"));
    assert_eq!(stored(&db), saved);
    assert_eq!(*store.secrets.lock().unwrap(), secrets);
    assert!(!stored(&db).contains("RENEW_IO_ORIGINAL_CANARY"));
    assert!(!stored(&db).contains("RENEW_IO_NEW_CANARY"));
    client.with_like_session_epoch(epoch, || Ok(())).unwrap();
}

fn synthetic_song() -> crate::astral::LikeSongPayload<'static> {
    crate::astral::LikeSongPayload {
        action: "add",
        sid: "song-canary",
        platform: "synthetic",
        name: "Song",
        singer: "Singer",
        album: "Album",
        hash: None,
        pid: None,
        pic_url: None,
    }
}

#[tokio::test]
async fn unverified_native_session_cannot_dispatch_any_like_operation() {
    let (client, _db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "UNVERIFIED_TOKEN_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    let before = http.requests.lock().unwrap().len();
    for _ in 0..13 {
        http.reply(200, json!({
            "seq": 17, "changes": [], "maxSeq": 17, "songs": [], "playlists": [],
            "uploadUrl": "https://storage.audit.invalid/synthetic", "url": "https://storage.audit.invalid/synthetic",
        }));
    }
    let outcomes = [
        (
            "playlist",
            client
                .like_playlist("add", "pid", "synthetic", "Playlist", None)
                .await
                .is_err(),
        ),
        ("changes", client.like_changes(0).await.is_err()),
        ("list", client.like_list(1, 100).await.is_err()),
        ("song", client.like_song(synthetic_song()).await.is_err()),
        ("batch", client.like_batch(vec![]).await.is_err()),
        (
            "bound playlist",
            client
                .like_playlist_for_epoch(epoch, "add", "pid", "synthetic", "Playlist", None)
                .await
                .is_err(),
        ),
        (
            "bound changes",
            client.like_changes_for_epoch(epoch, 0).await.is_err(),
        ),
        (
            "bound list",
            client.like_list_for_epoch(epoch, 1, 100).await.is_err(),
        ),
        (
            "bound song",
            client
                .like_song_for_epoch(epoch, synthetic_song())
                .await
                .is_err(),
        ),
        (
            "bound batch",
            client.like_batch_for_epoch(epoch, vec![]).await.is_err(),
        ),
        (
            "cover ticket",
            client
                .cover_ticket("pid", "synthetic", "synthetic.png", "image/png", 1)
                .await
                .is_err(),
        ),
        (
            "cover complete",
            client
                .cover_complete("pid", "synthetic", "upload-canary")
                .await
                .is_err(),
        ),
        (
            "cover clear",
            client.cover_clear("pid", "synthetic").await.is_err(),
        ),
    ];
    let packets = http.requests.lock().unwrap().len() - before;
    assert!(
        outcomes.iter().all(|(_, denied)| *denied) && packets == 0,
        "unverified native session dispatched {packets} like packets; API denials: {outcomes:?}"
    );
}

#[tokio::test]
async fn verified_native_owner_can_sync_after_the_real_owner_commit() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "VERIFIED_OWNER_TOKEN_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "user": { "id": "verified-owner" } }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "verified-owner", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "verified-owner"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let before = http.requests.lock().unwrap().len();
    http.reply(200, json!({ "seq": 17 }));
    assert_eq!(
        client
            .like_playlist_for_epoch(epoch, "add", "pid", "synthetic", "Playlist", None)
            .await
            .unwrap(),
        17
    );
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), before + 1);
    assert_eq!(
        requests.last().unwrap().satoken.as_deref(),
        Some("VERIFIED_OWNER_TOKEN_CANARY")
    );
}

#[tokio::test]
async fn actual_database_owner_mismatch_blocks_packets_and_local_commit() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "OWNER_CHECK_TOKEN_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "owner-a" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "owner-a", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-a"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    // Model a legacy/imported DB row outside the ready helper, not a private
    // state mutation: native dispatch must re-read its real persistent owner.
    db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-b"))
        .unwrap();
    let before = http.requests.lock().unwrap().len();
    for _ in 0..13 {
        http.reply(200, json!({ "seq": 17, "changes": [], "maxSeq": 17, "songs": [], "playlists": [], "uploadUrl": "https://storage.audit.invalid/synthetic", "url": "https://storage.audit.invalid/synthetic" }));
    }
    let outcomes = [
        client
            .like_playlist("add", "pid", "synthetic", "Playlist", None)
            .await
            .is_err(),
        client.like_changes(0).await.is_err(),
        client.like_list(1, 100).await.is_err(),
        client.like_song(synthetic_song()).await.is_err(),
        client.like_batch(vec![]).await.is_err(),
        client
            .like_playlist_for_epoch(epoch, "add", "pid", "synthetic", "Playlist", None)
            .await
            .is_err(),
        client.like_changes_for_epoch(epoch, 0).await.is_err(),
        client.like_list_for_epoch(epoch, 1, 100).await.is_err(),
        client
            .like_song_for_epoch(epoch, synthetic_song())
            .await
            .is_err(),
        client.like_batch_for_epoch(epoch, vec![]).await.is_err(),
        client
            .cover_ticket("pid", "synthetic", "synthetic.png", "image/png", 1)
            .await
            .is_err(),
        client
            .cover_complete("pid", "synthetic", "upload-canary")
            .await
            .is_err(),
        client.cover_clear("pid", "synthetic").await.is_err(),
    ];
    let mut commit_ran = false;
    let commit_denied = client
        .with_like_session_epoch(epoch, || {
            commit_ran = true;
            Ok(())
        })
        .is_err();
    let packets = http.requests.lock().unwrap().len() - before;
    assert!(outcomes.iter().all(|denied| *denied) && packets == 0 && commit_denied && !commit_ran,
        "mismatched DB owner: {packets} packets, denials={outcomes:?}, commit_denied={commit_denied}, commit_ran={commit_ran}");
}

#[tokio::test]
async fn owner_invalidation_revokes_sync_even_when_the_database_owner_is_unchanged() {
    for operation_fails in [false, true] {
        let (client, db, _store, http) = client_with_fakes();
        http.reply(
            200,
            json!({ "token": "INVALIDATION_TOKEN_CANARY", "expiresIn": SESSION_TTL }),
        );
        client
            .login("synthetic-account", "synthetic-password")
            .await
            .unwrap();
        let epoch = client.session_epoch();
        http.reply(200, json!({ "id": "owner-a" }));
        client.me_for_epoch(epoch).await.unwrap();
        client
            .with_like_owner_commit(epoch, "owner-a", || {
                db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-a"))
                    .map_err(|_| "synthetic owner commit failed".to_owned())
            })
            .unwrap();
        let operation = client.with_like_owner_invalidated(epoch, || {
            if operation_fails {
                Err("synthetic import failure".to_owned())
            } else {
                Ok(())
            }
        });
        assert_eq!(operation.is_err(), operation_fails);
        let before = http.requests.lock().unwrap().len();
        http.reply(200, json!({ "seq": 17 }));
        let denied = client
            .like_playlist("add", "pid", "synthetic", "Playlist", None)
            .await
            .is_err();
        let mut commit_ran = false;
        let commit_denied = client
            .with_like_session_epoch(epoch, || {
                commit_ran = true;
                Ok(())
            })
            .is_err();
        assert!(denied && http.requests.lock().unwrap().len() == before && commit_denied && !commit_ran,
            "owner invalidation must revoke readiness even after operation failure={operation_fails}");
    }
}

#[tokio::test]
async fn revoked_owner_cannot_accept_an_inflight_like_response() {
    let (client, db, _store, http) = client_with_fakes();
    let client = Arc::new(client);
    http.reply(
        200,
        json!({ "token": "INFLIGHT_OWNER_TOKEN_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "owner-a" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "owner-a", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-a"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let before = http.requests.lock().unwrap().len();
    let release = http.defer();
    let worker = client.clone();
    let pending = tokio::spawn(async move {
        worker
            .like_playlist("add", "pid", "synthetic", "Playlist", None)
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        http.wait_for_requests(before + 1),
    )
    .await
    .expect("fake adapter must observe the in-flight request");
    client
        .with_like_owner_invalidated(epoch, || Ok(()))
        .unwrap();
    assert!(release
        .send(Ok(AstralHttpResponse {
            status: 200,
            body: json!({ "code": 200, "data": { "seq": 17 } }).to_string()
        }))
        .is_ok());
    let result = pending.await.unwrap();
    assert!(
        result.is_err(),
        "revoked owner accepted stale in-flight seq: {result:?}"
    );
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), before + 1);
    assert_eq!(
        requests.last().unwrap().satoken.as_deref(),
        Some("INFLIGHT_OWNER_TOKEN_CANARY")
    );
}

#[tokio::test]
async fn inflight_old_owner_reply_cannot_be_accepted_by_a_ready_new_owner() {
    let (client, db, _store, http) = client_with_fakes();
    let client = Arc::new(client);
    http.reply(
        200,
        json!({ "token": "OLD_OWNER_A_TOKEN_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-a", "synthetic-password")
        .await
        .unwrap();
    let epoch_a = client.session_epoch();
    http.reply(200, json!({ "id": "owner-a" }));
    client.me_for_epoch(epoch_a).await.unwrap();
    client
        .with_like_owner_commit(epoch_a, "owner-a", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-a"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let before = http.requests.lock().unwrap().len();
    let release = http.defer();
    let worker = client.clone();
    let pending = tokio::spawn(async move {
        worker
            .like_playlist("add", "pid-a", "synthetic", "Playlist A", None)
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        http.wait_for_requests(before + 1),
    )
    .await
    .expect("fake adapter must observe A's request");
    http.reply(
        200,
        json!({ "token": "NEW_OWNER_B_TOKEN_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-b", "synthetic-password")
        .await
        .unwrap();
    let epoch_b = client.session_epoch();
    http.reply(200, json!({ "uid": "owner-b" }));
    client.me_for_epoch(epoch_b).await.unwrap();
    client
        .with_like_owner_commit(epoch_b, "owner-b", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-b"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    assert!(release
        .send(Ok(AstralHttpResponse {
            status: 200,
            body: json!({ "code": 200, "data": { "seq": 17 } }).to_string()
        }))
        .is_ok());
    let result = pending.await.unwrap();
    assert!(
        result.is_err(),
        "ready B accepted A's late cloud sequence: {result:?}"
    );
    assert_eq!(client.token().as_deref(), Some("NEW_OWNER_B_TOKEN_CANARY"));
    client.with_like_session_epoch(epoch_b, || Ok(())).unwrap();
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), before + 3);
    assert_eq!(
        requests[before].satoken.as_deref(),
        Some("OLD_OWNER_A_TOKEN_CANARY")
    );
}

#[tokio::test]
async fn stale_epoch_like_calls_never_dispatch_with_the_new_account_token() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "STALE_EPOCH_A_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-a", "synthetic-password")
        .await
        .unwrap();
    let epoch_a = client.session_epoch();
    http.reply(
        200,
        json!({ "token": "CURRENT_EPOCH_B_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-b", "synthetic-password")
        .await
        .unwrap();
    let epoch_b = client.session_epoch();
    http.reply(200, json!({ "user": { "uid": "owner-b" } }));
    client.me_for_epoch(epoch_b).await.unwrap();
    client
        .with_like_owner_commit(epoch_b, "owner-b", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-b"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let before = http.requests.lock().unwrap().len();
    for _ in 0..5 {
        http.reply(200, json!({ "seq": 17, "changes": [], "maxSeq": 17 }));
    }
    let denied = [
        client
            .like_playlist_for_epoch(epoch_a, "add", "pid-a", "synthetic", "Playlist A", None)
            .await
            .is_err(),
        client.like_changes_for_epoch(epoch_a, 0).await.is_err(),
        client.like_list_for_epoch(epoch_a, 1, 100).await.is_err(),
        client
            .like_song_for_epoch(epoch_a, synthetic_song())
            .await
            .is_err(),
        client.like_batch_for_epoch(epoch_a, vec![]).await.is_err(),
    ];
    let packets = http.requests.lock().unwrap().len() - before;
    assert!(
        denied.iter().all(|denied| *denied) && packets == 0,
        "stale epoch dispatched {packets} packets with the current account: {denied:?}"
    );
    assert_eq!(client.token().as_deref(), Some("CURRENT_EPOCH_B_CANARY"));
    client.with_like_session_epoch(epoch_b, || Ok(())).unwrap();
}

#[tokio::test]
async fn refresh_rotates_the_secure_reference_without_changing_the_owner_epoch() {
    let (client, db, store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "REFRESH_ORIGINAL_TOKEN_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "owner-a" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "owner-a", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-a"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let old_metadata: Value = serde_json::from_str(&stored(&db)).unwrap();
    let old_target = old_metadata["credentialTarget"]
        .as_str()
        .unwrap()
        .to_owned();
    http.reply(
        200,
        json!({ "token": "REFRESH_RENEWED_TOKEN_CANARY", "expiresIn": 9000 }),
    );
    let session = client.refresh().await.unwrap();
    assert_eq!(
        client.session_epoch(),
        epoch,
        "token renewal must not replace the owner epoch"
    );
    assert_eq!(
        serde_json::to_value(session).unwrap(),
        json!({ "expiresAt": session.expires_at, "persistence": "secure" })
    );
    assert_eq!(
        client.token().as_deref(),
        Some("REFRESH_RENEWED_TOKEN_CANARY")
    );
    client.with_like_session_epoch(epoch, || Ok(())).unwrap();
    let saved = stored(&db);
    let metadata: Value = serde_json::from_str(&saved).unwrap();
    let target = metadata["credentialTarget"].as_str().unwrap();
    assert_ne!(target, old_target);
    assert_eq!(metadata["expiresAt"], session.expires_at);
    assert!(
        !saved.contains("REFRESH_ORIGINAL_TOKEN_CANARY")
            && !saved.contains("REFRESH_RENEWED_TOKEN_CANARY")
    );
    let secrets = store.secrets.lock().unwrap();
    assert_eq!(
        secrets.get(target).map(String::as_str),
        Some("REFRESH_RENEWED_TOKEN_CANARY")
    );
    assert!(!secrets.contains_key(&old_target));
    assert_eq!(
        http.requests
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .satoken
            .as_deref(),
        Some("REFRESH_ORIGINAL_TOKEN_CANARY")
    );
}

#[tokio::test]
async fn epoch_bound_like_401_refreshes_securely_then_retries_for_the_same_owner() {
    let (client, db, store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "AUTO_REFRESH_OLD_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "owner-a" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "owner-a", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-a"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let before = http.requests.lock().unwrap().len();
    http.reply(401, Value::Null);
    http.reply(
        200,
        json!({ "token": "AUTO_REFRESH_NEW_CANARY", "expiresIn": 9000 }),
    );
    http.reply(200, json!({ "seq": 17 }));
    let result = client
        .like_playlist_for_epoch(epoch, "add", "pid", "synthetic", "Playlist", None)
        .await;
    assert_eq!(
        result.unwrap(),
        17,
        "401 must refresh and retry the epoch-bound native API"
    );
    assert_eq!(client.session_epoch(), epoch);
    client.with_like_session_epoch(epoch, || Ok(())).unwrap();
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), before + 3);
    assert_eq!(
        requests[before].satoken.as_deref(),
        Some("AUTO_REFRESH_OLD_CANARY")
    );
    assert!(requests[before + 1].url.ends_with("/app/user/refresh"));
    assert_eq!(
        requests[before + 1].satoken.as_deref(),
        Some("AUTO_REFRESH_OLD_CANARY")
    );
    assert_eq!(
        requests[before + 2].satoken.as_deref(),
        Some("AUTO_REFRESH_NEW_CANARY")
    );
    let saved = stored(&db);
    assert!(
        !saved.contains("AUTO_REFRESH_OLD_CANARY") && !saved.contains("AUTO_REFRESH_NEW_CANARY")
    );
    let metadata: Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(
        store
            .secrets
            .lock()
            .unwrap()
            .get(metadata["credentialTarget"].as_str().unwrap())
            .map(String::as_str),
        Some("AUTO_REFRESH_NEW_CANARY")
    );
}

#[tokio::test]
async fn late_me_401_cannot_revoke_the_same_epoch_renewed_session() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "ME_REVISION_OLD_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(200, json!({ "id": "owner-a" }));
    client.me_for_epoch(epoch).await.unwrap();
    client
        .with_like_owner_commit(epoch, "owner-a", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-a"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let before = http.requests.lock().unwrap().len();
    let late_response = http.defer();
    let client = Arc::new(client);
    let request_client = client.clone();
    let old_me = tokio::spawn(async move { request_client.me_for_epoch(epoch).await });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        http.wait_for_requests(before + 1),
    )
    .await
    .unwrap();
    http.reply(
        200,
        json!({ "token": "ME_REVISION_NEW_CANARY", "expiresIn": 9000 }),
    );
    client.refresh_for_epoch(epoch).await.unwrap();
    let saved = stored(&db);
    http.fail("synthetic unexpected retry of superseded me");
    assert!(late_response
        .send(Ok(AstralHttpResponse {
            status: 401,
            body: json!({ "code": 401 }).to_string()
        }))
        .is_ok());
    assert!(old_me.await.unwrap().is_err());
    assert!(
        client.with_like_session_epoch(epoch, || Ok(())).is_ok(),
        "late old-token /me rejection revoked the renewed owner's readiness"
    );
    assert_eq!(client.token().as_deref(), Some("ME_REVISION_NEW_CANARY"));
    assert_eq!(stored(&db), saved);
    assert_eq!(
        http.requests.lock().unwrap().len(),
        before + 2,
        "old /me must not dispatch a new request with the renewed token"
    );
}

#[tokio::test]
async fn me_final_auth_rejection_revokes_only_its_final_secure_revision() {
    let (client, db, store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "ME_FINAL_REJECT_OLD_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    http.reply(401, json!({}));
    http.reply(
        200,
        json!({ "token": "ME_FINAL_REJECT_NEW_CANARY", "expiresIn": SESSION_TTL }),
    );
    http.reply(401, json!({}));
    assert!(client.me_for_epoch(epoch).await.is_err());
    assert!(
        client.token().is_none(),
        "final /me auth rejection left its renewed native revision active"
    );
    assert!(db
        .with(|conn| crate::db::store::get_setting(conn, crate::astral::SETTING_ASTRAL_SESSION))
        .unwrap()
        .is_none());
    assert!(store.secrets.lock().unwrap().is_empty());
    assert!(client.with_session_epoch(epoch, || Ok(())).is_err());
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        requests[1].satoken.as_deref(),
        Some("ME_FINAL_REJECT_OLD_CANARY")
    );
    assert_eq!(
        requests[2].satoken.as_deref(),
        Some("ME_FINAL_REJECT_OLD_CANARY")
    );
    assert_eq!(
        requests[3].satoken.as_deref(),
        Some("ME_FINAL_REJECT_NEW_CANARY")
    );
}

#[tokio::test]
async fn explicit_refresh_rejection_revokes_the_original_persisted_session() {
    let (client, db, store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "REJECTED_REFRESH_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    let metadata: Value = serde_json::from_str(&stored(&db)).unwrap();
    let target = metadata["credentialTarget"].as_str().unwrap().to_owned();
    http.reply(401, Value::Null);
    assert!(client.refresh_for_epoch(epoch).await.is_err());
    assert!(
        client.token().is_none(),
        "explicit refresh rejection left the rejected native token active"
    );
    assert_eq!(
        db.with(|conn| crate::db::store::get_setting(conn, "astral.session"))
            .unwrap(),
        None
    );
    assert!(
        !store.secrets.lock().unwrap().contains_key(&target),
        "rejected refresh left its credential restorable"
    );
}

#[tokio::test]
async fn logout_revokes_locally_before_remote_reply_and_never_clears_a_new_owner() {
    for remote_status in [200, 401] {
        let (client, db, store, http) = client_with_fakes();
        http.reply(
            200,
            json!({ "token": "LOGOUT_ORIGINAL_A_CANARY", "expiresIn": SESSION_TTL }),
        );
        client
            .login("synthetic-account-a", "synthetic-password")
            .await
            .unwrap();
        let epoch_a = client.session_epoch();
        http.reply(200, json!({ "id": "owner-a" }));
        client.me_for_epoch(epoch_a).await.unwrap();
        client
            .with_like_owner_commit(epoch_a, "owner-a", || {
                db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-a"))
                    .map_err(|_| "synthetic owner commit failed".to_owned())
            })
            .unwrap();
        let old_metadata: Value = serde_json::from_str(&stored(&db)).unwrap();
        let old_target = old_metadata["credentialTarget"]
            .as_str()
            .unwrap()
            .to_owned();
        let before = http.requests.lock().unwrap().len();
        let remote_reply = http.defer();
        let client = Arc::new(client);
        let logout_client = client.clone();
        let logout = tokio::spawn(async move { logout_client.logout_for_epoch(epoch_a).await });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            http.wait_for_requests(before + 1),
        )
        .await
        .unwrap();
        assert!(
            client.token().is_none(),
            "logout waited for HTTP before revoking local authority"
        );
        assert_eq!(
            db.with(|conn| crate::db::store::get_setting(conn, "astral.session"))
                .unwrap(),
            None
        );
        assert!(!store.secrets.lock().unwrap().contains_key(&old_target));
        assert!(client.with_like_session_epoch(epoch_a, || Ok(())).is_err());
        http.reply(
            200,
            json!({ "token": "LOGOUT_NEW_OWNER_B_CANARY", "expiresIn": SESSION_TTL }),
        );
        client
            .login("synthetic-account-b", "synthetic-password")
            .await
            .unwrap();
        let epoch_b = client.session_epoch();
        http.reply(200, json!({ "id": "owner-b" }));
        client.me_for_epoch(epoch_b).await.unwrap();
        client
            .with_like_owner_commit(epoch_b, "owner-b", || {
                db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-b"))
                    .map_err(|_| "synthetic owner commit failed".to_owned())
            })
            .unwrap();
        let new_metadata = stored(&db);
        assert!(remote_reply
            .send(Ok(AstralHttpResponse {
                status: remote_status,
                body: json!({ "code": remote_status, "data": null }).to_string()
            }))
            .is_ok());
        let result = logout.await.unwrap();
        assert_eq!(result.is_ok(), remote_status == 200);
        assert!(client.logout_for_epoch(epoch_a).await.is_err());
        assert_eq!(client.session_epoch(), epoch_b);
        assert_eq!(client.token().as_deref(), Some("LOGOUT_NEW_OWNER_B_CANARY"));
        assert_eq!(stored(&db), new_metadata);
        client.with_like_session_epoch(epoch_b, || Ok(())).unwrap();
        let new_target: Value = serde_json::from_str(&new_metadata).unwrap();
        assert_eq!(
            store
                .secrets
                .lock()
                .unwrap()
                .get(new_target["credentialTarget"].as_str().unwrap())
                .map(String::as_str),
            Some("LOGOUT_NEW_OWNER_B_CANARY")
        );
        let requests = http.requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            before + 3,
            "logout/rejection/stale call must not auto-refresh or dispatch with B"
        );
        assert_eq!(
            requests[before].satoken.as_deref(),
            Some("LOGOUT_ORIGINAL_A_CANARY")
        );
    }
}

#[tokio::test]
async fn stale_identity_profile_and_media_epochs_cannot_dispatch_or_preflight_files() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "STALE_MEDIA_A_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account-a", "synthetic-password")
        .await
        .unwrap();
    let epoch_a = client.session_epoch();
    http.reply(
        200,
        json!({ "token": "CURRENT_MEDIA_B_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account-b", "synthetic-password")
        .await
        .unwrap();
    let epoch_b = client.session_epoch();
    http.reply(200, json!({ "id": "owner-b" }));
    client.me_for_epoch(epoch_b).await.unwrap();
    client
        .with_like_owner_commit(epoch_b, "owner-b", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-b"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let before = http.requests.lock().unwrap().len();
    for _ in 0..11 {
        http.reply(200, json!({ "seq": 17 }));
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let missing_file = format!(
        "F:/qtMusic/_tmp/security-never-created-{}-{nonce}.png",
        std::process::id()
    );
    let outcomes = [
        ("me", client.me_for_epoch(epoch_a).await.map(|_| ()).err()),
        (
            "refresh",
            client.refresh_for_epoch(epoch_a).await.map(|_| ()).err(),
        ),
        (
            "profile",
            client
                .update_profile_for_epoch(epoch_a, json!({ "nickname": "synthetic" }))
                .await
                .map(|_| ())
                .err(),
        ),
        (
            "user alias",
            client
                .update_user_for_epoch(epoch_a, json!({ "nickname": "synthetic" }))
                .await
                .map(|_| ())
                .err(),
        ),
        (
            "avatar ticket",
            client
                .avatar_ticket_for_epoch(epoch_a, "synthetic.png", "image/png", 12)
                .await
                .map(|_| ())
                .err(),
        ),
        (
            "avatar complete",
            client
                .avatar_complete_for_epoch(epoch_a, "synthetic-upload")
                .await
                .map(|_| ())
                .err(),
        ),
        (
            "cover ticket",
            client
                .cover_ticket_for_epoch(
                    epoch_a,
                    "pid",
                    "synthetic",
                    "synthetic.png",
                    "image/png",
                    12,
                )
                .await
                .map(|_| ())
                .err(),
        ),
        (
            "cover complete",
            client
                .cover_complete_for_epoch(epoch_a, "pid", "synthetic", "synthetic-upload")
                .await
                .map(|_| ())
                .err(),
        ),
        (
            "cover clear",
            client
                .cover_clear_for_epoch(epoch_a, "pid", "synthetic")
                .await
                .map(|_| ())
                .err(),
        ),
        (
            "avatar file",
            client
                .upload_avatar_file_for_epoch(epoch_a, &missing_file)
                .await
                .map(|_| ())
                .err(),
        ),
        (
            "cover file",
            client
                .upload_cover_file_for_epoch(epoch_a, "pid", "synthetic", &missing_file)
                .await
                .map(|_| ())
                .err(),
        ),
    ];
    let packets = http.requests.lock().unwrap().len() - before;
    assert!(
        packets == 0
            && outcomes.iter().all(|(_, error)| error
                .as_ref()
                .is_some_and(|error| error.contains("会话已变化"))),
        "stale media epoch: {packets} packets; outcomes={outcomes:?}"
    );
    assert_eq!(client.token().as_deref(), Some("CURRENT_MEDIA_B_CANARY"));
    client.with_like_session_epoch(epoch_b, || Ok(())).unwrap();
}

#[tokio::test]
async fn native_direct_upload_uses_the_injected_upload_boundary() {
    let (client, _db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "UPLOAD_ADAPTER_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    // Deliberately NOT an HTTP(S) URL. The legacy reqwest bypass rejects this
    // scheme before I/O; the injected upload adapter is purely in-memory.
    http.reply(200, json!({ "uploadUrl": "synthetic-upload://object", "uploadId": "synthetic-upload", "method": "PUT" }));
    let ticket = client
        .avatar_ticket_for_epoch(epoch, "synthetic.png", "image/png", 3)
        .await
        .unwrap();
    let result = client
        .direct_upload_for_epoch(epoch, &ticket, "synthetic.png", "image/png", vec![1, 2, 3])
        .await;
    assert!(
        result.is_ok(),
        "direct upload bypassed the injected boundary: {result:?}"
    );
    let uploads = http.uploads.lock().unwrap();
    assert_eq!(uploads.len(), 1);
    assert_eq!(uploads[0].ticket.upload_url, "synthetic-upload://object");
    assert_eq!(uploads[0].file_name, "synthetic.png");
    assert_eq!(uploads[0].content_type, "image/png");
    assert_eq!(uploads[0].bytes, vec![1, 2, 3]);
}

#[tokio::test]
async fn stale_upload_ticket_and_caller_cannot_upload_as_a_new_account() {
    let (client, db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "UPLOAD_TICKET_A_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account-a", "synthetic-password")
        .await
        .unwrap();
    let epoch_a = client.session_epoch();
    http.reply(200, json!({ "uploadUrl": "synthetic-upload://object-a", "uploadId": "synthetic-a", "method": "PUT" }));
    let ticket_a = client
        .avatar_ticket_for_epoch(epoch_a, "synthetic.png", "image/png", 3)
        .await
        .unwrap();
    http.reply(
        200,
        json!({ "token": "UPLOAD_CURRENT_B_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account-b", "synthetic-password")
        .await
        .unwrap();
    let epoch_b = client.session_epoch();
    http.reply(200, json!({ "id": "owner-b" }));
    client.me_for_epoch(epoch_b).await.unwrap();
    client
        .with_like_owner_commit(epoch_b, "owner-b", || {
            db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-b"))
                .map_err(|_| "synthetic owner commit failed".to_owned())
        })
        .unwrap();
    let saved = stored(&db);
    let denials = [
        client
            .direct_upload_for_epoch(
                epoch_a,
                &ticket_a,
                "synthetic.png",
                "image/png",
                vec![1, 2, 3],
            )
            .await
            .is_err(),
        client
            .direct_upload_for_epoch(
                epoch_b,
                &ticket_a,
                "synthetic.png",
                "image/png",
                vec![1, 2, 3],
            )
            .await
            .is_err(),
        client
            .direct_upload(&ticket_a, "synthetic.png", "image/png", vec![1, 2, 3])
            .await
            .is_err(),
    ];
    assert!(
        denials.iter().all(|denied| *denied) && http.uploads.lock().unwrap().is_empty(),
        "old ticket/caller reached storage: denials={denials:?}"
    );
    assert_eq!(client.token().as_deref(), Some("UPLOAD_CURRENT_B_CANARY"));
    assert_eq!(stored(&db), saved);
    client.with_like_session_epoch(epoch_b, || Ok(())).unwrap();
}

#[tokio::test]
async fn proxy_upload_plan_retries_created_and_finishes_with_apply() {
    let (client, _db, _store, http) =
        client_with_fakes_at("https://backend.audit.invalid/api/v1/");
    http.reply(
        200,
        json!({ "token": "PROXY_UPLOAD_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();

    http.reply(
        200,
        json!({
            "mode": "PROXY", "uploadId": "op-proxy-1",
            "contentPath": "/api/v1/app/user/proxy-upload/op-proxy-1/content",
            "maxBytes": 2097152, "intentTtlSeconds": 600
        }),
    );
    let plan = client
        .avatar_upload_plan_for_epoch(
            epoch,
            "synthetic.png",
            "image/png",
            3,
            "qt-pc-upload-test-1",
        )
        .await
        .unwrap();
    assert_eq!(plan.mode, "PROXY");
    assert_eq!(plan.proxy_upload_id, "op-proxy-1");
    assert!(
        plan.ticket.is_none(),
        "proxy plan must not carry a direct-upload ticket"
    );

    // 第一次渠道失败（state=CREATED，服务端已切换备用渠道），重发同一正文后 COMMITTED
    http.proxy_reply(200, json!({ "state": "CREATED", "contentAccepted": false, "fileId": null, "safeCode": "IMG_502", "httpStatus": 502 }));
    http.proxy_reply(200, json!({ "state": "COMMITTED", "contentAccepted": true, "fileId": "9", "safeCode": null, "httpStatus": 200 }));
    client
        .proxy_upload_content_for_epoch(epoch, &plan.proxy_content_path, "image/png", vec![1, 2, 3])
        .await
        .unwrap();

    {
        let puts = http.proxy_puts.lock().unwrap();
        assert_eq!(
            puts.len(),
            2,
            "channel failover must replay the identical body"
        );
        assert_eq!(
            puts[0].url,
            "https://backend.audit.invalid/api/v1/app/user/proxy-upload/op-proxy-1/content"
        );
        assert_eq!(puts[0].satoken.as_deref(), Some("PROXY_UPLOAD_CANARY"));
        assert!(puts[0]
            .headers
            .iter()
            .any(|(name, value)| name == "Content-Type" && value == "image/png"));
        assert_eq!(puts[0].bytes, vec![1, 2, 3]);
        assert_eq!(puts[1].bytes, vec![1, 2, 3]);
    }

    http.reply(
        200,
        json!({ "url": "https://cdn.example/avatar-proxy.png" }),
    );
    let url = client
        .avatar_apply_for_epoch(epoch, "op-proxy-1")
        .await
        .unwrap();
    assert_eq!(url, "https://cdn.example/avatar-proxy.png");
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests[1].url,
        "https://backend.audit.invalid/api/v1/app/user/avatar/upload-plan"
    );
    assert_eq!(
        requests[2].url,
        "https://backend.audit.invalid/api/v1/app/user/avatar/apply"
    );
}

#[test]
fn proxy_upload_paths_resolve_against_origin_or_api_directory() {
    for base in [
        "https://backend.audit.invalid/api/v1",
        "https://backend.audit.invalid/api/v1/",
    ] {
        let (client, _db, _store, _http) = client_with_fakes_at(base);
        for path in [
            "/api/v1/app/user/proxy-upload/op-1/content",
            "app/user/proxy-upload/op-1/content",
        ] {
            assert_eq!(
                client.proxy_upload_url(path).unwrap(),
                "https://backend.audit.invalid/api/v1/app/user/proxy-upload/op-1/content"
            );
        }
    }
}

#[tokio::test]
async fn proxy_upload_does_not_follow_redirects_or_forward_credentials() {
    for status in [302, 307] {
        let destination = super::tests::OwnedHttp::new(200, "", b"unexpected redirect");
        let gateway = super::tests::OwnedHttp::new(
            status,
            &format!("Location: http://{}/external-upload\r\n", destination.addr),
            b"redirect rejected",
        );
        let response = super::send_proxy_upload(
            AstralProxyPutRequest {
                url: format!("http://{}/upload", gateway.addr),
                satoken: Some("PROXY_REDIRECT_TOKEN_CANARY".to_owned()),
                headers: vec![("Content-Type".to_owned(), "image/png".to_owned())],
                bytes: b"PROXY_REDIRECT_IMAGE_CANARY".to_vec(),
            },
            reqwest::Client::builder().no_proxy(),
        ).await.unwrap();
        assert_eq!(response.status, status, "the caller must reject the original redirect response");
        let requests = gateway.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /upload HTTP/1.1\r\n"));
        assert!(requests[0].to_ascii_lowercase().contains("satoken: proxy_redirect_token_canary\r\n"));
        assert!(requests[0].ends_with("PROXY_REDIRECT_IMAGE_CANARY"));
        assert!(destination.requests.lock().unwrap().is_empty(), "redirect leaked credentials or image data to another origin");
    }
}

#[tokio::test]
async fn proxy_upload_keeps_successful_post_body_and_receipt() {
    let reply = r#"{"code":200,"data":{"state":"COMMITTED"}}"#;
    let gateway = super::tests::OwnedHttp::new(200, "", reply.as_bytes());
    let response = super::send_proxy_upload(
        AstralProxyPutRequest {
            url: format!("http://{}/upload", gateway.addr),
            satoken: Some("PROXY_SUCCESS_TOKEN_CANARY".to_owned()),
            headers: vec![("Content-Type".to_owned(), "image/png".to_owned())],
            bytes: b"PROXY_SUCCESS_IMAGE_CANARY".to_vec(),
        },
        reqwest::Client::builder().no_proxy(),
    ).await.unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(response.body, reply);
    let requests = gateway.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /upload HTTP/1.1\r\n"));
    assert!(requests[0].to_ascii_lowercase().contains("content-type: image/png\r\n"));
    assert!(requests[0].to_ascii_lowercase().contains("satoken: proxy_success_token_canary\r\n"));
    assert!(requests[0].ends_with("PROXY_SUCCESS_IMAGE_CANARY"));
}

#[tokio::test]
async fn proxy_upload_rejects_invalid_addresses_before_sending_credentials() {
    let (client, _db, _store, http) = client_with_fakes_at("https://backend.audit.invalid/api/v1");
    http.reply(200, json!({ "token": "PROXY_URL_CANARY", "expiresIn": SESSION_TTL }));
    client.login("synthetic-account", "synthetic-password").await.unwrap();
    for path in [
        "",
        "//external.invalid/upload",
        "https://external.invalid/upload",
        "/\\external.invalid/upload",
        "data:text/plain,upload",
        "/api/v1/app/user/proxy-upload/op-1/content#fragment",
    ] {
        assert!(client
            .proxy_upload_content_for_epoch(client.session_epoch(), path, "image/png", vec![1])
            .await
            .is_err());
    }
    assert!(http.proxy_puts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unreadable_avatar_does_not_reserve_an_upload_intent() {
    let (client, _db, _store, http) = client_with_fakes();
    http.reply(200, json!({ "token": "UNREADABLE_IMAGE_CANARY", "expiresIn": SESSION_TTL }));
    client.login("synthetic-account", "synthetic-password").await.unwrap();
    // 元信息检查能通过的目录，实际读图片必然失败；不能先去后端创建占位任务。
    let directory = std::env::temp_dir().join(format!("qt-avatar-unreadable-{}.png", fastrand::u64(..)));
    std::fs::create_dir(&directory).unwrap();
    let result = client
        .upload_avatar_file_for_epoch(client.session_epoch(), directory.to_str().unwrap())
        .await;
    std::fs::remove_dir(&directory).unwrap();
    assert!(result.is_err());
    assert_eq!(http.requests.lock().unwrap().len(), 1, "only login should reach HTTP");
    assert!(http.proxy_puts.lock().unwrap().is_empty());
    assert!(http.uploads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn proxy_content_terminal_failure_is_not_replayed_endlessly() {
    let (client, _db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "PROXY_FAIL_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account", "synthetic-password")
        .await
        .unwrap();
    let epoch = client.session_epoch();
    // 终态失败（非 CREATED）：不重试，原样上抛服务端文案
    http.proxy_reply(200, json!({ "state": "FAILED", "contentAccepted": false, "fileId": null, "safeCode": "IMG_403", "httpStatus": 403 }));
    let outcome = client
        .proxy_upload_content_for_epoch(
            epoch,
            "/api/v1/app/user/proxy-upload/op-x/content",
            "image/png",
            vec![1],
        )
        .await;
    assert!(outcome.is_err());
    assert_eq!(
        http.proxy_puts.lock().unwrap().len(),
        1,
        "terminal failure must not be replayed"
    );
}

#[tokio::test]
async fn stale_session_cannot_proxy_upload_content() {
    let (client, _db, _store, http) = client_with_fakes();
    http.reply(
        200,
        json!({ "token": "PROXY_STALE_A_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account-a", "synthetic-password")
        .await
        .unwrap();
    let epoch_a = client.session_epoch();
    http.reply(
        200,
        json!({ "token": "PROXY_CURRENT_B_CANARY", "expiresIn": SESSION_TTL }),
    );
    client
        .login("synthetic-account-b", "synthetic-password")
        .await
        .unwrap();
    let outcome = client
        .proxy_upload_content_for_epoch(
            epoch_a,
            "/api/v1/app/user/proxy-upload/op-stale/content",
            "image/png",
            vec![1, 2, 3],
        )
        .await;
    assert!(outcome.is_err());
    assert!(
        http.proxy_puts.lock().unwrap().is_empty(),
        "stale epoch must not reach the gateway body endpoint"
    );
    assert_eq!(client.token().as_deref(), Some("PROXY_CURRENT_B_CANARY"));
}

#[tokio::test]
async fn invalidated_native_authority_cannot_accept_or_repeat_a_storage_upload() {
    for replace_account in [false, true] {
        let (client, db, _store, http) = client_with_fakes();
        let client = Arc::new(client);
        http.reply(
            200,
            json!({ "token": "STORAGE_OLD_A_CANARY", "expiresIn": SESSION_TTL }),
        );
        client
            .login("synthetic-account-a", "synthetic-password")
            .await
            .unwrap();
        let epoch_a = client.session_epoch();
        http.reply(200, json!({ "id": "owner-a" }));
        client.me_for_epoch(epoch_a).await.unwrap();
        client
            .with_like_owner_commit(epoch_a, "owner-a", || {
                db.with(|conn| crate::db::store::set_setting(conn, "like.sync.owner", "owner-a"))
                    .map_err(|_| "synthetic owner commit failed".to_owned())
            })
            .unwrap();
        http.reply(200, json!({ "uploadUrl": "synthetic-upload://cover-a", "uploadId": "synthetic-cover-a", "method": "PUT" }));
        let ticket = client
            .cover_ticket_for_epoch(
                epoch_a,
                "synthetic-pid",
                "local",
                "synthetic.png",
                "image/png",
                3,
            )
            .await
            .unwrap();
        let release = http.defer_upload();
        let actor = client.clone();
        let in_flight_ticket = ticket.clone();
        let pending = tokio::spawn(async move {
            actor
                .direct_upload_for_epoch(
                    epoch_a,
                    &in_flight_ticket,
                    "synthetic.png",
                    "image/png",
                    vec![1, 2, 3],
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), http.wait_for_uploads(1))
            .await
            .unwrap();
        if replace_account {
            http.reply(
                200,
                json!({ "token": "STORAGE_CURRENT_B_CANARY", "expiresIn": SESSION_TTL }),
            );
            client
                .login("synthetic-account-b", "synthetic-password")
                .await
                .unwrap();
            let epoch_b = client.session_epoch();
            http.reply(200, json!({ "id": "owner-b" }));
            client.me_for_epoch(epoch_b).await.unwrap();
            client
                .with_like_owner_commit(epoch_b, "owner-b", || {
                    db.with(|conn| {
                        crate::db::store::set_setting(conn, "like.sync.owner", "owner-b")
                    })
                    .map_err(|_| "synthetic owner commit failed".to_owned())
                })
                .unwrap();
        } else {
            client
                .with_like_owner_invalidated(epoch_a, || Ok(()))
                .unwrap();
        }
        release.send(Ok(())).unwrap();
        let result = pending.await.unwrap();
        assert!(result.is_err(), "invalidated upload result was accepted, account replacement={replace_account}: {result:?}");
        assert!(client
            .direct_upload_for_epoch(
                epoch_a,
                &ticket,
                "synthetic.png",
                "image/png",
                vec![1, 2, 3]
            )
            .await
            .is_err());
        assert_eq!(
            http.uploads.lock().unwrap().len(),
            1,
            "revoked storage upload was dispatched again"
        );
        assert_eq!(
            http.uploads.lock().unwrap()[0].ticket.upload_url,
            "synthetic-upload://cover-a"
        );
        if replace_account {
            assert_eq!(client.token().as_deref(), Some("STORAGE_CURRENT_B_CANARY"));
            client
                .with_like_session_epoch(client.session_epoch(), || Ok(()))
                .unwrap();
        }
    }
}
