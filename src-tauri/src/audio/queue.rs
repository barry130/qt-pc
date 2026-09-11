//! 播放队列与模式推进逻辑（DESIGN §7.2 / §12.1）。
//!
//! 纯函数 + 数据结构，不依赖 IO；引擎线程独占持有（单线程无锁）。
//! 语义约定：
//! - 自然播完（auto）：Sequence 末尾停止；ListLoop 循环；OneLoop 重播当前；Random 随机换曲
//! - 手动 next / previous：均按列表顺序移动并循环（OneLoop 也不例外），
//!   仅 Random 随机挑一首不同的曲子

use crate::provider::types::Track;

use super::state::PlayMode;

#[derive(Debug, Clone, Default)]
pub struct Queue {
    pub tracks: Vec<Track>,
    /// 当前曲目下标；None 表示未在播放
    pub index: Option<usize>,
}

impl Queue {
    pub fn set(&mut self, tracks: Vec<Track>, index: usize) {
        self.tracks = tracks;
        self.index = if self.tracks.is_empty() {
            None
        } else {
            Some(index.min(self.tracks.len() - 1))
        };
    }

    pub fn current(&self) -> Option<&Track> {
        self.tracks.get(self.index?)
    }

    pub fn len(&self) -> usize {
        self.tracks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }

    /// 计算下一首下标。`auto` = 自然播完触发；否则视为手动操作。
    /// 返回 None 表示无下一首（保持现状）。
    pub fn next_index(&self, mode: PlayMode, auto: bool) -> Option<usize> {
        let len = self.tracks.len();
        let cur = self.index?;
        if len == 0 {
            return None;
        }
        if len == 1 {
            // 单曲队列：OneLoop 自然播完重播；手动/其他模式重播（无别的可去）
            return Some(0);
        }
        match mode {
            PlayMode::OneLoop if auto => Some(cur),
            PlayMode::Random => {
                // 随机挑一首与当前不同的
                let mut pick = cur;
                while pick == cur {
                    pick = fastrand::usize(..len);
                }
                Some(pick)
            }
            _ => {
                let next = cur + 1;
                if next < len {
                    Some(next)
                } else if auto {
                    match mode {
                        PlayMode::Sequence => None, // 顺序播放到末尾即停
                        // ListLoop / OneLoop(手动) 循环回开头
                        _ => Some(0),
                    }
                } else {
                    // 手动 next：循环回开头（Sequence 也允许手动绕回，与移动端一致）
                    Some(0)
                }
            }
        }
    }

    /// 上一首下标（手动操作语义）：循环回末尾；Random 随机挑不同的
    pub fn previous_index(&self, mode: PlayMode) -> Option<usize> {
        let len = self.tracks.len();
        let cur = self.index?;
        if len == 0 {
            return None;
        }
        if len == 1 {
            return Some(0);
        }
        match mode {
            PlayMode::Random => {
                let mut pick = cur;
                while pick == cur {
                    pick = fastrand::usize(..len);
                }
                Some(pick)
            }
            _ => Some(if cur == 0 { len - 1 } else { cur - 1 }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue_of(n: usize) -> Queue {
        let tracks: Vec<Track> = (0..n)
            .map(|i| Track {
                id: i.to_string(),
                platform: crate::provider::types::SourceId::Wyy,
                title: format!("t{i}"),
                singer: String::new(),
                album: String::new(),
                pic_url: String::new(),
                duration: 0.0,
                music_id: None,
            })
            .collect();
        Queue { tracks, index: Some(0) }
    }

    #[test]
    fn sequence_auto_stops_at_end() {
        let mut q = queue_of(3);
        q.index = Some(2);
        assert_eq!(q.next_index(PlayMode::Sequence, true), None);
        q.index = Some(0);
        assert_eq!(q.next_index(PlayMode::Sequence, true), Some(1));
    }

    #[test]
    fn list_loop_auto_wraps() {
        let mut q = queue_of(3);
        q.index = Some(2);
        assert_eq!(q.next_index(PlayMode::ListLoop, true), Some(0));
    }

    #[test]
    fn one_loop_auto_replays_manual_advances() {
        let mut q = queue_of(3);
        q.index = Some(1);
        assert_eq!(q.next_index(PlayMode::OneLoop, true), Some(1));
        assert_eq!(q.next_index(PlayMode::OneLoop, false), Some(2));
    }

    #[test]
    fn manual_next_wraps_even_in_sequence() {
        let mut q = queue_of(3);
        q.index = Some(2);
        assert_eq!(q.next_index(PlayMode::Sequence, false), Some(0));
    }

    #[test]
    fn manual_previous_wraps_to_end() {
        let mut q = queue_of(3);
        q.index = Some(0);
        assert_eq!(q.previous_index(PlayMode::Sequence), Some(2));
        q.index = Some(1);
        assert_eq!(q.previous_index(PlayMode::Sequence), Some(0));
    }

    #[test]
    fn random_picks_different_track() {
        let mut q = queue_of(5);
        q.index = Some(2);
        for _ in 0..20 {
            let n = q.next_index(PlayMode::Random, true).unwrap();
            assert_ne!(n, 2);
            let p = q.previous_index(PlayMode::Random).unwrap();
            assert_ne!(p, 2);
        }
    }

    #[test]
    fn single_track_queue_always_replays() {
        let q = queue_of(1);
        assert_eq!(q.next_index(PlayMode::Sequence, true), Some(0));
        assert_eq!(q.previous_index(PlayMode::ListLoop), Some(0));
    }

    #[test]
    fn empty_queue_and_unset_index_return_none() {
        let q = Queue::default();
        assert_eq!(q.next_index(PlayMode::ListLoop, true), None);
        assert_eq!(q.previous_index(PlayMode::ListLoop), None);
        let mut q = queue_of(3);
        q.index = None;
        assert_eq!(q.next_index(PlayMode::ListLoop, true), None);
    }

    #[test]
    fn set_clamps_index() {
        let mut q = queue_of(3);
        q.set(q.tracks.clone(), 99);
        assert_eq!(q.index, Some(2));
    }
}
