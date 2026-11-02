import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 通用（默认播放器、链接唤起、开机自启、缓存与清理）。
 *
 * 键前缀 `settings.general.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 */
export const messages = defineFragment({
  zh: {
    // 播放缓存上限档位
    "settings.general.cache.unlimited": "不限",
    "settings.general.cache.custom": "自定义",
    "settings.general.cache.errorNonNegative": "缓存上限需为非负整数（MB，0 = 不限）",
    "settings.general.cache.errorTooLarge": "缓存上限最大 {max} MB",

    // 进程内临时缓存分项
    "settings.general.runtime.playUrl.label": "播放地址",
    "settings.general.runtime.playUrl.desc":
      "各平台解析出的播放链接与「某张专辑只能出到哪一档」的记录，清除后下次播放重新取链",
    "settings.general.runtime.sourceCandidates.label": "换源候选",
    "settings.general.runtime.sourceCandidates.desc": "换源弹层中的临时搜索结果",
    "settings.general.runtime.lyricCandidates.label": "歌词候选",
    "settings.general.runtime.lyricCandidates.desc":
      "歌词搜索候选与当前播放页歌词缓存；不删除已保存歌词",
    "settings.general.runtime.chartDetails.label": "榜单详情",
    "settings.general.runtime.chartDetails.desc": "首页与榜单页的临时榜单曲目列表",
    "settings.general.runtime.pageResults.label": "列表结果",
    "settings.general.runtime.pageResults.desc":
      "歌手 ID、歌手头像、全量分页与本地曲目在线元数据缓存",

    // 日志级别
    "settings.general.logLevel.debug": "调试",
    "settings.general.logLevel.info": "信息",
    "settings.general.logLevel.warn": "警告",
    "settings.general.logLevel.error": "错误",

    // 默认播放器（文件关联）
    "settings.general.fileAssociation.title": "默认播放器",
    "settings.general.fileAssociation.desc":
      "关联 MP3 / FLAC / WAV / OGG / M4A；取消关联前请先改选其他播放器",
    "settings.general.fileAssociation.currentDefault": "当前默认：{list}",
    "settings.general.listSeparator": "、",
    "settings.general.fileAssociation.setDefault": "设为默认",
    "settings.general.fileAssociation.unassociate": "取消关联",

    // 链接唤起
    "settings.general.uriScheme.title": "链接唤起",
    "settings.general.uriScheme.desc":
      "quietmusic:// 链接直接播放本地文件；只写当前用户的注册表，不需要管理员，也不改系统默认程序",
    "settings.general.uriScheme.registered": "当前已注册，链接可直接打开",
    "settings.general.uriScheme.register": "注册链接",
    "settings.general.uriScheme.unregister": "取消注册",

    // 开机自启
    "settings.general.autostart.title": "开机自启",
    "settings.general.autostart.desc": "开机自动启动，最小化到托盘",

    // 播放缓存上限
    "settings.general.cacheLimit.title": "播放缓存上限",
    "settings.general.cacheLimit.descWithStats":
      "边下边播；超出上限清理最旧。当前 {size} · {count} 个文件",
    "settings.general.cacheLimit.desc": "边下边播；超出上限自动清理最旧",

    // 缓存位置
    "settings.general.cacheDir.title": "缓存位置",
    "settings.general.cacheDir.desc": "默认在安装目录 cache；换盘后旧缓存不会自动搬移",

    // 清理缓存
    "settings.general.clear.title": "清理缓存",
    "settings.general.clear.descWithStats":
      "只清可再生缓存：播放 {size} / 图片 {webSize}；不动下载、登录、设置与已保存歌词",
    "settings.general.clear.desc": "只清可再生缓存；不动下载、登录、设置与已保存歌词",
    "settings.general.clear.audio": "播放",
    "settings.general.clear.images": "图片",
    "settings.general.clear.statsHint": "累计时长、日榜与最近播放一起归零，不可恢复",
    "settings.general.clear.stats": "听歌统计",
    "settings.general.clear.selectNone": "全不选",
    "settings.general.clear.selectAll": "全选",
    "settings.general.clear.clearing": "清理中…",
    "settings.general.clear.confirmAgain": "再点一次确认清除",
    "settings.general.clear.action": "清理",
    "settings.general.clear.footnote":
      "听歌统计不可再生，需点两次确认；想留底可先「导出备份」",
    "settings.general.clear.empty": "没有可清理的内容",
    "settings.general.clear.runtimeNote": "，进程内缓存 {n} 项",
    "settings.general.clear.statsNote": "；听歌统计 {n} 首已归零",
    "settings.general.clear.done": "已清理 {freed}{summary}{stats}",
    "settings.general.clear.doneSkipped":
      "已清理 {freed}{summary}{stats}；{failed} 个文件被占用跳过（正在播放的不会删）",

    // 数据备份
    "settings.general.backup.title": "数据备份",
    "settings.general.backup.descWithDir":
      "歌单、收藏、播放记录、设置与歌词；不含音乐文件本体。上次导出到 {dir}",
    "settings.general.backup.desc": "歌单、收藏、播放记录、设置与歌词；不含音乐文件本体",
    "settings.general.backup.exporting": "处理中…",
    "settings.general.backup.export": "导出备份",
    "settings.general.backup.import": "从备份导入",
    "settings.general.backup.selected": "已选：{path}",
    "settings.general.backup.merge": "合并导入",
    "settings.general.backup.replace": "覆盖导入",
    "settings.general.backup.modeHint": "合并＝只补缺的记录；覆盖＝整体替换（自动快照）",
    "settings.general.backup.pickFolder": "选择备份保存目录",
    "settings.general.backup.exported":
      "已导出备份：曲目 {tracks} / 歌单 {playlists} / 记录 {history}",
    "settings.general.backup.importedMerge":
      "已合并导入：写入 {rows} 行（曲目 {tracks} / 歌单 {playlists}）",
    "settings.general.backup.importedReplace":
      "已覆盖导入：写入 {rows} 行（曲目 {tracks} / 歌单 {playlists}）",
    "settings.general.backup.snapshot": "导入前的数据已快照到 {path}",
    "settings.general.backup.refreshHint": "界面数据会在切换页面后刷新",

    // 诊断日志
    "settings.general.log.title": "诊断日志",
    "settings.general.log.descWithDir": "日志保存在本机（{dir}），反馈问题时附上{note}",
    "settings.general.log.defaultDir": "默认目录",
    "settings.general.log.notWritable": "；当前目录不可写，日志只到控制台",
    "settings.general.log.desc": "日志保存在本机，反馈问题时附上",
    "settings.general.log.openFolder": "打开文件夹",
    "settings.general.log.level.title": "日志级别",
    "settings.general.log.level.desc":
      "调试最详细、错误最少；默认为{level}，改动立即生效",
    "settings.general.log.fileSize.title": "日志文件大小",
    "settings.general.log.fileSize.desc":
      "单个文件上限（{min}–{max} MB），写满自动换新文件",
    "settings.general.log.backups.title": "日志保留份数",
    "settings.general.log.backups.desc": "最多保留 {min}–{max} 个，超出删最旧",
    "settings.general.log.backups.suffix": "个",
  },
  en: {
    "settings.general.cache.unlimited": "Unlimited",
    "settings.general.cache.custom": "Custom",
    "settings.general.cache.errorNonNegative":
      "Cache limit must be a non-negative integer (MB; 0 = unlimited)",
    "settings.general.cache.errorTooLarge": "Cache limit can't exceed {max} MB",

    "settings.general.runtime.playUrl.label": "Playback URLs",
    "settings.general.runtime.playUrl.desc":
      "Resolved playback links for each platform plus each album's maximum quality tier; cleared links are fetched again on next play",
    "settings.general.runtime.sourceCandidates.label": "Source candidates",
    "settings.general.runtime.sourceCandidates.desc":
      "Temporary search results in the switch-source panel",
    "settings.general.runtime.lyricCandidates.label": "Lyric candidates",
    "settings.general.runtime.lyricCandidates.desc":
      "Lyric search candidates and the current playing page's lyric cache; saved lyrics aren't deleted",
    "settings.general.runtime.chartDetails.label": "Chart details",
    "settings.general.runtime.chartDetails.desc":
      "Temporary chart track lists on the home and charts pages",
    "settings.general.runtime.pageResults.label": "List results",
    "settings.general.runtime.pageResults.desc":
      "Cached artist IDs, artist avatars, full paginated results, and online metadata for local tracks",

    "settings.general.logLevel.debug": "Debug",
    "settings.general.logLevel.info": "Info",
    "settings.general.logLevel.warn": "Warning",
    "settings.general.logLevel.error": "Error",

    "settings.general.fileAssociation.title": "Default player",
    "settings.general.fileAssociation.desc":
      "Associates MP3 / FLAC / WAV / OGG / M4A; pick another player before removing the association",
    "settings.general.fileAssociation.currentDefault": "Current default: {list}",
    "settings.general.listSeparator": ", ",
    "settings.general.fileAssociation.setDefault": "Set as default",
    "settings.general.fileAssociation.unassociate": "Remove association",

    "settings.general.uriScheme.title": "Link handling",
    "settings.general.uriScheme.desc":
      "quietmusic:// links play local files directly; writes only to the current user's registry, with no admin rights and no change to the system defaults",
    "settings.general.uriScheme.registered": "Registered — links can open directly",
    "settings.general.uriScheme.register": "Register links",
    "settings.general.uriScheme.unregister": "Unregister",

    "settings.general.autostart.title": "Launch at startup",
    "settings.general.autostart.desc": "Start automatically at login, minimized to the tray",

    "settings.general.cacheLimit.title": "Playback cache limit",
    "settings.general.cacheLimit.descWithStats":
      "Stream while downloading; the oldest entries are cleared past the limit. Currently {size} · {count} files",
    "settings.general.cacheLimit.desc":
      "Stream while downloading; the oldest entries are cleared automatically past the limit",

    "settings.general.cacheDir.title": "Cache location",
    "settings.general.cacheDir.desc":
      "Defaults to the cache folder in the install directory; existing cache isn't moved when you change drives",

    "settings.general.clear.title": "Clear cache",
    "settings.general.clear.descWithStats":
      "Clears only regenerable cache: audio {size} / images {webSize}. Downloads, sign-in, settings and saved lyrics are untouched",
    "settings.general.clear.desc":
      "Clears only regenerable cache. Downloads, sign-in, settings and saved lyrics are untouched",
    "settings.general.clear.audio": "Audio",
    "settings.general.clear.images": "Images",
    "settings.general.clear.statsHint":
      "Resets total listening time, daily charts and recent plays — this can't be undone",
    "settings.general.clear.stats": "Listening stats",
    "settings.general.clear.selectNone": "Deselect all",
    "settings.general.clear.selectAll": "Select all",
    "settings.general.clear.clearing": "Clearing…",
    "settings.general.clear.confirmAgain": "Click again to confirm",
    "settings.general.clear.action": "Clear",
    "settings.general.clear.footnote":
      "Listening stats can't be regenerated, so clearing takes two clicks. To keep a copy, export a backup first",
    "settings.general.clear.empty": "Nothing to clear",
    "settings.general.clear.runtimeNote": ", {n} in-memory cache entries",
    "settings.general.clear.statsNote": "; {n} tracks' listening stats reset",
    "settings.general.clear.done": "Cleared {freed}{summary}{stats}",
    "settings.general.clear.doneSkipped":
      "Cleared {freed}{summary}{stats}; skipped {failed} files in use (files being played aren't deleted)",

    "settings.general.backup.title": "Data backup",
    "settings.general.backup.descWithDir":
      "Playlists, favorites, play history, settings and lyrics; music files aren't included. Last exported to {dir}",
    "settings.general.backup.desc":
      "Playlists, favorites, play history, settings and lyrics; music files aren't included",
    "settings.general.backup.exporting": "Working…",
    "settings.general.backup.export": "Export backup",
    "settings.general.backup.import": "Import from backup",
    "settings.general.backup.selected": "Selected: {path}",
    "settings.general.backup.merge": "Merge",
    "settings.general.backup.replace": "Overwrite",
    "settings.general.backup.modeHint":
      "Merge adds only missing records; overwrite replaces everything and takes a snapshot automatically",
    "settings.general.backup.pickFolder": "Choose a folder to save the backup",
    "settings.general.backup.exported":
      "Backup exported: {tracks} tracks / {playlists} playlists / {history} history entries",
    "settings.general.backup.importedMerge":
      "Merged backup: {rows} rows written ({tracks} tracks / {playlists} playlists)",
    "settings.general.backup.importedReplace":
      "Overwrote with backup: {rows} rows written ({tracks} tracks / {playlists} playlists)",
    "settings.general.backup.snapshot": "Data before import was snapshotted to {path}",
    "settings.general.backup.refreshHint": "The interface data refreshes after you switch pages",

    "settings.general.log.title": "Diagnostic logs",
    "settings.general.log.descWithDir":
      "Logs are stored locally ({dir}); include them when reporting a problem{note}",
    "settings.general.log.defaultDir": "default folder",
    "settings.general.log.notWritable":
      "; the current folder isn't writable, so logs only go to the console",
    "settings.general.log.desc":
      "Logs are stored locally; include them when reporting a problem",
    "settings.general.log.openFolder": "Open folder",
    "settings.general.log.level.title": "Log level",
    "settings.general.log.level.desc":
      "Debug is most detailed, error least; the default is {level}. Changes apply immediately",
    "settings.general.log.fileSize.title": "Log file size",
    "settings.general.log.fileSize.desc":
      "Per-file limit ({min}–{max} MB); a new file starts when full",
    "settings.general.log.backups.title": "Log files kept",
    "settings.general.log.backups.desc":
      "Keeps {min}–{max} files; the oldest are deleted past that",
    "settings.general.log.backups.suffix": "files",
  },
});
