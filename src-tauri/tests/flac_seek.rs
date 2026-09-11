//! FLAC seek 回归测试（rodio 0.22 + symphonia 0.5.5）。
//!
//! 背景：rodio 0.20 的 `ReadSeekSource` 硬编码 `is_seekable()=true` / `byte_len()=None`，
//! symphonia 的 FLAC demuxer 走二分搜索时第一步就要 `byte_len` → 直接判 `Unseekable`，
//! 进度条拖拽因此失效。rodio 0.22 起 `Decoder::try_from(File)` /
//! `Decoder::builder().with_byte_len()` 会把总字节数透传给 `MediaSource`，定位恢复。
//!
//! fixture 由 ffmpeg 生成：12s / 22050Hz / 单声道正弦，见 tests/fixtures/tone.flac。

use rodio::{Decoder, Source};
use std::time::Duration;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tone.flac");

/// 拉取至多 `n` 个样本，返回实际取到的数量（验证 seek 后解码器仍能出数据）。
fn pull(dec: &mut dyn Source, n: usize) -> usize {
    let mut got = 0;
    for _ in 0..n {
        if dec.next().is_some() {
            got += 1;
        } else {
            break;
        }
    }
    got
}

/// 修复路径：本地文件走 `TryFrom<File>`，byte_len 自动取自文件元数据 → FLAC 可 seek。
#[test]
fn flac_seek_with_byte_len_succeeds() {
    let file = std::fs::File::open(FIXTURE).expect("fixture 存在");
    let mut dec = Decoder::try_from(file).expect("FLAC 解码");
    let total = dec.total_duration().expect("总时长");
    assert!(total >= Duration::from_secs(10), "总时长异常: {total:?}");

    // 前进 seek（进度条右拖）
    dec.try_seek(Duration::from_secs(8)).expect("前进 seek(8s)");
    assert!(pull(&mut dec, 4410) > 0, "前进 seek 后应仍能解出样本");

    // 回退 seek（进度条左拖）
    dec.try_seek(Duration::from_secs(1)).expect("回退 seek(1s)");
    assert!(pull(&mut dec, 4410) > 0, "回退 seek 后应仍能解出样本");
}

/// 反证：精确复刻 rodio 0.20 的 `ReadSeekSource`（is_seekable=true 而 byte_len=None）。
/// symphonia 的 FLAC demuxer 在 `is_seekable()` 为真时走二分搜索，第一步就
/// `byte_len().ok_or(Unseekable)` → 任何拖拽都失败。该断言锁住「修复来自 byte_len 透传」。
#[test]
fn flac_seek_seekable_without_byte_len_is_unseekable() {
    let file = std::fs::File::open(FIXTURE).expect("fixture 存在");
    let mut dec = Decoder::builder()
        .with_data(std::io::BufReader::new(file))
        .with_seekable(true)
        .build()
        .expect("FLAC 解码");
    assert!(
        dec.try_seek(Duration::from_secs(5)).is_err(),
        "is_seekable=true 且 byte_len=None 时应判 Unseekable"
    );
}
