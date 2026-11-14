//! Account FM cancellation through the real public Queue and AudioEngine seams.
//! No device, database, network, or copied queue implementation is involved.

use std::future::Future;
use std::time::Duration;

use crate::audio::engine::{AudioDelivery, AudioEngine};
use crate::audio::queue::Queue;
use crate::audio::state::PlayMode;
use crate::provider::types::{SourceId, Track};

fn track(id: &str) -> Track {
    Track {
        id: id.into(),
        platform: SourceId::new("queue-release-fixture"),
        title: id.into(),
        singer: String::new(),
        album: String::new(),
        pic_url: String::new(),
        duration: 0.0,
        music_id: None,
        recording: Default::default(),
        start_ms: None,
        end_ms: None,
    }
}

fn ids(queue: &Queue) -> Vec<&str> {
    queue.tracks.iter().map(|track| track.id.as_str()).collect()
}

#[test]
fn queue_release_changes_only_identity_and_preserves_next_play_pin() {
    let mut queue = Queue::default();
    assert!(queue.set(vec![track("A"), track("B"), track("C")], 1));
    assert!(queue.insert_next(track("pinned")));
    let tracks = serde_json::to_value(&queue.tracks).unwrap();

    let released = queue.release_if_current(2);
    assert_eq!(serde_json::to_value(released).unwrap(),
        serde_json::json!({"applied": true, "queueRevision": 3}));
    assert_eq!(queue.revision(), 3);
    assert_eq!(serde_json::to_value(&queue.tracks).unwrap(), tracks);
    assert_eq!(queue.index, Some(1));
    assert_eq!(queue.current().unwrap().id, "B");
    assert_eq!(queue.pinned_next_index(), Some(2));
    for mode in [PlayMode::ListLoop, PlayMode::OneLoop, PlayMode::Random] {
        assert_eq!(queue.next_index(mode, true), Some(2));
        assert_eq!(queue.next_index(mode, false), Some(2));
    }

    let stale_append = queue.append_if_current(vec![track("old-account")], 2);
    let repeated = queue.release_if_current(2);
    assert!(!stale_append.applied && !repeated.applied);
    assert_eq!(stale_append.queue_revision, 3);
    assert_eq!(repeated.queue_revision, 3);
    assert_eq!(serde_json::to_value(&queue.tracks).unwrap(), tracks);
    assert_eq!(queue.index, Some(1));
    assert_eq!(queue.pinned_next_index(), Some(2));
}

#[test]
fn queue_release_preserves_the_removed_current_gap() {
    let mut queue = Queue::default();
    assert!(queue.set(vec![track("A"), track("B"), track("C")], 2));
    assert_eq!(queue.remove_at(2).unwrap().id, "C");
    assert_eq!(queue.index, Some(0));
    assert_eq!(queue.next_index(PlayMode::ListLoop, true), Some(0));

    assert!(queue.release_if_current(2).applied);
    assert_eq!(ids(&queue), ["A", "B"]);
    assert_eq!(queue.index, Some(0));
    assert_eq!(queue.next_index(PlayMode::ListLoop, true), Some(0));
    assert!(!queue.append_if_current(vec![track("old-account")], 2).applied);
    assert!(queue.append_if_current(vec![track("new-owner-tail")], 3).applied);
    let next = queue.next_index(PlayMode::ListLoop, true).unwrap();
    assert_eq!(queue.tracks[next].id, "new-owner-tail", "release must not consume the pending tail gap");
}

#[test]
fn queue_release_accepts_zero_empty_owner_and_rejects_stale_or_unsafe_owners() {
    let mut queue = Queue::default();
    let released = queue.release_if_current(0);
    assert!(released.applied);
    assert_eq!(released.queue_revision, 1);
    assert!(queue.is_empty());
    assert_eq!(queue.index, None);
    assert_eq!(queue.pinned_next_index(), None);
    assert!(!queue.append_if_current(vec![track("old-account")], 0).applied);
    for expected in [0, 9_007_199_254_740_992, u64::MAX] {
        let stale = queue.release_if_current(expected);
        assert!(!stale.applied);
        assert_eq!(stale.queue_revision, 1);
    }
    assert_eq!(queue.revision(), 1);
    assert!(queue.is_empty());
    assert_eq!(queue.index, None);
}

#[tokio::test(flavor = "current_thread")]
async fn queued_append_loses_to_direct_release_before_actor_commit() {
    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let mut seed = engine.send_queue(vec![track("FM-A"), track("FM-B")], 1, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(seed.try_recv().unwrap().applied);
    let state = serde_json::to_value(engine.snapshot()).unwrap();
    let tracks = serde_json::to_value(engine.queue_snapshot().tracks).unwrap();

    let append = engine.append_if_current_with_receipt(vec![track("old-account")], 1);
    tokio::pin!(append);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        append.as_mut().poll(cx).is_pending(),
    )).await, "the append has reached native IPC but has not compared or committed");

    // Do not receive the queued append until the command-thread release has returned.
    let released = engine.release_queue_if_current(1);
    assert!(released.applied);
    assert_eq!(released.queue_revision, 2);
    assert_eq!(engine.queue_snapshot().revision(), 2);
    assert_eq!(serde_json::to_value(engine.queue_snapshot().tracks).unwrap(), tracks);
    assert_eq!(engine.queue_snapshot().index, Some(1));
    assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), state);
    assert_eq!(load_gen, 1);

    assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap(),
        AudioDelivery::QueueEdit { changed: false }));
    let rejected = append.await.unwrap();
    assert_eq!(serde_json::to_value(rejected).unwrap(),
        serde_json::json!({"applied": false, "queueRevision": 2}));
    assert_eq!(serde_json::to_value(engine.queue_snapshot().tracks).unwrap(), tracks);
    assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), state);
    assert_eq!(load_gen, 1, "release and rejected append must not start or cancel a loader");
    assert!(matches!(inbox.recv_timeout(Duration::ZERO, &mut load_gen),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)), "release must not enqueue an actor command");
}

#[tokio::test(flavor = "current_thread")]
async fn committed_append_survives_release_before_its_receipt_is_read() {
    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let mut seed = engine.send_queue(vec![track("FM-A")], 0, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(seed.try_recv().unwrap().applied);

    let append = engine.append_if_current_with_receipt(vec![track("committed")], 1);
    tokio::pin!(append);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        append.as_mut().poll(cx).is_pending(),
    )).await);
    assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap(),
        AudioDelivery::QueueEdit { changed: true }));
    let committed_state = serde_json::to_value(engine.snapshot()).unwrap();

    let stale = engine.release_queue_if_current(1);
    assert!(!stale.applied);
    assert_eq!(stale.queue_revision, 2);
    let accepted = append.await.unwrap();
    assert!(accepted.applied);
    assert_eq!(accepted.queue_revision, 2);
    assert_eq!(ids(&engine.queue_snapshot()), ["FM-A", "committed"]);
    assert_eq!(engine.queue_snapshot().revision(), 2);
    assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), committed_state);
    assert_eq!(load_gen, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn stale_release_and_append_cannot_change_a_manual_replacement() {
    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let mut seed = engine.send_queue(vec![track("FM-A")], 0, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(seed.try_recv().unwrap().applied);
    let mut replacement = engine.send_queue(vec![track("manual-B"), track("manual-C")], 1, None);
    let append = engine.append_if_current_with_receipt(vec![track("old-account")], 1);
    tokio::pin!(append);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        append.as_mut().poll(cx).is_pending(),
    )).await);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(replacement.try_recv().unwrap().applied);
    let state = serde_json::to_value(engine.snapshot()).unwrap();

    let stale = engine.release_queue_if_current(1);
    assert!(!stale.applied);
    assert_eq!(stale.queue_revision, 2);
    assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap(),
        AudioDelivery::QueueEdit { changed: false }));
    assert!(!append.await.unwrap().applied);
    assert_eq!(ids(&engine.queue_snapshot()), ["manual-B", "manual-C"]);
    assert_eq!(engine.queue_snapshot().index, Some(1));
    assert_eq!(engine.queue_snapshot().revision(), 2);
    assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), state);
    assert_eq!(load_gen, 2);
}

#[test]
fn direct_release_preserves_a_pending_play_intent_and_empty_playback_state() {
    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let state = serde_json::to_value(engine.snapshot()).unwrap();
    let intent = engine.begin_play_intent();
    let mut play = engine.send_queue(vec![track("manual")], 0, Some(intent));

    let released = engine.release_queue_if_current(0);
    assert!(released.applied);
    assert_eq!(released.queue_revision, 1);
    assert!(engine.queue_snapshot().is_empty());
    assert_eq!(engine.queue_snapshot().index, None);
    assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), state);
    assert_eq!(load_gen, 0);

    assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap(),
        AudioDelivery::Playback(_)));
    let accepted = play.try_recv().unwrap();
    assert!(accepted.applied, "identity release is not play-intent cancellation");
    assert_eq!(accepted.queue_revision, Some(2));
    assert_eq!(ids(&engine.queue_snapshot()), ["manual"]);
    assert_eq!(load_gen, 1);
}
