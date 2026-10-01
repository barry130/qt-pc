//! SQLite 存取层（DESIGN §8.3）——按表/场景拆分的域模块集合（P2-7）。
//!
//! 原 `db/store.rs` 是单文件 2615 行，把曲目 / 歌单 / 收藏 / 历史 / 统计 /
//! 下载任务 / 队列（播放现场）/ 设置八套表的读写混在一起，改一处要在一个大文件里
//! 找上下文。这里按域拆成 9 个子模块，本文件只做三件事：声明子模块、把各域条目
//! 原样再导出（`crate::db::store::xxx` 的既有调用路径保持不变）、放跨域共享小工具。
//!
//! 拆分是**机械搬运**：函数体、SQL、事务边界、排序/分页语义与拆分前完全一致；
//! 只动了可见性（两个跨模块 helper 提为 `pub(crate)`）、`use`，
//! 以及 `super::migrations` → `crate::db::migrations` 这类随层级变化的路径。
//!
//! 各域职责：
//! - `tracks`：tracks 表主键口径、在线曲目入库、行 → `Track` 映射；
//! - `local`：本地音乐库（§13）本地曲目与扫描目录；
//! - `likes`：收藏、收藏的云端歌单卡片、离线重放队列、账号切换复位；
//! - `playlists`：自建歌单 / 归属 / 云端确认点 / 「我的歌单」合并视图；
//! - `history`：播放历史；
//! - `stats`：听歌统计；
//! - `downloads`：下载任务；
//! - `session`：播放队列与播放现场存档；
//! - `settings`：settings 键值读写。
//!
//! ## 歌单的唯一定位（DESIGN §5.3 修订）
//! 歌单是唯一的组织单位，收藏不能脱离歌单存在。每个歌单由
//! `(platform, pid)` 二元组全局唯一定位：
//! - `platform = "local"`：本地歌单，`pid` 取 `playlists.id`；
//! - 其余（qq / wyy / kw / kg）：在线收藏的歌单，`pid` 是音源侧 id，
//!   由 `liked_playlists` 的 `UNIQUE(uid, platform, pid)` 兜底。
//!
//! 收藏歌曲用 `liked_songs.pid` 归属到歌单；散装收藏（没指定歌单、
//! 或云端同步回来的）挂在「我喜欢的歌曲」下，即 `("local", "local")`。

pub(crate) mod downloads;
pub(crate) mod history;
pub(crate) mod likes;
pub(crate) mod local;
pub(crate) mod playlists;
pub(crate) mod session;
pub(crate) mod settings;
pub(crate) mod stats;
pub(crate) mod tracks;

// 各域条目原样再导出：`crate::db::store::upsert_tracks` 这类既有调用路径因此保持不变，
// 外部调用点（commands.rs / audio/engine.rs / local.rs …）一行都不用改。
pub(crate) use downloads::*;
pub(crate) use history::*;
pub(crate) use likes::*;
pub(crate) use local::*;
pub(crate) use playlists::*;
pub(crate) use session::*;
pub(crate) use settings::*;
pub(crate) use stats::*;
pub(crate) use tracks::*;

// 播放状态存档类型要能被 `crate::db::PlayState` 拿到（db/mod.rs 有 pub use）。
pub use session::{PlayState, SavedSession};

/// 当前毫秒时间戳（unix epoch）。
///
/// 为什么放在 store/mod.rs 而不是某个域里：队列 / 收藏 / 歌单 / 历史 / 统计 /
/// 下载任务都要写 created_at / updated_at / played_at，它是跨域共享的小工具；
/// 子模块通过 `use super::*` 直接拿到，不必各域各抄一份。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
#[cfg(test)]
mod tests;
