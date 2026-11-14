//! Native queue ownership through the public Queue and production command/receipt seams.

use std::time::Duration;

use crate::audio::engine::{AudioDelivery, AudioEngine};
use crate::audio::queue::Queue;
use crate::provider::types::{SourceId, Track};

fn track(id: &str) -> Track {
    Track {
        id: id.into(),
        platform: SourceId::new("queue-revision-fixture"),
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
fn replacements_advance_revision_but_playback_cursor_does_not() {
    let mut queue = Queue::default();
    assert_eq!(queue.revision(), 0);
    queue.set(vec![track("A"), track("B")], 0);
    assert_eq!(queue.revision(), 1);
    queue.commit_index(1);
    assert_eq!(queue.current().unwrap().id, "B");
    assert_eq!(queue.revision(), 1, "choosing another queued track is not a new queue");
    queue.set(vec![track("A"), track("B")], 0);
    assert_eq!(ids(&queue), ["A", "B"]);
    assert_eq!(queue.revision(), 2, "even replacing with the same list is a new owner");
}

#[test]
fn structural_edits_invalidate_revision_while_noops_do_not() {
    let mut queue = Queue::default();
    queue.set(vec![track("A"), track("B"), track("C"), track("D")], 1);
    queue.append(vec![track("E"), track("F")]);
    assert_eq!(queue.revision(), 2, "a batch append owns a new structural revision");
    queue.insert_next(track("X"));
    assert_eq!(queue.revision(), 3);
    assert_eq!(queue.remove_at(0).unwrap().id, "A");
    assert_eq!(queue.revision(), 4);
    assert_eq!(queue.remove_indices(&[3, 4, 4, 99]), 2);
    assert_eq!(queue.revision(), 6);
    assert!(queue.move_item(3, 1));
    assert_eq!(queue.revision(), 7);
    assert_eq!(queue.clear_after_current(), 3);
    assert_eq!(queue.revision(), 8);
    let _ = queue.append_or_find(track("G"));
    assert_eq!(queue.revision(), 9);
    let _ = queue.append_or_find(track("B"));
    queue.commit_index(1);
    queue.append(Vec::new());
    assert!(queue.remove_at(99).is_none());
    assert!(!queue.move_item(1, 1));
    assert_eq!(queue.clear_after_current(), 0);
    assert_eq!(ids(&queue), ["B", "G"]);
    assert_eq!(queue.revision(), 9, "selection, dedupe and empty edits retain queue ownership");
    queue.set(Vec::new(), 0);
    assert!(queue.is_empty());
    assert_eq!(queue.revision(), 10, "clearing the queue invalidates old append tickets");
}

#[test]
fn conditional_append_returns_the_applied_revision_and_rejects_an_old_owner() {
    let mut queue = Queue::default();
    queue.set(vec![track("FM-A"), track("FM-B")], 1);
    let rejected = queue.append_if_current(vec![track("wrong-owner")], 0);
    assert!(!rejected.applied);
    assert_eq!(rejected.queue_revision, 1);
    assert_eq!(ids(&queue), ["FM-A", "FM-B"]);

    let accepted = queue.append_if_current(vec![track("FM-C"), track("FM-D")], 1);
    assert!(accepted.applied);
    assert_eq!(accepted.queue_revision, 2);
    assert_eq!(ids(&queue), ["FM-A", "FM-B", "FM-C", "FM-D"]);
    assert_eq!(queue.current().unwrap().id, "FM-B");
    assert_eq!(queue.index, Some(1));
    assert_eq!(serde_json::to_value(accepted).unwrap(),
        serde_json::json!({"applied": true, "queueRevision": 2}));

    let old_owner = queue.append_if_current(vec![track("late-batch")], 1);
    let unsafe_number = queue.append_if_current(vec![track("unsafe-number")], 9_007_199_254_740_992);
    let empty = queue.append_if_current(Vec::new(), 2);
    assert!(!old_owner.applied && !unsafe_number.applied);
    assert_eq!(old_owner.queue_revision, 2);
    assert_eq!(unsafe_number.queue_revision, 2);
    assert!(empty.applied, "an empty accepted batch is a no-op, not a new structural owner");
    assert_eq!(empty.queue_revision, 2);
    assert_eq!(queue.revision(), 2);
    assert_eq!(ids(&queue), ["FM-A", "FM-B", "FM-C", "FM-D"]);
}

#[test]
fn actor_replacements_keep_runtime_revision_and_cursor_actions_reuse_it() {
    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let mut first = engine.send_queue(vec![track("A"), track("B")], 0, None);
    assert!(matches!(inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap(),
        AudioDelivery::Playback(_)));
    assert!(first.try_recv().unwrap().applied);
    assert_eq!(engine.queue_snapshot().revision(), 1);

    let mut replacement = engine.send_queue(vec![track("A"), track("B")], 0, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(replacement.try_recv().unwrap().applied);
    assert_eq!(engine.queue_snapshot().revision(), 2, "a fresh Queue must not reset the runtime counter");

    let mut at = engine.send_play_at(1, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(at.try_recv().unwrap().applied);
    let mut next = engine.send_next(None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(next.try_recv().unwrap().applied);
    let mut existing = engine.send_play_track(track("A"), None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(existing.try_recv().unwrap().applied);
    assert_eq!(engine.queue_snapshot().revision(), 2, "navigation must not expire an FM append owner");

    let mut added = engine.send_play_track(track("C"), None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(added.try_recv().unwrap().applied);
    assert_eq!(engine.queue_snapshot().revision(), 3);
    let mut same_list = engine.send_queue(vec![track("A"), track("B"), track("C")], 2, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(same_list.try_recv().unwrap().applied);
    let queue = engine.queue_snapshot();
    assert_eq!(ids(&queue), ["A", "B", "C"]);
    assert_eq!(queue.current().unwrap().id, "C");
    assert_eq!(queue.revision(), 4);
}

#[tokio::test(flavor = "current_thread")]
async fn queued_conditional_appends_wait_for_actual_apply_and_only_one_owner_wins() {
    use std::future::Future;

    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let mut seed = engine.send_queue(vec![track("FM-A")], 0, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(seed.try_recv().unwrap().applied);
    let before = serde_json::to_value(engine.snapshot()).unwrap();

    let first = engine.append_if_current_with_receipt(vec![track("FM-B"), track("FM-C")], 1);
    let second = engine.append_if_current_with_receipt(vec![track("losing-batch")], 1);
    tokio::pin!(first, second);
    let pending = std::future::poll_fn(|cx| std::task::Poll::Ready(
        first.as_mut().poll(cx).is_pending() && second.as_mut().poll(cx).is_pending(),
    )).await;
    assert!(pending, "channel delivery must not manufacture an accepted append receipt");
    assert_eq!(ids(&engine.queue_snapshot()), ["FM-A"]);
    assert_eq!(engine.queue_snapshot().revision(), 1);
    assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);

    let delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(!matches!(delivery, AudioDelivery::Playback(_)), "append is not a new play/loader action");
    let accepted = first.await.unwrap();
    assert!(accepted.applied);
    assert_eq!(accepted.queue_revision, 2);
    let queue = engine.queue_snapshot();
    assert_eq!(ids(&queue), ["FM-A", "FM-B", "FM-C"]);
    assert_eq!(queue.current().unwrap().id, "FM-A");
    assert_eq!(queue.revision(), 2);
    assert_eq!(engine.snapshot().queue_len, 3);
    assert_eq!(engine.snapshot().queue_index, Some(0));
    assert_eq!(load_gen, 1, "append must not clear or reload the original playing source");
    let accepted_state = serde_json::to_value(engine.snapshot()).unwrap();

    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    let rejected = second.await.unwrap();
    assert!(!rejected.applied);
    assert_eq!(serde_json::to_value(rejected).unwrap(),
        serde_json::json!({"applied": false, "queueRevision": 2}));
    assert_eq!(ids(&engine.queue_snapshot()), ["FM-A", "FM-B", "FM-C"]);
    assert_eq!(engine.queue_snapshot().revision(), 2);
    assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), accepted_state);
    assert_eq!(load_gen, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn an_applied_replacement_rejects_a_late_append_without_touching_b() {
    use std::future::Future;

    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let mut a = engine.send_queue(vec![track("FM-A")], 0, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(a.try_recv().unwrap().applied);
    let mut b = engine.send_queue(vec![track("B")], 0, None);
    let append = engine.append_if_current_with_receipt(vec![track("late-FM")], 1);
    tokio::pin!(append);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        append.as_mut().poll(cx).is_pending(),
    )).await);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(b.try_recv().unwrap().applied);
    let b_state = serde_json::to_value(engine.snapshot()).unwrap();
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    let rejected = append.await.unwrap();
    assert!(!rejected.applied);
    assert_eq!(rejected.queue_revision, 2);
    assert_eq!(ids(&engine.queue_snapshot()), ["B"]);
    assert_eq!(engine.queue_snapshot().revision(), 2);
    assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), b_state);
    assert_eq!(load_gen, 2);
}

#[tokio::test(flavor = "current_thread")]
async fn channel_closure_before_or_after_delivery_never_reports_append_success() {
    use std::future::Future;

    let (closed, inbox) = AudioEngine::command_channel();
    drop(inbox);
    assert!(closed.append_if_current_with_receipt(vec![track("not-delivered")], 0).await.is_err());
    assert!(closed.queue_snapshot().is_empty());
    assert_eq!(closed.queue_snapshot().revision(), 0);

    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let mut seed = engine.send_queue(vec![track("FM-A")], 0, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(seed.try_recv().unwrap().applied);
    let queued = engine.append_if_current_with_receipt(vec![track("queued-but-not-applied")], 1);
    tokio::pin!(queued);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        queued.as_mut().poll(cx).is_pending(),
    )).await);
    drop(inbox);
    assert!(queued.await.is_err(), "successful channel send is not an application receipt");
    assert_eq!(ids(&engine.queue_snapshot()), ["FM-A"]);
    assert_eq!(engine.queue_snapshot().revision(), 1);
    assert_eq!(load_gen, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn an_empty_actor_append_is_an_accepted_noop_with_the_same_owner() {
    use std::future::Future;

    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let mut seed = engine.send_queue(vec![track("FM-A")], 0, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(seed.try_recv().unwrap().applied);
    let before = serde_json::to_value(engine.snapshot()).unwrap();
    let empty = engine.append_if_current_with_receipt(Vec::new(), 1);
    tokio::pin!(empty);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        empty.as_mut().poll(cx).is_pending(),
    )).await);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    let receipt = empty.await.unwrap();
    assert!(receipt.applied);
    assert_eq!(receipt.queue_revision, 1);
    assert_eq!(engine.queue_snapshot().revision(), 1);
    assert_eq!(ids(&engine.queue_snapshot()), ["FM-A"]);
    assert_eq!(serde_json::to_value(engine.snapshot()).unwrap(), before);
    assert_eq!(load_gen, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn restored_queue_keeps_runtime_revision_and_original_paused_seek_target() {
    use std::future::Future;
    use crate::audio::playback_commit::RestoredPlayback;
    use crate::audio::state::PlayMode;

    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let mut clear = engine.send_queue(Vec::new(), 0, None);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    assert!(clear.try_recv().unwrap().applied);
    assert_eq!(engine.queue_snapshot().revision(), 1);
    let restore = engine.restore_after_load(|| async {
        Ok(Some(RestoredPlayback {
            tracks: vec![track("restore-A"), track("restore-B")], index: 1,
            position_ms: 8_123, play_mode: PlayMode::ListLoop, volume: 0.4,
            muted: true, quality: Default::default(),
        }))
    });
    tokio::pin!(restore);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        restore.as_mut().poll(cx).is_pending(),
    )).await);
    let delivery = inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    let plan = match delivery {
        AudioDelivery::Playback(plan) | AudioDelivery::ManualPlayback(plan) => plan,
        _ => panic!("the original restoration must produce its actual playback plan"),
    };
    assert_eq!(plan.start_ms, 8_123);
    assert!(!plan.autoplay);
    assert_eq!(plan.target.as_ref().unwrap().id, "restore-B");
    assert_eq!(plan.queue.revision(), 2);
    let restored = restore.await.unwrap().unwrap();
    assert_eq!(restored.track_id.as_deref(), Some("restore-B"));
    assert_eq!(restored.position_ms, 8_123);
    assert_eq!(engine.queue_snapshot().revision(), 2);
    assert_eq!(ids(&engine.queue_snapshot()), ["restore-A", "restore-B"]);
}

#[tokio::test(flavor = "current_thread")]
async fn play_queue_receipt_contains_its_immutable_actual_revision_not_a_later_queue() {
    use std::future::Future;
    use crate::audio::play_intent::QueueCommitReply;

    let (engine, inbox) = AudioEngine::command_channel();
    let mut load_gen = 0;
    let first = engine.queue_after_filter(vec![track("FM-A")], 0, None, |tracks, index| async move { Ok((tracks, index)) });
    tokio::pin!(first);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        first.as_mut().poll(cx).is_pending(),
    )).await);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    let a = first.await.unwrap();
    assert!(a.applied);
    assert_eq!(serde_json::to_value(&a).unwrap()["queueRevision"], serde_json::json!(1),
        "the actual accepted play_queue receipt must carry the owner revision");
    assert_eq!(a.target.as_ref().unwrap().id, "FM-A");

    let second = engine.queue_after_filter(vec![track("B")], 0, None, |tracks, index| async move { Ok((tracks, index)) });
    tokio::pin!(second);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        second.as_mut().poll(cx).is_pending(),
    )).await);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    let b = second.await.unwrap();
    assert_eq!(b.queue_revision, Some(2));
    assert_eq!(a.queue_revision, Some(1), "the original receipt cannot be rebuilt from B's queue");
    assert_eq!(engine.queue_snapshot().revision(), 2);

    let late = engine.queue_after_filter(vec![track("late-A")], 0, None, |tracks, index| async move { Ok((tracks, index)) });
    tokio::pin!(late);
    assert!(std::future::poll_fn(|cx| std::task::Poll::Ready(
        late.as_mut().poll(cx).is_pending(),
    )).await);
    inbox.recv_timeout(Duration::from_secs(5), &mut load_gen).unwrap();
    engine.begin_play_intent();
    let rejected = late.await.unwrap();
    assert!(!rejected.applied);
    assert!(rejected.queue_revision.is_none(), "a rejected caller receipt never claims accepted ownership");
    assert!(serde_json::to_value(rejected).unwrap().get("queueRevision").is_none());
    let legacy: QueueCommitReply = serde_json::from_value(
        serde_json::json!({"applied": true, "target": null}),
    ).unwrap();
    assert!(legacy.queue_revision.is_none(), "old receipt JSON remains readable");
}
