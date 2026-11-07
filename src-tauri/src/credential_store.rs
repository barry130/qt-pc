//! Native-only Astral credentials. SQLite holds a reference/expiry, never a token.
//! Platform adapters are injected; regression tests use only fake stores and synthetic DBs.

use std::path::Path;
use std::sync::Arc;

use ring::rand::SecureRandom;
use serde::{Deserialize, Serialize};

use crate::db::Database;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialError {
    Unavailable,
    Failed,
}

impl std::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "系统凭据存储不可用",
            Self::Failed => "系统凭据操作失败",
        })
    }
}

impl std::error::Error for CredentialError {}

pub trait CredentialStore: Send + Sync {
    fn read(&self, target: &str) -> Result<Option<String>, CredentialError>;
    fn write(&self, target: &str, secret: &str) -> Result<(), CredentialError>;
    fn delete(&self, target: &str) -> Result<(), CredentialError>;
}

/// Byte-oriented OS boundary. The policy adapter is also exercised with fakes;
/// neither raw secrets nor operating-system errors implement a log projection.
pub(crate) trait CredentialBackend: Send + Sync {
    fn read_bytes(&self, target: &str) -> Result<Option<Vec<u8>>, CredentialError>;
    fn write_bytes(&self, target: &str, secret: &[u8]) -> Result<(), CredentialError>;
    fn delete_bytes(&self, target: &str) -> Result<(), CredentialError>;
}

pub(crate) struct NativeCredentialAdapter<'a> {
    backend: &'a dyn CredentialBackend,
}

const MAX_CREDENTIAL_BYTES: usize = 2560;

fn validate_credential_target(target: &str) -> Result<(), CredentialError> {
    let Some((scope, id)) = target.strip_prefix("qt-music:astral:").and_then(|target| target.split_once(':')) else { return Err(CredentialError::Failed); };
    if scope.len() != 64 || id.len() != 32 || !scope.bytes().chain(id.bytes()).all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(CredentialError::Failed);
    }
    Ok(())
}

impl CredentialStore for NativeCredentialAdapter<'_> {
    fn read(&self, target: &str) -> Result<Option<String>, CredentialError> {
        validate_credential_target(target)?;
        self.backend.read_bytes(target)?.map(|secret| {
            if secret.is_empty() || secret.len() > MAX_CREDENTIAL_BYTES { return Err(CredentialError::Failed); }
            String::from_utf8(secret).map_err(|_| CredentialError::Failed)
        }).transpose()
    }
    fn write(&self, target: &str, secret: &str) -> Result<(), CredentialError> {
        validate_credential_target(target)?;
        if secret.is_empty() || secret.len() > MAX_CREDENTIAL_BYTES { return Err(CredentialError::Failed); }
        self.backend.write_bytes(target, secret.as_bytes())
    }
    fn delete(&self, target: &str) -> Result<(), CredentialError> {
        validate_credential_target(target)?;
        self.backend.delete_bytes(target)
    }
}

struct SystemCredentialBackend;

impl CredentialBackend for SystemCredentialBackend {
    fn read_bytes(&self, target: &str) -> Result<Option<Vec<u8>>, CredentialError> { platform::read(target) }
    fn write_bytes(&self, target: &str, secret: &[u8]) -> Result<(), CredentialError> { platform::write(target, secret) }
    fn delete_bytes(&self, target: &str) -> Result<(), CredentialError> { platform::delete(target) }
}

pub struct PlatformCredentialStore;

impl CredentialStore for PlatformCredentialStore {
    fn read(&self, target: &str) -> Result<Option<String>, CredentialError> { NativeCredentialAdapter { backend: &SystemCredentialBackend }.read(target) }
    fn write(&self, target: &str, secret: &str) -> Result<(), CredentialError> { NativeCredentialAdapter { backend: &SystemCredentialBackend }.write(target, secret) }
    fn delete(&self, target: &str) -> Result<(), CredentialError> { NativeCredentialAdapter { backend: &SystemCredentialBackend }.delete(target) }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{CredentialError, MAX_CREDENTIAL_BYTES};
    use windows::core::{Error, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Security::Credentials::{CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};

    fn unavailable(error: &Error) -> CredentialError {
        // No logon session, unsupported/disabled credential service, or denied
        // access: these failures cannot have written a credential. Never expose
        // OS error strings (which may contain user/account information).
        if [5, 50, 1058, 1312].into_iter().any(|code| error.code() == HRESULT::from_win32(code)) {
            CredentialError::Unavailable
        } else { CredentialError::Failed }
    }
    fn not_found(error: &Error) -> bool { error.code() == HRESULT::from_win32(1168) }
    struct CredentialAllocation(*mut CREDENTIALW);
    impl Drop for CredentialAllocation {
        fn drop(&mut self) { unsafe { CredFree(self.0.cast()) }; }
    }
    pub(super) fn read(target: &str) -> Result<Option<Vec<u8>>, CredentialError> {
        let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        let mut raw = std::ptr::null_mut();
        // The target buffer lives for this synchronous API call; successful
        // allocations are always released, including corrupt-blob failures.
        match unsafe { CredReadW(PCWSTR(wide.as_ptr()), CRED_TYPE_GENERIC, None, &mut raw) } {
            Err(error) if not_found(&error) => return Ok(None),
            Err(error) => return Err(unavailable(&error)),
            Ok(()) => {}
        }
        if raw.is_null() { return Err(CredentialError::Failed); }
        let allocation = CredentialAllocation(raw);
        let credential = unsafe { &*allocation.0 };
        let size = credential.CredentialBlobSize as usize;
        if credential.Type != CRED_TYPE_GENERIC || size == 0 || size > MAX_CREDENTIAL_BYTES || credential.CredentialBlob.is_null() {
            return Err(CredentialError::Failed);
        }
        Ok(Some(unsafe { std::slice::from_raw_parts(credential.CredentialBlob, size) }.to_vec()))
    }
    pub(super) fn write(target: &str, secret: &[u8]) -> Result<(), CredentialError> {
        let mut wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(wide.as_mut_ptr()),
            CredentialBlobSize: secret.len() as u32,
            CredentialBlob: secret.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe { CredWriteW(&credential, 0) }.map_err(|error| unavailable(&error))
    }
    pub(super) fn delete(target: &str) -> Result<(), CredentialError> {
        let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        match unsafe { CredDeleteW(PCWSTR(wide.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if not_found(&error) => Ok(()),
            Err(error) => Err(unavailable(&error)),
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::CredentialError;
    use security_framework::os::macos::keychain::SecKeychain;
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    const SERVICE: &str = "qt-music.astral";
    static KEYCHAIN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn classify(error: security_framework::base::Error) -> CredentialError {
        match error.code() {
            -25291 | -25308 | -128 => CredentialError::Unavailable,
            _ => CredentialError::Failed,
        }
    }
    fn noninteractive<T>(operation: impl FnOnce() -> Result<T, CredentialError>) -> Result<T, CredentialError> {
        let _lock = KEYCHAIN_LOCK.lock().map_err(|_| CredentialError::Failed)?;
        // The library lock always re-enables interaction on drop. Only acquire
        // it when interaction was enabled, preserving an already-disabled host.
        let _interaction = if SecKeychain::user_interaction_allowed().map_err(classify)? {
            Some(SecKeychain::disable_user_interaction().map_err(classify)?)
        } else { None };
        operation()
    }
    pub(super) fn read(target: &str) -> Result<Option<Vec<u8>>, CredentialError> {
        noninteractive(|| match get_generic_password(SERVICE, target) {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if error.code() == -25300 => Ok(None),
            Err(error) => Err(classify(error)),
        })
    }
    pub(super) fn write(target: &str, secret: &[u8]) -> Result<(), CredentialError> {
        noninteractive(|| set_generic_password(SERVICE, target, secret).map_err(classify))
    }
    pub(super) fn delete(target: &str) -> Result<(), CredentialError> {
        noninteractive(|| match delete_generic_password(SERVICE, target) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == -25300 => Ok(()),
            Err(error) => Err(classify(error)),
        })
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::CredentialError;
    use std::collections::HashMap;
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Str, Value};

    const SERVICE: &str = "org.freedesktop.secrets";
    const SERVICE_PATH: &str = "/org/freedesktop/secrets";
    const SERVICE_INTERFACE: &str = "org.freedesktop.Secret.Service";
    type Secret = (OwnedObjectPath, Vec<u8>, Vec<u8>, String);
    fn classify(error: zbus::Error) -> CredentialError {
        if let zbus::Error::MethodError(name, _, _) = &error {
            if matches!(name.as_str(), "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner" | "org.freedesktop.DBus.Error.AccessDenied" | "org.freedesktop.DBus.Error.UnknownMethod" | "org.freedesktop.DBus.Error.UnknownInterface" | "org.freedesktop.Secret.Error.IsLocked") {
                return CredentialError::Unavailable;
            }
        }
        // A method transport/timeout failure may have taken effect. Do not
        // degrade it to memory-only or discard a previously committed token.
        CredentialError::Failed
    }
    fn connection() -> Result<Connection, CredentialError> {
        zbus::blocking::connection::Builder::session().map_err(|_| CredentialError::Unavailable)?
            .method_timeout(std::time::Duration::from_secs(3)).build().map_err(|_| CredentialError::Unavailable)
    }
    fn proxy<'a>(connection: &'a Connection, path: &'a str, interface: &'a str) -> Result<Proxy<'a>, CredentialError> {
        Proxy::new(connection, SERVICE, path, interface).map_err(classify)
    }
    fn attributes(target: &str) -> HashMap<&str, &str> {
        HashMap::from([("application", "qt-music"), ("credentialTarget", target)])
    }
    fn find(connection: &Connection, target: &str) -> Result<Option<OwnedObjectPath>, CredentialError> {
        let service = proxy(connection, SERVICE_PATH, SERVICE_INTERFACE)?;
        let (unlocked, locked): (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) = service.call("SearchItems", &(attributes(target),)).map_err(classify)?;
        if !locked.is_empty() { return Err(CredentialError::Unavailable); }
        if unlocked.len() > 1 { return Err(CredentialError::Failed); }
        Ok(unlocked.into_iter().next())
    }
    fn session<T>(connection: &Connection, operation: impl FnOnce(&OwnedObjectPath) -> Result<T, CredentialError>) -> Result<T, CredentialError> {
        let service = proxy(connection, SERVICE_PATH, SERVICE_INTERFACE)?;
        let (_, session): (OwnedValue, OwnedObjectPath) = service.call("OpenSession", &("plain", OwnedValue::from(Str::from("")))).map_err(classify)?;
        if session.as_str() == "/" { return Err(CredentialError::Failed); }
        let result = operation(&session);
        if let Ok(session_proxy) = proxy(connection, session.as_str(), "org.freedesktop.Secret.Session") {
            let _: Result<(), _> = session_proxy.call("Close", &());
        }
        result
    }
    pub(super) fn read(target: &str) -> Result<Option<Vec<u8>>, CredentialError> {
        let connection = connection()?;
        let Some(item) = find(&connection, target)? else { return Ok(None); };
        session(&connection, |session| {
            let item = proxy(&connection, item.as_str(), "org.freedesktop.Secret.Item")?;
            if item.get_property::<bool>("Locked").map_err(classify)? { return Err(CredentialError::Unavailable); }
            let (reply_session, parameters, secret, _content_type): Secret = item.call("GetSecret", &(session,)).map_err(classify)?;
            if reply_session != *session || !parameters.is_empty() { return Err(CredentialError::Failed); }
            Ok(Some(secret))
        })
    }
    pub(super) fn write(target: &str, secret: &[u8]) -> Result<(), CredentialError> {
        let connection = connection()?;
        let service = proxy(&connection, SERVICE_PATH, SERVICE_INTERFACE)?;
        let collection: OwnedObjectPath = service.call("ReadAlias", &("default",)).map_err(classify)?;
        if collection.as_str() == "/" { return Err(CredentialError::Unavailable); }
        let collection_proxy = proxy(&connection, collection.as_str(), "org.freedesktop.Secret.Collection")?;
        if collection_proxy.get_property::<bool>("Locked").map_err(classify)? { return Err(CredentialError::Unavailable); }
        session(&connection, |session| {
            let properties = HashMap::from([
                ("org.freedesktop.Secret.Item.Label", Value::from("qt-music Astral session")),
                ("org.freedesktop.Secret.Item.Attributes", Value::from(attributes(target))),
            ]);
            let payload: Secret = (session.clone(), Vec::new(), secret.to_vec(), "text/plain; charset=utf-8".to_owned());
            let (item, prompt): (OwnedObjectPath, OwnedObjectPath) = collection_proxy.call("CreateItem", &(properties, payload, true)).map_err(classify)?;
            // Never call Prompt or Unlock. An item plus a prompt is an unknown
            // effect (Failed); a prompt with no item cannot persist a token.
            if prompt.as_str() != "/" {
                return Err(if item.as_str() == "/" { CredentialError::Unavailable } else { CredentialError::Failed });
            }
            if item.as_str() == "/" { return Err(CredentialError::Failed); }
            Ok(())
        })
    }
    pub(super) fn delete(target: &str) -> Result<(), CredentialError> {
        let connection = connection()?;
        let Some(item) = find(&connection, target)? else { return Ok(()); };
        let item = proxy(&connection, item.as_str(), "org.freedesktop.Secret.Item")?;
        if item.get_property::<bool>("Locked").map_err(classify)? { return Err(CredentialError::Unavailable); }
        let prompt: OwnedObjectPath = item.call("Delete", &()).map_err(classify)?;
        if prompt.as_str() != "/" { return Err(CredentialError::Unavailable); }
        Ok(())
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    use super::CredentialError;
    pub(super) fn read(_target: &str) -> Result<Option<Vec<u8>>, CredentialError> { Err(CredentialError::Unavailable) }
    pub(super) fn write(_target: &str, _secret: &[u8]) -> Result<(), CredentialError> { Err(CredentialError::Unavailable) }
    pub(super) fn delete(_target: &str) -> Result<(), CredentialError> { Err(CredentialError::Unavailable) }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionPersistence {
    Secure,
    MemoryOnly,
}

/// Safe IPC projection: never serialize an AuthSession/token to the WebView.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub expires_at: i64,
    pub persistence: SessionPersistence,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionHandle {
    pub status: SessionStatus,
    pub target: Option<String>,
}

pub(crate) struct RestoredSession {
    pub token: String,
    pub handle: SessionHandle,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionMetadata {
    version: u8,
    expires_at: i64,
    credential_target: String,
}

/// Verify manual backup eligibility without reading credentials or changing RAM.
/// This is a DB-only check; cleanup belongs to startup/session installation.
pub fn check_session_storage_hygiene(db: &Database) -> Result<(), String> {
    db.with(|conn| {
        let done = crate::db::store::get_setting(conn, "astral.secureStorageVersion")?.as_deref() == Some("1");
        let raw = crate::db::store::get_setting(conn, crate::astral::SETTING_ASTRAL_SESSION)?.unwrap_or_default();
        if !conn.is_autocommit() || !done || (!raw.is_empty() && !is_supported_session_metadata(&raw)) {
            return Err(rusqlite::Error::InvalidQuery);
        }
        SessionVault::checkpoint(conn)
    }).map_err(|_| String::from("旧会话存储清理失败；禁止生成新备份或导出"))
}

fn is_supported_session_metadata(raw: &str) -> bool {
    serde_json::from_str::<SessionMetadata>(raw).ok().is_some_and(|metadata| {
        let Some((scope, id)) = metadata.credential_target.strip_prefix("qt-music:astral:")
            .and_then(|target| target.split_once(':')) else { return false; };
        metadata.version == 1 && scope.len() == 64 && id.len() == 32
            && scope.bytes().chain(id.bytes()).all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// All blocking DB/OS work is performed off the async executor by AstralClient.
pub(crate) struct SessionVault {
    db: Option<Arc<Database>>,
    store: Arc<dyn CredentialStore>,
    namespace: String,
}

impl SessionVault {
    pub(crate) fn new(
        db: Option<Arc<Database>>,
        data_root: &Path,
        backend: &str,
        store: Arc<dyn CredentialStore>,
    ) -> Self {
        let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
        digest.update(data_root.as_os_str().as_encoded_bytes());
        digest.update(&[0]);
        digest.update(backend.as_bytes());
        let digest = digest.finish();
        let hash: String = digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect();
        Self { db, store, namespace: format!("qt-music:astral:{hash}:") }
    }

    /// Called under the native session fence: lock order is session -> DB.
    pub(crate) fn like_owner_matches(&self, uid: &str) -> Result<bool, String> {
        let Some(db) = &self.db else { return Ok(false); };
        db.with(|conn| crate::db::store::get_setting(conn, "like.sync.owner"))
            .map(|owner| owner.as_deref() == Some(uid))
            .map_err(|_| "收藏归属读取失败".to_owned())
    }

    fn checkpoint(conn: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
        let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
        if busy != 0 { return Err(rusqlite::Error::InvalidQuery); }
        Ok(())
    }

    /// One-time cleanup also covers tokens freed by older versions that stored an
    /// empty session. The success marker is written only after VACUUM/checkpoint.
    fn sanitize_storage(&self) -> Result<(), String> {
        const MARKER: &str = "astral.secureStorageVersion";
        let Some(db) = &self.db else { return Ok(()); };
        db.with(|conn| {
            let raw = crate::db::store::get_setting(conn, crate::astral::SETTING_ASTRAL_SESSION)?;
            let legacy = raw.as_deref().is_some_and(|raw| !raw.is_empty() && !is_supported_session_metadata(raw));
            let done = crate::db::store::get_setting(conn, MARKER)?.as_deref() == Some("1");
            conn.pragma_update(None, "secure_delete", true)?;
            if legacy || !done {
                // A previous successful cleanup does not attest a reinserted
                // legacy row. Revoke it before any fallible erase/checkpoint.
                conn.execute("DELETE FROM settings WHERE key=?1", [MARKER])?;
            }
            if legacy {
                conn.execute("DELETE FROM settings WHERE key=?1", [crate::astral::SETTING_ASTRAL_SESSION])?;
            }
            if legacy || !done {
                conn.execute_batch("VACUUM")?;
                Self::checkpoint(conn)?;
                crate::db::store::set_setting(conn, MARKER, "1")?;
            }
            Self::checkpoint(conn)
        }).map_err(|_| String::from("旧会话存储清理失败；禁止生成新备份或导出"))
    }

    fn memory_only(expires_at: i64) -> SessionHandle {
        SessionHandle {
            status: SessionStatus { expires_at, persistence: SessionPersistence::MemoryOnly },
            target: None,
        }
    }

    fn owns_target(&self, target: &str) -> bool {
        target.strip_prefix(&self.namespace).is_some_and(|id| {
            id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        })
    }

    fn owned_reference(&self, raw: &str) -> Option<String> {
        serde_json::from_str::<SessionMetadata>(raw).ok()
            .filter(|metadata| metadata.version == 1 && self.owns_target(&metadata.credential_target))
            .map(|metadata| metadata.credential_target)
    }

    /// Prepare only writes to the secure adapter; no SQLite pointer is changed yet.
    /// AstralClient commits and installs RAM under the same session write guard.
    pub(crate) fn prepare(&self, token: &str, expires_at: i64) -> Result<SessionHandle, String> {
        if token.is_empty() { return Err("会话令牌为空".into()); }
        self.sanitize_storage()?;
        if self.db.is_none() { return Ok(Self::memory_only(expires_at)); }
        let mut random = [0u8; 16];
        ring::rand::SystemRandom::new().fill(&mut random)
            .map_err(|_| String::from("会话凭据标识生成失败"))?;
        let id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let prepared = SessionHandle {
            status: SessionStatus { expires_at, persistence: SessionPersistence::Secure },
            target: Some(format!("{}{id}", self.namespace)),
        };
        match self.store.write(prepared.target.as_deref().unwrap(), token) {
            Ok(()) => Ok(prepared),
            Err(error) => {
                self.abort(&prepared);
                if error == CredentialError::Unavailable {
                    Ok(Self::memory_only(expires_at))
                } else {
                    Err(error.to_string())
                }
            }
        }
    }

    /// Synchronous DB-only commit; caller may hold the session write guard here.
    pub(crate) fn commit(&self, prepared: &SessionHandle) -> Result<Option<String>, String> {
        let value = match prepared.target.as_deref() {
            Some(target) if self.owns_target(target) => Some(serde_json::to_string(&SessionMetadata {
                version: 1,
                expires_at: prepared.status.expires_at,
                credential_target: target.into(),
            }).map_err(|_| String::from("会话引用序列化失败"))?),
            Some(_) => return Err("会话凭据引用不属于当前环境".into()),
            None => None,
        };
        let Some(db) = &self.db else { return Ok(None); };
        db.with(|conn| {
            conn.pragma_update(None, "secure_delete", true)?;
            let transaction = conn.unchecked_transaction()?;
            let old = crate::db::store::get_setting(&transaction, crate::astral::SETTING_ASTRAL_SESSION)?
                .and_then(|raw| self.owned_reference(&raw));
            if let Some(value) = &value {
                crate::db::store::set_setting(&transaction, crate::astral::SETTING_ASTRAL_SESSION, value)?;
            } else {
                transaction.execute("DELETE FROM settings WHERE key=?1", [crate::astral::SETTING_ASTRAL_SESSION])?;
            }
            transaction.commit()?;
            Ok(old)
        }).map_err(|_| String::from("会话引用保存失败"))
    }

    pub(crate) fn retire(&self, target: Option<&str>) -> Result<(), String> {
        if let Some(target) = target.filter(|target| self.owns_target(target)) {
            self.store.delete(target).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub(crate) fn abort(&self, prepared: &SessionHandle) {
        if self.retire(prepared.target.as_deref()).is_err() {
            log::warn!("新会话凭据回滚清理失败；未安装新会话");
        }
    }

    pub(crate) fn persist_new(&self, token: &str, expires_at: i64) -> Result<SessionHandle, String> {
        let prepared = self.prepare(token, expires_at)?;
        let old = match self.commit(&prepared) {
            Ok(old) => old,
            Err(error) => { self.abort(&prepared); return Err(error); }
        };
        if self.retire(old.as_deref()).is_err() {
            log::warn!("旧会话凭据清理失败；已解除数据库引用");
        }
        Ok(prepared)
    }

    pub(crate) fn restore(&self, now: i64) -> Result<Option<RestoredSession>, String> {
        let Some(db) = &self.db else { return Ok(None); };
        let raw = db.with(|conn| crate::db::store::get_setting(conn, crate::astral::SETTING_ASTRAL_SESSION))
            .map_err(|_| String::from("会话引用读取失败"))?.unwrap_or_default();
        self.sanitize_storage()?;
        let metadata = match serde_json::from_str::<SessionMetadata>(&raw) {
            Ok(metadata) => metadata,
            Err(_) => {
                let legacy = serde_json::from_str::<serde_json::Value>(&raw).ok();
                let token = legacy.as_ref().and_then(|value| value.get("token")).and_then(|value| value.as_str()).filter(|token| !token.is_empty());
                let expires_at = legacy.as_ref().and_then(|value| value.get("expiresAt")).and_then(|value| value.as_i64());
                if let (Some(token), Some(expires_at)) = (token, expires_at) {
                    if expires_at > now.saturating_add(60_000) {
                        let handle = self.persist_new(token, expires_at)?;
                        return Ok(Some(RestoredSession { token: token.into(), handle }));
                    }
                }
                return Ok(None);
            }
        };
        if metadata.version != 1 || !self.owns_target(&metadata.credential_target)
            || metadata.expires_at <= now.saturating_add(60_000) {
            return Ok(None);
        }
        let token = match self.store.read(&metadata.credential_target) {
            Ok(Some(token)) if !token.is_empty() => token,
            Ok(_) | Err(CredentialError::Unavailable) => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        Ok(Some(RestoredSession {
            token,
            handle: SessionHandle {
                status: SessionStatus { expires_at: metadata.expires_at, persistence: SessionPersistence::Secure },
                target: Some(metadata.credential_target),
            },
        }))
    }

    pub(crate) fn clear_reference(&self) -> Result<Option<String>, String> {
        self.commit(&SessionHandle {
            status: SessionStatus { expires_at: 0, persistence: SessionPersistence::MemoryOnly },
            target: None,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeCredentialBackend {
        secrets: Mutex<HashMap<String, Vec<u8>>>,
        calls: Mutex<Vec<&'static str>>,
        error: Mutex<Option<CredentialError>>,
    }

    impl CredentialBackend for FakeCredentialBackend {
        fn read_bytes(&self, target: &str) -> Result<Option<Vec<u8>>, CredentialError> {
            self.calls.lock().unwrap().push("read");
            if let Some(error) = *self.error.lock().unwrap() { return Err(error); }
            Ok(self.secrets.lock().unwrap().get(target).cloned())
        }
        fn write_bytes(&self, target: &str, secret: &[u8]) -> Result<(), CredentialError> {
            self.calls.lock().unwrap().push("write");
            if let Some(error) = *self.error.lock().unwrap() { return Err(error); }
            self.secrets.lock().unwrap().insert(target.to_owned(), secret.to_vec());
            Ok(())
        }
        fn delete_bytes(&self, target: &str) -> Result<(), CredentialError> {
            self.calls.lock().unwrap().push("delete");
            if let Some(error) = *self.error.lock().unwrap() { return Err(error); }
            self.secrets.lock().unwrap().remove(target);
            Ok(())
        }
    }

    #[test]
    fn native_credential_adapter_round_trips_through_the_fake_os_boundary() {
        let backend = FakeCredentialBackend::default();
        let adapter = NativeCredentialAdapter { backend: &backend };
        let target = format!("qt-music:astral:{}:{}", "a".repeat(64), "b".repeat(32));
        adapter.write(&target, "NATIVE_OS_ADAPTER_CANARY").unwrap();
        assert_eq!(adapter.read(&target).unwrap().as_deref(), Some("NATIVE_OS_ADAPTER_CANARY"));
        adapter.delete(&target).unwrap();
        assert_eq!(adapter.read(&target).unwrap(), None);
        assert_eq!(*backend.calls.lock().unwrap(), ["write", "read", "delete", "read"]);
    }

    #[test]
    fn native_credential_adapter_rejects_foreign_targets_before_the_os_boundary() {
        let backend = FakeCredentialBackend::default();
        let adapter = NativeCredentialAdapter { backend: &backend };
        let valid = format!("qt-music:astral:{}:{}", "a".repeat(64), "b".repeat(32));
        for target in [
            "unrelated-user-credential".to_owned(),
            format!("{valid}:suffix"),
            format!("{valid}\0ignored"),
            format!("qt-music:astral:{}:{}", "A".repeat(64), "b".repeat(32)),
            format!("qt-music:astral:{}:{}", "a".repeat(63), "b".repeat(32)),
        ] {
            let rejected = [adapter.read(&target).is_err(), adapter.write(&target, "SCOPE_CANARY").is_err(), adapter.delete(&target).is_err()];
            assert!(rejected.iter().all(|denied| *denied), "invalid credential target was accepted: {rejected:?}");
        }
        assert!(backend.calls.lock().unwrap().is_empty(), "foreign credential namespace reached the OS adapter");
    }

    #[test]
    fn native_credential_adapter_rejects_empty_or_oversized_secret_envelopes() {
        let backend = FakeCredentialBackend::default();
        let adapter = NativeCredentialAdapter { backend: &backend };
        let target = format!("qt-music:astral:{}:{}", "a".repeat(64), "b".repeat(32));
        for bytes in [Vec::new(), vec![b'x'; 2561], vec![0xff]] {
            backend.secrets.lock().unwrap().insert(target.clone(), bytes);
            assert_eq!(adapter.read(&target), Err(CredentialError::Failed), "corrupt/unsupported OS secret must fail, not become a native token");
        }
        let before = backend.calls.lock().unwrap().len();
        for secret in [String::new(), "x".repeat(2561)] {
            assert_eq!(adapter.write(&target, &secret), Err(CredentialError::Failed));
        }
        assert_eq!(backend.calls.lock().unwrap().len(), before, "unsupported secret reached OS write");
        let supported = "x".repeat(2560);
        adapter.write(&target, &supported).unwrap();
        assert_eq!(adapter.read(&target).unwrap().as_deref(), Some(supported.as_str()));
    }

    #[test]
    fn native_credential_adapter_keeps_unavailable_and_failure_distinct() {
        let backend = FakeCredentialBackend::default();
        let adapter = NativeCredentialAdapter { backend: &backend };
        let target = format!("qt-music:astral:{}:{}", "a".repeat(64), "b".repeat(32));
        for error in [CredentialError::Unavailable, CredentialError::Failed] {
            *backend.error.lock().unwrap() = Some(error);
            assert_eq!(adapter.read(&target), Err(error));
            assert_eq!(adapter.write(&target, "ERROR_BOUNDARY_CANARY"), Err(error));
            assert_eq!(adapter.delete(&target), Err(error));
        }
        assert!(backend.secrets.lock().unwrap().is_empty());
    }

    type BeforeCredentialWrite = Arc<dyn Fn(&str, &str) + Send + Sync>;

    #[derive(Default)]
    pub(crate) struct FakeCredentialStore {
        pub secrets: Mutex<HashMap<String, String>>,
        pub unavailable: Mutex<bool>,
        pub error: Mutex<Option<CredentialError>>,
        pub reads: Mutex<Vec<String>>,
        pub writes: Mutex<Vec<String>>,
        pub deletes: Mutex<Vec<String>>,
        pub before_write: Mutex<Option<BeforeCredentialWrite>>,
    }

    impl CredentialStore for FakeCredentialStore {
        fn read(&self, target: &str) -> Result<Option<String>, CredentialError> {
            self.reads.lock().unwrap().push(target.into());
            if *self.unavailable.lock().unwrap() { return Err(CredentialError::Unavailable); }
            if let Some(error) = *self.error.lock().unwrap() { return Err(error); }
            Ok(self.secrets.lock().unwrap().get(target).cloned())
        }
        fn write(&self, target: &str, secret: &str) -> Result<(), CredentialError> {
            let observer = self.before_write.lock().unwrap().clone();
            if let Some(observer) = observer { observer(target, secret); }
            self.writes.lock().unwrap().push(target.into());
            if *self.unavailable.lock().unwrap() { return Err(CredentialError::Unavailable); }
            if let Some(error) = *self.error.lock().unwrap() { return Err(error); }
            self.secrets.lock().unwrap().insert(target.into(), secret.into());
            Ok(())
        }
        fn delete(&self, target: &str) -> Result<(), CredentialError> {
            self.deletes.lock().unwrap().push(target.into());
            if *self.unavailable.lock().unwrap() { return Err(CredentialError::Unavailable); }
            if let Some(error) = *self.error.lock().unwrap() { return Err(error); }
            self.secrets.lock().unwrap().remove(target);
            Ok(())
        }
    }

    pub(crate) fn test_db() -> Arc<Database> {
        Arc::new(Database::open(Path::new(":memory:")).unwrap())
    }

    pub(crate) fn stored(db: &Database) -> String {
        db.with(|conn| crate::db::store::get_setting(conn, crate::astral::SETTING_ASTRAL_SESSION))
            .unwrap().unwrap_or_default()
    }

    #[test]
    fn secure_session_writes_only_reference_and_expiry_to_sqlite() {
        let db = test_db();
        let store = Arc::new(FakeCredentialStore::default());
        let vault = SessionVault::new(Some(db.clone()), Path::new("synthetic-root"), "https://backend.invalid", store.clone());
        let handle = vault.persist_new("NATIVE_TOKEN_CANARY", 900_000).unwrap();
        assert_eq!(handle.status.persistence, SessionPersistence::Secure);
        let target = handle.target.as_ref().unwrap();
        assert_eq!(store.read(target).unwrap().as_deref(), Some("NATIVE_TOKEN_CANARY"));
        let raw = stored(&db);
        assert!(!raw.contains("NATIVE_TOKEN_CANARY"), "SQLite must never contain a session token");
        let metadata: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(metadata["credentialTarget"], target.as_str());
        assert_eq!(metadata["expiresAt"], 900_000);
        assert_eq!(metadata["version"], 1);
        assert!(metadata.get("token").is_none());
    }

    #[test]
    fn secure_session_restores_through_adapter_with_tokenless_status() {
        let db = test_db();
        let store = Arc::new(FakeCredentialStore::default());
        let vault = SessionVault::new(Some(db.clone()), Path::new("synthetic-root"), "https://backend.invalid", store.clone());
        let initial = vault.persist_new("RESTORE_TOKEN_CANARY", 900_000).unwrap();
        let restarted = SessionVault::new(Some(db.clone()), Path::new("synthetic-root"), "https://backend.invalid", store.clone());
        let restored = restarted.restore(1).unwrap().expect("secure metadata should restore through credential adapter");
        assert_eq!(restored.token, "RESTORE_TOKEN_CANARY");
        assert_eq!(restored.handle.target, initial.target);
        assert_eq!(serde_json::to_value(restored.handle.status).unwrap(), serde_json::json!({
            "expiresAt": 900_000, "persistence": "secure",
        }));
        assert!(!stored(&db).contains("RESTORE_TOKEN_CANARY"));
        assert_eq!(*store.reads.lock().unwrap(), vec![initial.target.unwrap()]);
    }

    struct TemporaryFixture { root: std::path::PathBuf, path: std::path::PathBuf }
    impl TemporaryFixture {
        fn new() -> Self {
            let root = crate::public_test_fixture::root().canonicalize().unwrap();
            let path = root.join(format!("native-credential-regression-{:016x}", fastrand::u64(..)));
            std::fs::create_dir(&path).unwrap();
            Self { root, path }
        }
    }
    impl Drop for TemporaryFixture {
        fn drop(&mut self) {
            if self.path.parent() == Some(self.root.as_path())
                && self.path.file_name().unwrap().to_string_lossy().starts_with("native-credential-regression-")
                && self.path.canonicalize().ok().as_ref() == Some(&self.path) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
    }

    fn assert_no_file_canary(path: &Path, canary: &str) {
        for path in [path.to_path_buf(), path.with_extension("sqlite-wal"), path.with_extension("sqlite-shm")] {
            if let Ok(bytes) = std::fs::read(path) {
                assert!(!bytes.windows(canary.len()).any(|window| window == canary.as_bytes()), "legacy token survived SQLite cleanup");
            }
        }
    }

    #[test]
    fn manual_export_requires_a_hygienic_native_session_snapshot() {
        let fixture = TemporaryFixture::new();
        let path = fixture.path.join("session.sqlite");
        let db = Arc::new(Database::open(&path).unwrap());
        let store = Arc::new(FakeCredentialStore::default());
        let vault = SessionVault::new(Some(db.clone()), &fixture.path, "https://backend.invalid", store.clone());
        vault.persist_new("SAFE_NATIVE_TOKEN_CANARY", 900_000).unwrap();
        check_session_storage_hygiene(&db).expect("a successfully cleaned secure reference permits backup");
        assert!(store.reads.lock().unwrap().is_empty(), "the backup check must not restore an OS credential");

        let mut outcomes = Vec::new();
        for (case, raw) in [
            ("reinserted raw token", r#"{"token":"REINSERTED_TOKEN_CANARY","expiresAt":900000}"#),
            ("secret hidden in fake metadata", r#"{"version":1,"expiresAt":900000,"credentialTarget":"METADATA_TOKEN_CANARY"}"#),
            ("corrupt session", "BROKEN_NATIVE_SESSION_CANARY"),
        ] {
            db.with(|conn| crate::db::store::set_setting(conn, crate::astral::SETTING_ASTRAL_SESSION, raw)).unwrap();
            outcomes.push((case, check_session_storage_hygiene(&db).is_err()));
            assert_eq!(stored(&db), raw, "eligibility checks must not perform a RAM-changing restore/cleanup");
        }
        db.with(|conn| {
            conn.execute("DELETE FROM settings WHERE key=?1", [crate::astral::SETTING_ASTRAL_SESSION])?;
            conn.execute("DELETE FROM settings WHERE key='astral.secureStorageVersion'", [])?;
            Ok(())
        }).unwrap();
        outcomes.push(("missing cleanup marker", check_session_storage_hygiene(&db).is_err()));
        db.with(|conn| crate::db::store::set_setting(conn, "astral.secureStorageVersion", "2")).unwrap();
        outcomes.push(("unsupported cleanup marker", check_session_storage_hygiene(&db).is_err()));
        db.with(|conn| {
            crate::db::store::set_setting(conn, "astral.secureStorageVersion", "1")?;
            conn.busy_timeout(std::time::Duration::ZERO)?;
            conn.execute_batch("BEGIN IMMEDIATE")
        }).unwrap();
        outcomes.push(("active write transaction", check_session_storage_hygiene(&db).is_err()));
        db.with(|conn| conn.execute_batch("ROLLBACK; PRAGMA wal_checkpoint(TRUNCATE)")).unwrap();

        let reader = rusqlite::Connection::open(&path).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        let _: i64 = reader.query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0)).unwrap();
        db.with(|conn| crate::db::store::set_setting(conn, "diagnostic.public.scratch", "safe")).unwrap();
        outcomes.push(("busy WAL checkpoint", check_session_storage_hygiene(&db).is_err()));
        reader.execute_batch("ROLLBACK").unwrap();
        check_session_storage_hygiene(&db).expect("an empty cleaned session permits backup after the reader releases WAL");
        assert!(store.reads.lock().unwrap().is_empty());
        assert_eq!(store.writes.lock().unwrap().len(), 1);
        assert!(outcomes.iter().all(|(_, rejected)| *rejected), "unsafe backup snapshots were allowed: {outcomes:?}");
    }

    #[test]
    fn failed_cleanup_keeps_backup_blocked_after_reader_unlocks() {
        let fixture = TemporaryFixture::new();
        let path = fixture.path.join("session.sqlite");
        let db = Arc::new(Database::open(&path).unwrap());
        let store = Arc::new(FakeCredentialStore::default());
        let vault = SessionVault::new(Some(db.clone()), &fixture.path, "https://backend.invalid", store.clone());
        vault.persist_new("INITIAL_SECURE_TOKEN_CANARY", 900_000).unwrap();
        db.with(|conn| {
            conn.busy_timeout(std::time::Duration::ZERO)?;
            crate::db::store::set_setting(conn, crate::astral::SETTING_ASTRAL_SESSION,
                r#"{"token":"LOCKED_LEGACY_TOKEN_CANARY","expiresAt":900000}"#)
        }).unwrap();
        let reader = rusqlite::Connection::open(&path).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        let _: i64 = reader.query_row("SELECT COUNT(*) FROM settings", [], |row| row.get(0)).unwrap();
        assert!(vault.restore(1).is_err(), "a pinned WAL must prevent claiming cleanup success");
        assert_eq!(store.writes.lock().unwrap().len(), 1, "failed cleanup must precede any new credential write");
        reader.execute_batch("ROLLBACK").unwrap();
        assert!(check_session_storage_hygiene(&db).is_err(), "a stale success marker must not permit backup after failed cleanup");
        assert!(vault.restore(1).unwrap().is_none());
        check_session_storage_hygiene(&db).expect("backup is allowed only after cleanup successfully retries");
    }

    #[test]
    fn legacy_migration_scrubs_database_and_wal_before_secure_or_memory_only_install() {
        for unavailable in [false, true] {
            let fixture = TemporaryFixture::new();
            let path = fixture.path.join("session.sqlite");
            let db = Arc::new(Database::open(&path).unwrap());
            db.with(|conn| {
                conn.pragma_update(None, "secure_delete", false)?;
                crate::db::store::set_setting(conn, crate::astral::SETTING_ASTRAL_SESSION,
                    &serde_json::json!({ "token": "LEGACY_TOKEN_CANARY", "expiresAt": 900_000 }).to_string())?;
                conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
                Ok(())
            }).unwrap();
            assert!(std::fs::read(&path).unwrap().windows(19).any(|window| window == b"LEGACY_TOKEN_CANARY"));
            let store = Arc::new(FakeCredentialStore::default());
            *store.unavailable.lock().unwrap() = unavailable;
            let observer_db = db.clone();
            let observer_path = path.clone();
            *store.before_write.lock().unwrap() = Some(Arc::new(move |_, _| {
                assert!(!stored(&observer_db).contains("LEGACY_TOKEN_CANARY"));
                assert_no_file_canary(&observer_path, "LEGACY_TOKEN_CANARY");
            }));
            let vault = SessionVault::new(Some(db.clone()), &fixture.path, "https://backend.invalid", store.clone());
            let restored = vault.restore(1).unwrap().expect("valid legacy token must migrate without plaintext fallback");
            assert_eq!(restored.token, "LEGACY_TOKEN_CANARY");
            assert_eq!(restored.handle.status.persistence, if unavailable { SessionPersistence::MemoryOnly } else { SessionPersistence::Secure });
            assert!(!stored(&db).contains("LEGACY_TOKEN_CANARY"));
            assert_no_file_canary(&path, "LEGACY_TOKEN_CANARY");
            assert_eq!(store.writes.lock().unwrap().len(), 1);
            if unavailable { assert!(stored(&db).is_empty()); }
        }
    }
}
