import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 音效（均衡器/淡入淡出等）。
 *
 * 键前缀 `settings.sound.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 * 均衡器预设名在 `lib/fx.ts` 里仍是中文标识（下拉的 value 必须与它一致），
 * 组件按预设名映射到这里取当前语言的显示文案。
 */
export const messages = defineFragment({
  zh: {
    "settings.sound.loading": "正在读取音效设置…",

    "settings.sound.loudnorm.title": "响度归一化",
    "settings.sound.loudnorm.desc": "按曲目实际响度自动调增益（±12dB），切歌不再忽大忽小",

    "settings.sound.replayGain.title": "ReplayGain 响度",
    "settings.sound.replayGain.desc":
      "按音频文件自带的 ReplayGain 标签补增益：单曲模式逐首对齐，专辑模式保留专辑内的起伏",
    "settings.sound.replayGain.mode": "ReplayGain 响度模式",
    "settings.sound.replayGain.off": "关闭",
    "settings.sound.replayGain.track": "单曲",
    "settings.sound.replayGain.album": "专辑",

    "settings.sound.fade.title": "淡入淡出",
    "settings.sound.fade.desc": "暂停淡出、恢复淡入",

    "settings.sound.spectrum.title": "频谱背景",
    "settings.sound.spectrum.desc": "播放条实时频谱；关闭后不做计算",

    "settings.sound.eq.title": "均衡器",
    "settings.sound.eq.desc": "十段均衡（±12dB），自动防削波",
    "settings.sound.eq.preset": "均衡器预设",
    "settings.sound.eq.custom": "自定义",
    "settings.sound.eq.preamp": "前置放大",
    "settings.sound.eq.bandGain": "{band}Hz 增益",

    "settings.sound.preset.flat": "平直",
    "settings.sound.preset.pop": "流行",
    "settings.sound.preset.rock": "摇滚",
    "settings.sound.preset.classical": "古典",
    "settings.sound.preset.jazz": "爵士",
    "settings.sound.preset.vocal": "人声",
    "settings.sound.preset.bassBoost": "低音增强",
    "settings.sound.preset.electronic": "电子",
  },
  en: {
    "settings.sound.loading": "Reading sound settings…",

    "settings.sound.loudnorm.title": "Loudness normalization",
    "settings.sound.loudnorm.desc":
      "Adjusts gain to each track's actual loudness (±12dB) so volume stays even between tracks",

    "settings.sound.replayGain.title": "ReplayGain loudness",
    "settings.sound.replayGain.desc":
      "Applies gain from the ReplayGain tags in the file: track mode evens out each song, album mode keeps the album's dynamics",
    "settings.sound.replayGain.mode": "ReplayGain loudness mode",
    "settings.sound.replayGain.off": "Off",
    "settings.sound.replayGain.track": "Track",
    "settings.sound.replayGain.album": "Album",

    "settings.sound.fade.title": "Fade",
    "settings.sound.fade.desc": "Fade out on pause, fade in on resume",

    "settings.sound.spectrum.title": "Spectrum background",
    "settings.sound.spectrum.desc": "Live spectrum on the player bar; nothing is computed while off",

    "settings.sound.eq.title": "Equalizer",
    "settings.sound.eq.desc": "10-band EQ (±12dB) with automatic clipping protection",
    "settings.sound.eq.preset": "Equalizer preset",
    "settings.sound.eq.custom": "Custom",
    "settings.sound.eq.preamp": "Preamp",
    "settings.sound.eq.bandGain": "{band}Hz gain",

    "settings.sound.preset.flat": "Flat",
    "settings.sound.preset.pop": "Pop",
    "settings.sound.preset.rock": "Rock",
    "settings.sound.preset.classical": "Classical",
    "settings.sound.preset.jazz": "Jazz",
    "settings.sound.preset.vocal": "Vocal",
    "settings.sound.preset.bassBoost": "Bass Boost",
    "settings.sound.preset.electronic": "Electronic",
  },
});
