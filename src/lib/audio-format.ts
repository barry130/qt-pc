/**
 * 本地音频格式的展示规则（评审 F 项：三份格式清单不一致的收敛）。
 *
 * Rust 扫描器（local.rs `SUPPORTED_EXTS`）是「哪些文件能进本地曲库」的唯一
 * 裁决者；这里只按 Rust 通过 IPC 返回的 format 字段判定展示性质，不再按路径
 * 后缀自行猜测（旧清单里的 ape / alac / aiff 实际根本不会被扫描入库）。
 * 契约由 tests/audio-format.test.ts 守护：本表必须是 Rust 支持表的子集。
 */
export const LOSSLESS_FORMATS: ReadonlySet<string> = new Set(["flac", "wav"]);

/** 是否为当前播放器按无损口径展示的本地文件。 */
export function isLosslessAudioFormat(format: string | null | undefined): boolean {
  return (
    format !== undefined && format !== null && LOSSLESS_FORMATS.has(format.toLowerCase())
  );
}
