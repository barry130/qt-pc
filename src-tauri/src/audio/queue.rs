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

    // ---------- 队列编辑（DESIGN §11.5 队列 2.0） ----------

    /// 在当前曲目之后插入一首（「下一首播放」）。
    /// 队列为空或尚未定位时退化为追加到队尾。
    pub fn insert_next(&mut self, track: Track) {
        match self.index {
            Some(i) if i < self.tracks.len() => self.tracks.insert(i + 1, track),
            _ => self.tracks.push(track),
        }
    }

    /// 追加到队尾（「加入播放队列」）。不改变当前播放位置。
    pub fn append(&mut self, tracks: Vec<Track>) {
        self.tracks.extend(tracks);
    }

    /// 移除指定下标，并修正当前下标：移除当前曲目之前的项整体前移一位，
    /// 被移除的正好是当前曲目时，下标落到原位置的下一首（播放中的音频不动，
    /// 界面按「接下来播这首」理解）。返回被移除的曲目。
    pub fn remove_at(&mut self, i: usize) -> Option<Track> {
        if i >= self.tracks.len() {
            return None;
        }
        let removed = self.tracks.remove(i);
        self.index = match self.index {
            Some(cur) if cur > i => Some(cur - 1),
            Some(cur) if cur == i => Some(cur),
            other => other,
        };
        self.clamp_index();
        Some(removed)
    }

    /// 拖动排序：把 `from` 位置的曲目移到 `to`。当前曲目跟着走，
    /// 其余受影响的元素整体平移。返回是否真的发生了移动。
    pub fn move_item(&mut self, from: usize, to: usize) -> bool {
        let len = self.tracks.len();
        if from >= len || to >= len || from == to {
            return false;
        }
        let item = self.tracks.remove(from);
        self.tracks.insert(to, item);
        self.index = match self.index {
            Some(cur) if cur == from => Some(to),
            Some(cur) if from < cur && to >= cur => Some(cur - 1),
            Some(cur) if from > cur && to <= cur => Some(cur + 1),
            other => other,
        };
        self.clamp_index();
        true
    }

    /// 清空当前曲目之后的所有曲目（保留当前及之前）。返回移除的数量。
    pub fn clear_after_current(&mut self) -> usize {
        let Some(cur) = self.index else {
            return 0;
        };
        let keep = cur + 1;
        let removed = self.tracks.len().saturating_sub(keep);
        self.tracks.truncate(keep);
        removed
    }

    /// 下标越界时收敛到合法范围；空队列置 None。
    fn clamp_index(&mut self) {
        if self.tracks.is_empty() {
            self.index = None;
            return;
        }
        if let Some(cur) = self.index {
            if cur >= self.tracks.len() {
                self.index = Some(self.tracks.len() - 1);
            }
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

    // ---------- 队列编辑 ----------

    fn track_of(id: &str) -> Track {
        Track {
            id: id.to_string(),
            platform: crate::provider::types::SourceId::Wyy,
            title: id.to_string(),
            singer: String::new(),
            album: String::new(),
            pic_url: String::new(),
            duration: 0.0,
            music_id: None,
        }
    }

    fn ids(q: &Queue) -> Vec<String> {
        q.tracks.iter().map(|t| t.id.clone()).collect()
    }

    #[test]
    fn insert_next_goes_right_after_current() {
        let mut q = queue_of(3);
        q.index = Some(1);
        q.insert_next(track_of("x"));
        assert_eq!(ids(&q), vec!["0", "1", "x", "2"]);
        assert_eq!(q.index, Some(1), "当前曲目下标不变");

        // 队列为空 / 未定位 → 退化为追加
        let mut empty = Queue::default();
        empty.insert_next(track_of("a"));
        assert_eq!(ids(&empty), vec!["a"]);
    }

    #[test]
    fn append_keeps_playback_position() {
        let mut q = queue_of(2);
        q.index = Some(0);
        q.append(vec![track_of("a"), track_of("b")]);
        assert_eq!(ids(&q), vec!["0", "1", "a", "b"]);
        assert_eq!(q.index, Some(0));
    }

    #[test]
    fn remove_before_current_shifts_index() {
        let mut q = queue_of(4);
        q.index = Some(2);
        let removed = q.remove_at(0).expect("移除成功");
        assert_eq!(removed.id, "0");
        assert_eq!(ids(&q), vec!["1", "2", "3"]);
        assert_eq!(q.index, Some(1), "当前曲目前移一位");
    }

    #[test]
    fn remove_current_keeps_slot_then_clamps() {
        let mut q = queue_of(3);
        q.index = Some(2); // 最后一首
        q.remove_at(2);
        assert_eq!(ids(&q), vec!["0", "1"]);
        assert_eq!(q.index, Some(1), "越界收敛到末尾");
    }

    #[test]
    fn remove_everything_clears_index() {
        let mut q = queue_of(2);
        q.index = Some(1);
        q.remove_at(0);
        q.remove_at(0);
        assert!(q.is_empty());
        assert_eq!(q.index, None);
        assert!(q.remove_at(0).is_none(), "越界移除返回 None");
    }

    #[test]
    fn move_item_carries_current_and_shifts_others() {
        let mut q = queue_of(4); // 0 1 2 3
        q.index = Some(2);
        // 把 0 拖到最后：2 变成 1
        assert!(q.move_item(0, 3));
        assert_eq!(ids(&q), vec!["1", "2", "3", "0"]);
        assert_eq!(q.index, Some(1));

        // 拖动当前曲目本身：下标跟着走
        let mut q2 = queue_of(3);
        q2.index = Some(0);
        assert!(q2.move_item(0, 2));
        assert_eq!(ids(&q2), vec!["1", "2", "0"]);
        assert_eq!(q2.index, Some(2));

        // 非法移动
        let mut q3 = queue_of(2);
        assert!(!q3.move_item(0, 0));
        assert!(!q3.move_item(5, 0));
    }

    #[test]
    fn clear_after_current_keeps_prefix() {
        let mut q = queue_of(5);
        q.index = Some(1);
        assert_eq!(q.clear_after_current(), 3);
        assert_eq!(ids(&q), vec!["0", "1"]);
        assert_eq!(q.index, Some(1));
        // 已在末尾 → 不移除
        assert_eq!(q.clear_after_current(), 0);
    }
}
