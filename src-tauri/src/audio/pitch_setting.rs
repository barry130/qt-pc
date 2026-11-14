//! Global pitch settings use the audio actor's ordering and acknowledge durable writes.
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;

use super::fx::{AudioFx, PITCH_SEMITONES_MAX, PITCH_SEMITONES_MIN};
use crate::db::{store, Database};

pub const SETTING_PITCH_SEMITONES: &str = "fx.pitchSemitones";

pub struct PitchSettingRequest {
    fx: Arc<AudioFx>,
    semitones: i32,
    reply: oneshot::Sender<Result<i32, String>>,
}

pub struct PitchSettingPending {
    reply: oneshot::Receiver<Result<i32, String>>,
}

impl PitchSettingRequest {
    pub(super) fn new(fx: Arc<AudioFx>, semitones: i32) -> (Self, PitchSettingPending) {
        let (reply, receiver) = oneshot::channel();
        (
            Self {
                fx,
                semitones: semitones.clamp(PITCH_SEMITONES_MIN, PITCH_SEMITONES_MAX),
                reply,
            },
            PitchSettingPending { reply: receiver },
        )
    }

    /// The actor and the device-free command driver execute this same transaction.
    pub fn apply(self, db: Option<&Database>) -> Result<i32, String> {
        let result = match db {
            Some(db) => db.with(|conn| {
                store::set_setting(conn, SETTING_PITCH_SEMITONES, &self.semitones.to_string())
            }).map(|_| self.fx.set_pitch_semitones(self.semitones))
                .map_err(|error| format!("升降调设置保存失败: {error}")),
            None => Err(String::from("音频引擎数据库未就绪，升降调设置未保存")),
        };
        let _ = self.reply.send(result.clone());
        result
    }
}

pub(super) fn restore(fx: &AudioFx, db: &Database) -> Result<i32, String> {
    let raw = db.with(|conn| store::get_setting(conn, SETTING_PITCH_SEMITONES))
        .map_err(|error| format!("读取升降调设置失败: {error}"))?;
    let parsed = raw.as_deref().and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0)
        .clamp(PITCH_SEMITONES_MIN, PITCH_SEMITONES_MAX);
    Ok(fx.set_pitch_semitones(parsed))
}

impl PitchSettingPending {
    pub async fn wait(self) -> Result<i32, String> {
        tokio::time::timeout(Duration::from_secs(10), self.reply)
            .await
            .map_err(|_| String::from("升降调设置等待超时"))?
            .map_err(|_| String::from("音频引擎已退出，升降调设置未确认"))?
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::audio::engine::{AudioCmd, AudioDelivery, AudioEngine};
    use crate::db::Database;

    #[tokio::test]
    async fn acknowledged_pitch_is_applied_and_restored_without_changing_transport() {
        let db = Database::open_in_memory().unwrap();
        let (engine, inbox) = AudioEngine::command_channel();
        let before = engine.snapshot();
        let pending = engine.set_pitch(7);
        let delivery = inbox.recv_timeout(Duration::from_secs(1), &mut 0).unwrap();
        let AudioDelivery::Command(AudioCmd::SetPitch(request)) = delivery else {
            panic!("pitch adjustment must travel through the real audio command channel");
        };
        assert_eq!(request.apply(Some(&db)).unwrap(), 7);
        assert_eq!(pending.wait().await.unwrap(), 7);
        assert_eq!(engine.fx_state().pitch_semitones, 7);
        assert_eq!(engine.snapshot().speed, before.speed);
        assert_eq!(engine.snapshot().position_ms, before.position_ms);
        assert_eq!(engine.snapshot().duration_ms, before.duration_ms);
        let (restarted, _) = AudioEngine::command_channel();
        restarted.restore_pitch_setting(&db).unwrap();
        assert_eq!(restarted.fx_state().pitch_semitones, 7);
        assert_eq!(serde_json::to_value(restarted.fx_state()).unwrap()["pitchSemitones"], 7);
    }

    #[tokio::test]
    async fn ordered_pitch_commands_clamp_reset_and_restore_the_last_acknowledged_value() {
        let db = Database::open_in_memory().unwrap();
        let (engine, inbox) = AudioEngine::command_channel();
        let inputs = [i32::MAX, i32::MIN, 4, -3, 0];
        let replies: Vec<_> = inputs.iter().map(|&value| engine.set_pitch(value)).collect();
        let mut load_gen = 0;
        for (&input, pending) in inputs.iter().zip(replies) {
            let AudioDelivery::Command(AudioCmd::SetPitch(request)) =
                inbox.recv_timeout(Duration::from_secs(1), &mut load_gen).unwrap() else {
                    panic!("each setting must retain FIFO actor ordering");
                };
            let expected = input.clamp(-12, 12);
            assert_eq!(request.apply(Some(&db)).unwrap(), expected);
            assert_eq!(pending.wait().await.unwrap(), expected);
            assert_eq!(engine.fx_state().pitch_semitones, expected);
            let (restarted, _) = AudioEngine::command_channel();
            assert_eq!(restarted.restore_pitch_setting(&db).unwrap(), expected);
        }
        assert_eq!(load_gen, 0, "pitch changes must not create a new track load");
    }

    #[tokio::test]
    async fn failed_persistence_preserves_the_applied_pitch_and_reports_failure() {
        let db = Database::open_in_memory().unwrap();
        let (engine, inbox) = AudioEngine::command_channel();
        let pending = engine.set_pitch(3);
        let AudioDelivery::Command(AudioCmd::SetPitch(request)) =
            inbox.recv_timeout(Duration::from_secs(1), &mut 0).unwrap() else { panic!("pitch command"); };
        request.apply(Some(&db)).unwrap();
        pending.wait().await.unwrap();
        db.with(|conn| conn.execute_batch("PRAGMA query_only = ON")).unwrap();
        let pending = engine.set_pitch(-8);
        let AudioDelivery::Command(AudioCmd::SetPitch(request)) =
            inbox.recv_timeout(Duration::from_secs(1), &mut 0).unwrap() else { panic!("pitch command"); };
        assert!(request.apply(Some(&db)).is_err());
        assert!(pending.wait().await.is_err());
        assert_eq!(engine.fx_state().pitch_semitones, 3);
        let (restarted, _) = AudioEngine::command_channel();
        assert_eq!(restarted.restore_pitch_setting(&db).unwrap(), 3);
    }

    #[tokio::test]
    async fn missing_database_does_not_acknowledge_an_unpersisted_adjustment() {
        let (engine, inbox) = AudioEngine::command_channel();
        let pending = engine.set_pitch(8);
        let AudioDelivery::Command(AudioCmd::SetPitch(request)) =
            inbox.recv_timeout(Duration::from_secs(1), &mut 0).unwrap() else { panic!("pitch command"); };
        assert!(request.apply(None).is_err());
        assert!(pending.wait().await.is_err());
        assert_eq!(engine.fx_state().pitch_semitones, 0);
    }

    #[test]
    fn startup_uses_zero_for_missing_or_corrupt_values_and_clamps_old_values() {
        use super::SETTING_PITCH_SEMITONES;
        use crate::db::store;
        let db = Database::open_in_memory().unwrap();
        let (engine, _) = AudioEngine::command_channel();
        assert_eq!(engine.restore_pitch_setting(&db).unwrap(), 0);
        for (value, expected) in [("not-a-number", 0), ("1.5", 0), ("2147483648", 0),
            ("18", 12), ("-19", -12), ("6", 6), ("", 0)] {
            db.with(|conn| store::set_setting(conn, SETTING_PITCH_SEMITONES, value)).unwrap();
            assert_eq!(engine.restore_pitch_setting(&db).unwrap(), expected, "stored {value:?}");
            assert_eq!(engine.fx_state().pitch_semitones, expected);
        }
    }
}
