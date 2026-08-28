//! The edit itself, owned by the engine.
//!
//! `desktop/src/lib/project.ts` held a provisional copy of this model while
//! the engine had no project API; this crate is that API. The model
//! ([`model`]), every operation as a serialisable [`commands::Command`], the
//! tolerant document reader and compatible writer ([`doc`]), and the undo
//! stack ([`editor::Editor`]) - all headless, all testable without a window.
//!
//! Two compatibility guarantees hold while the UI migrates:
//!
//! 1. **Documents are interchangeable.** A `relay.json` written by either
//!    side loads in the other, tolerance rules included.
//! 2. **Operations mean the same thing.** The command semantics are ports of
//!    the TS operations, clamp for clamp - which is what makes flipping the
//!    UI onto this crate a mechanical change rather than a behavioural one.
//!
//! Deliberately a separate crate rather than part of `relay-core`: the
//! document model needs serde, and relay-core's zero-dependency rule is worth
//! more than the adjacency.

pub mod commands;
pub mod doc;
pub mod editor;
pub mod model;

pub use commands::{Command, Outcome, why_not_merge};
pub use doc::{DocumentSettings, from_document, to_document};
pub use editor::Editor;
pub use model::Project;

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::commands::{ClipMove, ClipPatch, Command, TrimEdge};
    use crate::doc::DocumentSettings;
    use crate::editor::Editor;
    use crate::model::{ClipKind, MediaKind, TextStyle};

    fn media(path: &str, duration: f64, has_audio: bool) -> Command {
        Command::AddMedia {
            item: crate::commands::NewMedia {
                path: path.to_owned(),
                name: path.rsplit('/').next().unwrap_or(path).to_owned(),
                duration: Some(duration),
                kind: MediaKind::Video,
                width: Some(1920),
                height: Some(1080),
                frame_rate: Some(30.0),
                frame_rate_fraction: Some("30/1".to_owned()),
                video_codec: Some("h264".to_owned()),
                audio_codec: has_audio.then(|| "aac".to_owned()),
                has_audio,
            },
        }
    }

    fn settings() -> DocumentSettings {
        DocumentSettings {
            name: "Test".to_owned(),
            width: 1920,
            height: 1080,
            rate_num: 30,
            rate_den: 1,
        }
    }

    /// Editor with one media item and one clip at [0, 10) on track one.
    fn fixture() -> (Editor, String, String) {
        let mut editor = Editor::new();
        let media_id =
            editor.apply(media("/a.mp4", 10.0, true)).expect("adds").created_id.expect("id");
        let track_id = editor.project().active().tracks[0].id.clone();
        let clip_id = editor
            .apply(Command::AddClip { media_id: media_id.clone(), track_id, start: 0.0 })
            .expect("adds")
            .created_id
            .expect("id");
        (editor, media_id, clip_id)
    }

    #[test]
    fn a_new_project_has_one_timeline_and_four_lanes() {
        let editor = Editor::new();
        assert_eq!(editor.project().timelines.len(), 1);
        assert_eq!(editor.project().active().tracks.len(), 4);
    }

    #[test]
    fn duplicate_media_paths_are_ignored() {
        let mut editor = Editor::new();
        editor.apply(media("/a.mp4", 10.0, true)).expect("adds");
        editor.apply(media("/a.mp4", 10.0, true)).expect("no-op");
        assert_eq!(editor.project().media.len(), 1);
    }

    #[test]
    fn split_produces_source_continuous_halves_and_merge_rejoins_them() {
        let (mut editor, _, clip_id) = fixture();
        editor
            .apply(Command::SplitClips { clip_ids: vec![clip_id.clone()], time: 4.0 })
            .expect("splits");

        let clips = &editor.project().active().clips;
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0].duration, 4.0);
        assert_eq!(clips[1].start, 4.0);
        assert_eq!(clips[1].source_start, 4.0);

        let ids: Vec<String> = clips.iter().map(|clip| clip.id.clone()).collect();
        editor.apply(Command::MergeClips { clip_ids: ids }).expect("merges");
        let clips = &editor.project().active().clips;
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].duration, 10.0);
        assert_eq!(clips[0].id, clip_id, "the first piece keeps its identity");
    }

    #[test]
    fn rearranged_pieces_refuse_to_merge() {
        let (mut editor, _, clip_id) = fixture();
        editor
            .apply(Command::SplitClips { clip_ids: vec![clip_id.clone()], time: 4.0 })
            .expect("splits");
        let tail_id = editor.project().active().clips[1].id.clone();
        let track_id = editor.project().active().tracks[0].id.clone();
        // Swap the two pieces on the timeline: adjacent, but out of order.
        editor
            .apply(Command::MoveClips {
                moves: vec![
                    ClipMove { clip_id: clip_id.clone(), start: 6.0, track_id: track_id.clone() },
                    ClipMove { clip_id: tail_id.clone(), start: 0.0, track_id },
                ],
            })
            .expect("moves");
        let refused = editor.apply(Command::MergeClips { clip_ids: vec![tail_id, clip_id] });
        assert!(refused.unwrap_err().contains("no longer in their original order"));
    }

    #[test]
    fn a_head_trim_moves_the_in_point_with_speed() {
        let (mut editor, _, clip_id) = fixture();
        editor.apply(Command::SetClipSpeed { clip_id: clip_id.clone(), speed: 2.0 }).expect("ok");
        // 10s of source at 2x occupies 5s of timeline.
        assert_eq!(editor.project().active().clips[0].duration, 5.0);
        editor
            .apply(Command::TrimClip { clip_id, edge: TrimEdge::Start, delta: 1.0 })
            .expect("trims");
        let clip = &editor.project().active().clips[0];
        assert_eq!(clip.start, 1.0);
        assert_eq!(clip.duration, 4.0);
        assert_eq!(clip.source_start, 2.0, "a timeline second covers two source seconds");
    }

    #[test]
    fn speed_clamps_to_the_engine_range() {
        let (mut editor, _, clip_id) = fixture();
        editor.apply(Command::SetClipSpeed { clip_id: clip_id.clone(), speed: 100.0 }).expect("ok");
        assert_eq!(editor.project().active().clips[0].speed, 16.0);
        editor.apply(Command::SetClipSpeed { clip_id, speed: 0.0 }).expect("ok");
        assert_eq!(editor.project().active().clips[0].speed, 0.0625);
    }

    #[test]
    fn detach_and_reattach_round_trip_the_sound() {
        let (mut editor, _, clip_id) = fixture();
        let sound_id = editor
            .apply(Command::DetachAudio { clip_id: clip_id.clone() })
            .expect("detaches")
            .created_id
            .expect("sound clip");

        let timeline = editor.project().active();
        assert_eq!(timeline.clips.len(), 2);
        let sound = timeline.clip(&sound_id).expect("exists");
        assert_eq!(sound.kind, ClipKind::Audio);
        assert_eq!(sound.detached_from.as_deref(), Some(clip_id.as_str()));
        assert_eq!(timeline.clip(&clip_id).expect("exists").muted, Some(true));

        editor.apply(Command::ReattachAudio { clip_id: sound_id }).expect("reattaches");
        let timeline = editor.project().active();
        assert_eq!(timeline.clips.len(), 1);
        assert_eq!(timeline.clip(&clip_id).expect("exists").muted, None);
    }

    #[test]
    fn timelines_add_switch_and_delete_with_a_floor_of_one() {
        let mut editor = Editor::new();
        let second =
            editor.apply(Command::AddTimeline).expect("adds").created_id.expect("id");
        assert_eq!(editor.project().active_timeline_id, second);
        assert_eq!(editor.project().timelines[1].name, "Timeline 2");
        assert!(
            editor.project().timelines[1].tracks.iter().all(|track| track.id != "T1"),
            "fresh lanes must not reuse the first timeline's ids"
        );

        editor.apply(Command::SelectTimeline { timeline_id: "TL1".to_owned() }).expect("ok");
        assert_eq!(editor.project().active_timeline_id, "TL1");

        editor.apply(Command::RemoveTimeline { timeline_id: "TL1".to_owned() }).expect("ok");
        assert_eq!(editor.project().active_timeline_id, second);
        let last = editor.project().timelines[0].id.clone();
        let refused = editor.apply(Command::RemoveTimeline { timeline_id: last });
        assert!(refused.is_err(), "the last timeline cannot be deleted");
    }

    #[test]
    fn undo_and_redo_walk_the_history() {
        let (mut editor, _, clip_id) = fixture();
        editor
            .apply(Command::SplitClips { clip_ids: vec![clip_id], time: 5.0 })
            .expect("splits");
        assert_eq!(editor.project().active().clips.len(), 2);

        assert!(editor.undo());
        assert_eq!(editor.project().active().clips.len(), 1);
        assert!(editor.redo());
        assert_eq!(editor.project().active().clips.len(), 2);
        assert!(editor.undo() && editor.undo() && editor.undo());
        assert!(editor.project().media.is_empty(), "all the way back to empty");
    }

    #[test]
    fn a_failed_command_records_no_history() {
        let (mut editor, _, _) = fixture();
        let before_can_undo = editor.can_undo();
        let _ = editor.apply(Command::MergeClips { clip_ids: vec!["nope".to_owned()] });
        assert_eq!(editor.can_undo(), before_can_undo);
    }

    #[test]
    fn the_document_round_trips() {
        let (mut editor, _, clip_id) = fixture();
        editor
            .apply(Command::UpdateClip {
                clip_id: clip_id.clone(),
                patch: ClipPatch {
                    volume: Some(0.5),
                    transition_in: Some(Some(crate::model::Transition {
                        id: "cross-fade".to_owned(),
                        duration: 1.5,
                    })),
                    ..ClipPatch::default()
                },
            })
            .expect("updates");
        editor.apply(Command::AddTimeline).expect("adds");

        let document = editor.to_document(&settings());
        let restored = Editor::from_document(&document).expect("loads");
        assert_eq!(restored.project(), editor.project());
    }

    #[test]
    fn a_typescript_written_document_loads() {
        // The exact shape desktop/src/lib/persist.ts toDocument produces,
        // optional fields omitted the way JSON.stringify drops undefined.
        let document = json!({
            "relay": "0.1.0", "version": 1, "name": "TS",
            "video": { "width": 1920, "height": 1080, "rateNum": 30, "rateDen": 1 },
            "media": [{ "id": "m1", "path": "/a.mp4", "name": "a.mp4", "duration": 10.0,
                        "kind": "video", "width": 1920, "height": 1080, "frameRate": 30.0,
                        "frameRateFraction": "30/1", "videoCodec": "h264",
                        "audioCodec": null, "hasAudio": false }],
            "tracks": [{ "id": "T1", "name": "Track 1", "visible": true, "muted": false }],
            "clips": [{ "id": "c1", "trackId": "T1", "mediaId": "m1", "name": "a.mp4",
                        "kind": "video", "start": 0.0, "duration": 10.0, "sourceStart": 0.0,
                        "volume": 1.0, "fadeIn": 0.0, "fadeOut": 0.0, "scale": 1.0,
                        "offsetX": 0.0, "offsetY": 0.0, "rotation": 0.0, "opacity": 1.0,
                        "speed": 1.0, "preservePitch": true, "filters": [],
                        "videoEffects": [{ "id": "sepia", "params": {}, "enabled": true }] }],
            "fonts": [],
            "timelines": [{ "id": "TL1", "name": "Timeline 1",
                "tracks": [{ "id": "T1", "name": "Track 1", "visible": true, "muted": false }],
                "clips": [{ "id": "c1", "trackId": "T1", "mediaId": "m1", "name": "a.mp4",
                            "kind": "video", "start": 0.0, "duration": 10.0, "sourceStart": 0.0,
                            "volume": 1.0, "fadeIn": 0.0, "fadeOut": 0.0, "scale": 1.0,
                            "offsetX": 0.0, "offsetY": 0.0, "rotation": 0.0, "opacity": 1.0,
                            "speed": 1.0, "preservePitch": true, "filters": [],
                            "videoEffects": [{ "id": "sepia", "params": {}, "enabled": true }] }] }],
            "activeTimelineId": "TL1"
        });
        let editor = Editor::from_document(&document).expect("loads");
        let project = editor.project();
        assert_eq!(project.timelines.len(), 1);
        assert_eq!(project.active().clips[0].video_effects[0].id, "sepia");
    }

    #[test]
    fn a_legacy_flat_document_loads_as_one_timeline() {
        let document = json!({
            "name": "Old", "version": 1,
            "media": [],
            "tracks": [{ "id": "T1", "name": "Track 1", "visible": true, "muted": false }],
            "clips": []
        });
        let editor = Editor::from_document(&document).expect("loads");
        assert_eq!(editor.project().timelines.len(), 1);
        assert_eq!(editor.project().timelines[0].name, "Timeline 1");
    }

    #[test]
    fn restored_ids_can_never_be_reissued() {
        let (editor, _, _) = fixture();
        let document = editor.to_document(&settings());
        let mut restored = Editor::from_document(&document).expect("loads");
        let media_id = restored
            .apply(media("/b.mp4", 5.0, false))
            .expect("adds")
            .created_id
            .expect("id");
        assert!(
            restored.project().media.iter().filter(|item| item.id == media_id).count() == 1
                && editor.project().media.iter().all(|item| item.id != media_id),
            "the fresh id collides with nothing"
        );
    }

    #[test]
    fn commands_arrive_in_camel_case() {
        // The wire format the UI speaks. A snake_case field here means the
        // TypeScript side silently sends values serde never sees.
        let command: Command = serde_json::from_value(json!({
            "op": "addClip", "mediaId": "m1", "trackId": "T1", "start": 2.0
        }))
        .expect("camelCase fields deserialize");
        assert!(matches!(command, Command::AddClip { .. }));

        let transform: Command = serde_json::from_value(json!({
            "op": "setClipTransform", "clipId": "c1", "offsetX": 0.5
        }))
        .expect("optional camelCase fields deserialize");
        assert!(matches!(transform, Command::SetClipTransform { .. }));

        // The template commands ride the same wire.
        let mark: Command = serde_json::from_value(json!({
            "op": "setMediaPlaceholder", "mediaId": "m1", "placeholder": true
        }))
        .expect("parses");
        assert!(matches!(mark, Command::SetMediaPlaceholder { placeholder: true, .. }));

        let batch: Command = serde_json::from_value(json!({
            "op": "batch",
            "commands": [{ "op": "fillSlot", "mediaId": "m1", "item": {
                "path": "/b.mp4", "name": "b.mp4", "duration": 3.0, "kind": "video",
                "width": null, "height": null, "frameRate": null, "frameRateFraction": null,
                "videoCodec": null, "audioCodec": null, "hasAudio": false
            }}]
        }))
        .expect("parses");
        assert!(matches!(
            &batch,
            Command::Batch { commands } if matches!(commands[0], Command::FillSlot { .. })
        ));

        // ClipPatch double-options: absent leaves alone, null clears.
        let patch: crate::commands::ClipPatch =
            serde_json::from_value(json!({ "transitionIn": null })).expect("parses");
        assert_eq!(patch.transition_in, Some(None));
        let untouched: crate::commands::ClipPatch =
            serde_json::from_value(json!({})).expect("parses");
        assert_eq!(untouched.transition_in, None);
    }

    #[test]
    fn a_slot_fills_in_place_keeping_the_template_timing() {
        let (mut editor, media_id, clip_id) = fixture();
        // Shape the clip the way a template slot looks: trimmed off the front,
        // so it has a real in-point to forget.
        editor
            .apply(Command::TrimClip { clip_id, edge: TrimEdge::Start, delta: 2.0 })
            .expect("trims");
        editor
            .apply(Command::SetMediaPlaceholder { media_id: media_id.clone(), placeholder: true })
            .expect("marks");
        assert!(editor.project().media[0].placeholder);

        editor
            .apply(Command::FillSlot {
                media_id: media_id.clone(),
                item: crate::commands::NewMedia {
                    path: "/photo.jpg".to_owned(),
                    name: "photo.jpg".to_owned(),
                    duration: None,
                    kind: MediaKind::Image,
                    width: Some(4000),
                    height: Some(3000),
                    frame_rate: None,
                    frame_rate_fraction: None,
                    video_codec: None,
                    audio_codec: None,
                    has_audio: false,
                },
            })
            .expect("fills");

        let project = editor.project();
        let media = &project.media[0];
        assert!(!media.placeholder, "a filled slot is ordinary media again");
        assert_eq!(media.id, media_id, "the id survives, so clips keep working");
        assert_eq!(media.path, "/photo.jpg");

        let clip = &project.active().clips[0];
        assert_eq!(clip.start, 2.0, "slot position is the template's");
        assert_eq!(clip.duration, 8.0, "slot length is the template's");
        assert_eq!(clip.source_start, 0.0, "the in-point referred to the old footage");
        assert_eq!(clip.kind, ClipKind::Image);
        assert_eq!(clip.name, "photo.jpg");
    }

    #[test]
    fn filling_ordinary_media_is_refused() {
        let (mut editor, media_id, _) = fixture();
        let refused = editor.apply(Command::FillSlot {
            media_id,
            item: crate::commands::NewMedia {
                path: "/b.mp4".to_owned(),
                name: "b.mp4".to_owned(),
                duration: Some(3.0),
                kind: MediaKind::Video,
                width: None,
                height: None,
                frame_rate: None,
                frame_rate_fraction: None,
                video_codec: None,
                audio_codec: None,
                has_audio: false,
            },
        });
        assert!(refused.unwrap_err().contains("not a template slot"));
    }

    #[test]
    fn a_batch_is_one_undo_step() {
        let (mut editor, _, clip_id) = fixture();
        editor
            .apply(Command::Batch {
                commands: vec![
                    Command::SplitClips { clip_ids: vec![clip_id.clone()], time: 4.0 },
                    Command::SetClipSpeed { clip_id, speed: 2.0 },
                ],
            })
            .expect("applies");
        assert_eq!(editor.project().active().clips.len(), 2);
        assert_eq!(editor.project().active().clips[0].speed, 2.0);

        assert!(editor.undo());
        let clips = &editor.project().active().clips;
        assert_eq!(clips.len(), 1, "one undo reverses the whole batch");
        assert_eq!(clips[0].speed, 1.0);
    }

    #[test]
    fn a_failed_batch_changes_nothing() {
        let (mut editor, _, clip_id) = fixture();
        let before = editor.project().clone();
        let refused = editor.apply(Command::Batch {
            commands: vec![
                Command::SplitClips { clip_ids: vec![clip_id], time: 4.0 },
                Command::MergeClips { clip_ids: vec!["nope".to_owned()] },
            ],
        });
        assert!(refused.is_err());
        assert_eq!(editor.project(), &before, "the successful half was rolled back");

        assert!(editor.undo());
        assert!(
            editor.project().active().clips.is_empty(),
            "the first undo steps over the fixture's add-clip, so the batch recorded nothing"
        );
    }

    #[test]
    fn the_placeholder_flag_round_trips_and_defaults_off() {
        let (mut editor, media_id, _) = fixture();
        editor
            .apply(Command::SetMediaPlaceholder { media_id, placeholder: true })
            .expect("marks");

        let document = editor.to_document(&settings());
        let restored = Editor::from_document(&document).expect("loads");
        assert!(restored.project().media[0].placeholder, "the flag survives the document");

        // A document from a build that predates templates has no such field.
        let legacy = json!({
            "name": "Old", "version": 1,
            "media": [{ "id": "m1", "path": "/a.mp4", "name": "a.mp4", "kind": "video",
                        "hasAudio": false }],
            "tracks": [{ "id": "T1", "name": "Track 1", "visible": true, "muted": false }],
            "clips": []
        });
        let editor = Editor::from_document(&legacy).expect("loads");
        assert!(!editor.project().media[0].placeholder);
    }

    #[test]
    fn a_garbage_document_is_none_not_a_panic() {
        assert!(Editor::from_document(&json!("nonsense")).is_none());
        assert!(Editor::from_document(&json!({ "tracks": [] })).is_none());
    }

    #[test]
    fn text_clips_survive_without_media_and_carry_their_words() {
        let mut editor = Editor::new();
        let clip_id = editor
            .apply(Command::AddTextClip {
                track_id: None,
                start: 2.0,
                style: Some(TextStyle { content: "Lower third\nsecond line".to_owned(), ..TextStyle::default() }),
            })
            .expect("adds")
            .created_id
            .expect("id");
        assert_eq!(editor.project().active().clip(&clip_id).expect("exists").name, "Lower third");

        let document = editor.to_document(&settings());
        let restored = Editor::from_document(&document).expect("loads");
        assert_eq!(restored.project(), editor.project());
    }
}
