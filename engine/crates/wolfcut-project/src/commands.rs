//! Every edit operation, as data.
//!
//! A [`Command`] is what the UI sends over IPC; [`apply`] is the one place
//! its meaning lives. The semantics are ported line for line from
//! `desktop/src/lib/project.ts` - same clamps, same tolerances, same rules -
//! because during the migration both sides must agree about every edit, and
//! after it this file is simply the only copy.

use serde::{Deserialize, Serialize};

use crate::model::{
    AppliedFilter, Clip, ClipKind, CustomFont, MediaItem, MediaKind, Project, TextStyle,
    Timeline, Track, Transition,
};

/// Fallback length for media whose container reports no duration.
const UNKNOWN_DURATION: f64 = 5.0;
/// How long a still lasts when first placed. Editorial default, not a fact.
const DEFAULT_IMAGE_DURATION: f64 = 5.0;
/// How long a title lasts when first placed.
const DEFAULT_TEXT_DURATION: f64 = 4.0;
const MIN_CLIP_DURATION: f64 = 1.0 / 60.0;
/// The engine's speed range (wolfcut-media `SPEED_RANGE`), verbatim.
const MIN_SPEED: f64 = 0.0625;
const MAX_SPEED: f64 = 16.0;
const MIN_SCALE: f64 = 0.05;
const MAX_SCALE: f64 = 8.0;
const MAX_OFFSET: f64 = 3.0;
/// How far apart two clips may sit and still count as touching, in seconds.
const JOIN_EPSILON: f64 = 1e-6;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrimEdge {
    Start,
    End,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackFlag {
    Visible,
    Muted,
}

/// Where one clip is going, in a multi-clip move.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMove {
    pub clip_id: String,
    pub start: f64,
    pub track_id: String,
}

/// A partial update to one clip. Every field optional; `transition_in` and
/// `text` are double-optional so "clear it" and "leave it alone" stay
/// distinct on the wire (absent = untouched, null = cleared).
#[derive(Clone, Default, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipPatch {
    pub name: Option<String>,
    pub volume: Option<f64>,
    pub fade_in: Option<f64>,
    pub fade_out: Option<f64>,
    pub opacity: Option<f64>,
    pub preserve_pitch: Option<bool>,
    pub filters: Option<Vec<AppliedFilter>>,
    pub video_effects: Option<Vec<AppliedFilter>>,
    #[serde(default, with = "double_option", skip_serializing_if = "Option::is_none")]
    pub transition_in: Option<Option<Transition>>,
    #[serde(default, with = "double_option", skip_serializing_if = "Option::is_none")]
    pub text: Option<Option<TextStyle>>,
}

/// `Option<Option<T>>` over JSON: absent → None, null → Some(None).
mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

/// A media item as probed by the host, before the model mints its id.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMedia {
    pub path: String,
    pub name: String,
    pub duration: Option<f64>,
    pub kind: MediaKind,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub frame_rate_fraction: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub has_audio: bool,
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    AddMedia { item: NewMedia },
    RemoveMedia { media_id: String },
    SetMediaPlaceholder { media_id: String, placeholder: bool },
    FillSlot { media_id: String, item: NewMedia },
    Batch { commands: Vec<Command> },
    AddClip { media_id: String, track_id: String, start: f64 },
    AddClipAtFirstFree { media_id: String, start: f64 },
    AddTextClip {
        track_id: Option<String>,
        start: f64,
        style: Option<TextStyle>,
        /// Seconds on the timeline; the editorial default when absent. Here
        /// so a caption run can land as one batch instead of add-then-trim
        /// per clip - a batch cannot trim a clip whose id it cannot know yet.
        #[serde(default)]
        duration: Option<f64>,
        /// Vertical placement as a frame-height fraction, clamped like
        /// SetClipTransform. Lower thirds are made of this.
        #[serde(default)]
        offset_y: Option<f64>,
    },
    MoveClips { moves: Vec<ClipMove> },
    TrimClip { clip_id: String, edge: TrimEdge, delta: f64 },
    SplitClips { clip_ids: Vec<String>, time: f64 },
    MergeClips { clip_ids: Vec<String> },
    RemoveClips { clip_ids: Vec<String> },
    UpdateClip { clip_id: String, patch: ClipPatch },
    SetClipSpeed { clip_id: String, speed: f64 },
    SetClipTransform {
        clip_id: String,
        scale: Option<f64>,
        offset_x: Option<f64>,
        offset_y: Option<f64>,
        rotation: Option<f64>,
    },
    DetachAudio { clip_id: String },
    ReattachAudio { clip_id: String },
    AddTrack,
    RemoveTrack { track_id: String },
    RenameTrack { track_id: String, name: String },
    SetTrackFlag { track_id: String, flag: TrackFlag, value: bool },
    AddTimeline,
    RemoveTimeline { timeline_id: String },
    RenameTimeline { timeline_id: String, name: String },
    SelectTimeline { timeline_id: String },
    AddFont { family: String, path: String },
    RemoveFont { family: String },
}

/// What a command produced, beyond the new state: the ids it minted, so the
/// UI can select what it just created.
#[derive(Clone, Default, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_id: Option<String>,
}

/// Mints ids. Owned by the editor so restored projects advance it past every
/// id a file already uses - the collision class `adoptProject` fixed in the
/// UI is prevented here instead.
#[derive(Clone, Default, Debug)]
pub struct IdMint {
    counter: u64,
}

impl IdMint {
    pub fn next(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}{}", self.counter)
    }

    /// Advances the counter past `id`'s numeric suffix, if it has one.
    pub fn adopt(&mut self, id: &str) {
        let digits: String = id
            .chars()
            .rev()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        if let Ok(value) = digits.parse::<u64>() {
            self.counter = self.counter.max(value);
        }
    }

    pub fn adopt_project(&mut self, project: &Project) {
        for item in &project.media {
            self.adopt(&item.id);
        }
        for timeline in &project.timelines {
            self.adopt(&timeline.id);
            for track in &timeline.tracks {
                self.adopt(&track.id);
            }
            for clip in &timeline.clips {
                self.adopt(&clip.id);
            }
        }
    }
}

fn default_clip(id: String, track_id: String, media: &MediaItem, start: f64) -> Clip {
    Clip {
        id,
        track_id,
        media_id: media.id.clone(),
        name: media.name.clone(),
        kind: match media.kind {
            MediaKind::Video => ClipKind::Video,
            MediaKind::Audio => ClipKind::Audio,
            MediaKind::Image => ClipKind::Image,
        },
        start: start.max(0.0),
        duration: match media.kind {
            MediaKind::Image => DEFAULT_IMAGE_DURATION,
            _ => media.duration.unwrap_or(UNKNOWN_DURATION),
        },
        source_start: 0.0,
        volume: 1.0,
        fade_in: 0.0,
        fade_out: 0.0,
        scale: 1.0,
        offset_x: 0.0,
        offset_y: 0.0,
        rotation: 0.0,
        opacity: 1.0,
        speed: 1.0,
        preserve_pitch: true,
        filters: Vec::new(),
        video_effects: Vec::new(),
        muted: None,
        detached_from: None,
        transition_in: None,
        text: None,
    }
}

/// The lowest track with nothing occupying `[start, start + duration)`,
/// falling back to the bottom track.
fn first_free_track(timeline: &Timeline, start: f64, duration: f64) -> Option<String> {
    let end = start + duration;
    timeline
        .tracks
        .iter()
        .find(|track| {
            !timeline.clips.iter().any(|clip| {
                clip.track_id == track.id && clip.start < end && start < clip.start + clip.duration
            })
        })
        .or(timeline.tracks.first())
        .map(|track| track.id.clone())
}

/// A one-line label for a block of text.
fn first_line(content: &str) -> String {
    let line = content
        .lines()
        .find(|candidate| !candidate.trim().is_empty())
        .unwrap_or("Text")
        .trim();
    let label: String = line.chars().take(40).collect();
    if label.is_empty() { "Text".to_owned() } else { label }
}

/// "Track 5" from the highest number already in use, not from the count.
fn next_numbered(name: &str, existing: impl Iterator<Item = String>) -> String {
    let highest = existing
        .filter_map(|candidate| {
            let digits: String = candidate.chars().filter(char::is_ascii_digit).collect();
            digits.parse::<u64>().ok()
        })
        .max()
        .unwrap_or(0);
    format!("{name} {}", highest + 1)
}

/// Why these clips cannot be merged, or None if they can. A sentence, because
/// a disabled button that will not say why is worse than no button.
pub fn why_not_merge(timeline: &Timeline, clip_ids: &[String]) -> Option<String> {
    if clip_ids.len() < 2 {
        return Some("Select two or more clips to merge.".to_owned());
    }
    let clips: Vec<&Clip> = clip_ids.iter().filter_map(|id| timeline.clip(id)).collect();
    if clips.len() < 2 {
        return Some("Select two or more clips to merge.".to_owned());
    }
    if clips.iter().any(|clip| clip.track_id != clips[0].track_id) {
        return Some("Merged clips must be on the same track.".to_owned());
    }
    if clips.iter().any(|clip| clip.media_id != clips[0].media_id) {
        return Some("Merged clips must come from the same file.".to_owned());
    }
    if clips.iter().any(|clip| clip.speed != clips[0].speed) {
        return Some("Merged clips must play at the same speed.".to_owned());
    }

    let mut ordered = clips.clone();
    ordered.sort_by(|left, right| left.start.total_cmp(&right.start));
    for pair in ordered.windows(2) {
        let (previous, current) = (pair[0], pair[1]);
        if (current.start - (previous.start + previous.duration)).abs() > JOIN_EPSILON {
            return Some("Merged clips must touch, with no gap or overlap.".to_owned());
        }
        if (current.source_start - (previous.source_start + previous.duration * previous.speed))
            .abs()
            > JOIN_EPSILON
        {
            return Some("These pieces are no longer in their original order.".to_owned());
        }
    }
    None
}

/// Applies one command. Errors are user-meaningful sentences; a command that
/// legitimately does nothing (a no-op rename, an out-of-range split) returns
/// Ok with no created id, matching the tolerant TS operations it replaces.
pub fn apply(project: &mut Project, mint: &mut IdMint, command: Command) -> Result<Outcome, String> {
    match command {
        Command::AddMedia { item } => {
            if project.media.iter().any(|existing| existing.path == item.path) {
                return Ok(Outcome::default());
            }
            let id = mint.next("m");
            project.media.push(MediaItem {
                id: id.clone(),
                path: item.path,
                name: item.name,
                duration: item.duration,
                kind: item.kind,
                width: item.width,
                height: item.height,
                frame_rate: item.frame_rate,
                frame_rate_fraction: item.frame_rate_fraction,
                video_codec: item.video_codec,
                audio_codec: item.audio_codec,
                has_audio: item.has_audio,
                placeholder: false,
            });
            Ok(Outcome { created_id: Some(id) })
        }

        Command::SetMediaPlaceholder { media_id, placeholder } => {
            if let Some(item) = project.media.iter_mut().find(|item| item.id == media_id) {
                item.placeholder = placeholder;
            }
            Ok(Outcome::default())
        }

        Command::FillSlot { media_id, item } => {
            let media = project
                .media
                .iter_mut()
                .find(|existing| existing.id == media_id)
                .ok_or("That template slot no longer exists.")?;
            if !media.placeholder {
                return Err("That media is not a template slot.".to_owned());
            }

            // The slot keeps its id, so every clip that references it keeps
            // working; only the identity behind the id changes.
            media.path = item.path;
            media.name = item.name.clone();
            media.duration = item.duration;
            media.kind = item.kind;
            media.width = item.width;
            media.height = item.height;
            media.frame_rate = item.frame_rate;
            media.frame_rate_fraction = item.frame_rate_fraction;
            media.video_codec = item.video_codec;
            media.audio_codec = item.audio_codec;
            media.has_audio = item.has_audio;
            media.placeholder = false;
            let kind = match item.kind {
                MediaKind::Video => ClipKind::Video,
                MediaKind::Audio => ClipKind::Audio,
                MediaKind::Image => ClipKind::Image,
            };

            // Slot timing is the template's: start, duration and speed stay
            // put, which is what keeps cuts on the beat. The in-point resets
            // because it referred to the old footage; a clip shorter than its
            // slot freeze-frames on its last frame downstream, which is the
            // renderer's existing behaviour for a trim past the media's end.
            // All timelines, like RemoveMedia: slots are not per-timeline.
            for timeline in &mut project.timelines {
                for clip in &mut timeline.clips {
                    if clip.media_id == media_id {
                        clip.source_start = 0.0;
                        clip.kind = kind;
                        clip.name = item.name.clone();
                    }
                }
            }
            Ok(Outcome::default())
        }

        Command::Batch { commands } => {
            // All or nothing: apply to a staged copy and commit only a fully
            // successful run, so one bad command cannot leave a half-applied
            // batch behind (and the editor records it as one undo step).
            let mut staged = project.clone();
            let mut created = None;
            for command in commands {
                let outcome = apply(&mut staged, mint, command)?;
                if outcome.created_id.is_some() {
                    created = outcome.created_id;
                }
            }
            *project = staged;
            Ok(Outcome { created_id: created })
        }

        Command::RemoveMedia { media_id } => {
            // All timelines, not just the active one: a shelved clip whose
            // media is gone would linger as a dead reference.
            project.media.retain(|item| item.id != media_id);
            for timeline in &mut project.timelines {
                timeline.clips.retain(|clip| clip.media_id != media_id);
            }
            Ok(Outcome::default())
        }

        Command::AddClip { media_id, track_id, start } => {
            let media = project
                .media_by_id(&media_id)
                .ok_or("That media is no longer in the bin.")?
                .clone();
            let timeline = project.active_mut();
            if timeline.track(&track_id).is_none() {
                return Err("That track no longer exists.".to_owned());
            }
            let id = mint.next("c");
            timeline.clips.push(default_clip(id.clone(), track_id, &media, start));
            Ok(Outcome { created_id: Some(id) })
        }

        Command::AddClipAtFirstFree { media_id, start } => {
            let media = project
                .media_by_id(&media_id)
                .ok_or("That media is no longer in the bin.")?
                .clone();
            let duration = match media.kind {
                MediaKind::Image => DEFAULT_IMAGE_DURATION,
                _ => media.duration.unwrap_or(UNKNOWN_DURATION),
            };
            let timeline = project.active_mut();
            let track_id =
                first_free_track(timeline, start, duration).ok_or("There are no tracks.")?;
            let id = mint.next("c");
            timeline.clips.push(default_clip(id.clone(), track_id, &media, start));
            Ok(Outcome { created_id: Some(id) })
        }

        Command::AddTextClip { track_id, start, style, duration, offset_y } => {
            let style = style.unwrap_or_default();
            let duration = duration.unwrap_or(DEFAULT_TEXT_DURATION).max(MIN_CLIP_DURATION);
            let timeline = project.active_mut();
            let track_id = match track_id {
                Some(id) if timeline.track(&id).is_some() => id,
                Some(_) => return Err("That track no longer exists.".to_owned()),
                None => first_free_track(timeline, start, duration)
                    .ok_or("There are no tracks.")?,
            };
            let id = mint.next("c");
            timeline.clips.push(Clip {
                id: id.clone(),
                track_id,
                media_id: String::new(),
                name: first_line(&style.content),
                kind: ClipKind::Text,
                start: start.max(0.0),
                duration,
                source_start: 0.0,
                volume: 1.0,
                fade_in: 0.0,
                fade_out: 0.0,
                scale: 1.0,
                offset_x: 0.0,
                offset_y: offset_y.unwrap_or(0.0).clamp(-MAX_OFFSET, MAX_OFFSET),
                rotation: 0.0,
                opacity: 1.0,
                speed: 1.0,
                preserve_pitch: true,
                filters: Vec::new(),
                video_effects: Vec::new(),
                muted: None,
                detached_from: None,
                transition_in: None,
                text: Some(style),
            });
            Ok(Outcome { created_id: Some(id) })
        }

        Command::MoveClips { moves } => {
            let timeline = project.active_mut();
            let track_ids: Vec<String> =
                timeline.tracks.iter().map(|track| track.id.clone()).collect();
            for wanted in moves {
                if let Some(clip) = timeline.clip_mut(&wanted.clip_id) {
                    clip.start = wanted.start.max(0.0);
                    if track_ids.contains(&wanted.track_id) {
                        clip.track_id = wanted.track_id;
                    }
                }
            }
            Ok(Outcome::default())
        }

        Command::TrimClip { clip_id, edge, delta } => {
            let timeline = project.active_mut();
            let Some(clip) = timeline.clip_mut(&clip_id) else {
                return Ok(Outcome::default());
            };
            match edge {
                TrimEdge::End => {
                    clip.duration = (clip.duration + delta).max(MIN_CLIP_DURATION);
                }
                TrimEdge::Start => {
                    // Dragging the head moves the in-point too, so the pixels
                    // under the remaining part of the clip do not slide.
                    let shift = delta.min(clip.duration - MIN_CLIP_DURATION);
                    let start = (clip.start + shift).max(0.0);
                    let applied = start - clip.start;
                    clip.start = start;
                    clip.duration -= applied;
                    clip.source_start = (clip.source_start + applied * clip.speed).max(0.0);
                }
            }
            Ok(Outcome::default())
        }

        Command::SplitClips { clip_ids, time } => {
            let timeline = project.active_mut();
            let mut created = None;
            for clip_id in clip_ids {
                let Some(index) = timeline.clips.iter().position(|clip| clip.id == clip_id)
                else {
                    continue;
                };
                let clip = &timeline.clips[index];
                let offset = time - clip.start;
                if offset <= MIN_CLIP_DURATION || offset >= clip.duration - MIN_CLIP_DURATION {
                    continue;
                }
                let mut tail = clip.clone();
                tail.id = mint.next("c");
                tail.start = clip.start + offset;
                tail.duration = clip.duration - offset;
                tail.source_start = clip.source_start + offset * clip.speed;
                // The transition belongs to the cut at the original clip's
                // start, which the head keeps.
                tail.transition_in = None;
                created = Some(tail.id.clone());
                timeline.clips[index].duration = offset;
                timeline.clips.insert(index + 1, tail);
            }
            Ok(Outcome { created_id: created })
        }

        Command::MergeClips { clip_ids } => {
            let timeline = project.active_mut();
            if let Some(reason) = why_not_merge(timeline, &clip_ids) {
                return Err(reason);
            }
            let mut ordered: Vec<Clip> =
                clip_ids.iter().filter_map(|id| timeline.clip(id).cloned()).collect();
            ordered.sort_by(|left, right| left.start.total_cmp(&right.start));
            let first = ordered.first().expect("validated above").clone();
            let last = ordered.last().expect("validated above");
            let merged_duration = last.start + last.duration - first.start;

            let doomed: Vec<String> =
                ordered.iter().skip(1).map(|clip| clip.id.clone()).collect();
            timeline.clips.retain(|clip| !doomed.contains(&clip.id));
            let survivor =
                timeline.clip_mut(&first.id).expect("the first piece survives the retain");
            survivor.duration = merged_duration;
            Ok(Outcome { created_id: Some(first.id) })
        }

        Command::RemoveClips { clip_ids } => {
            let timeline = project.active_mut();
            timeline.clips.retain(|clip| !clip_ids.contains(&clip.id));
            Ok(Outcome::default())
        }

        Command::UpdateClip { clip_id, patch } => {
            let timeline = project.active_mut();
            let Some(clip) = timeline.clip_mut(&clip_id) else {
                return Ok(Outcome::default());
            };
            if let Some(name) = patch.name {
                clip.name = name;
            }
            if let Some(volume) = patch.volume {
                clip.volume = volume.max(0.0);
            }
            if let Some(fade_in) = patch.fade_in {
                clip.fade_in = fade_in.max(0.0);
            }
            if let Some(fade_out) = patch.fade_out {
                clip.fade_out = fade_out.max(0.0);
            }
            if let Some(opacity) = patch.opacity {
                clip.opacity = opacity.clamp(0.0, 1.0);
            }
            if let Some(preserve) = patch.preserve_pitch {
                clip.preserve_pitch = preserve;
            }
            if let Some(filters) = patch.filters {
                clip.filters = filters;
            }
            if let Some(effects) = patch.video_effects {
                clip.video_effects = effects;
            }
            if let Some(transition) = patch.transition_in {
                clip.transition_in = transition;
            }
            if let Some(text) = patch.text {
                // The name follows the words, like addTextClip snapshots it.
                if let Some(style) = &text {
                    clip.name = first_line(&style.content);
                }
                clip.text = text;
            }
            Ok(Outcome::default())
        }

        Command::SetClipSpeed { clip_id, speed } => {
            let timeline = project.active_mut();
            let Some(clip) = timeline.clip_mut(&clip_id) else {
                return Ok(Outcome::default());
            };
            // The amount of source covered is held constant - that is what
            // makes this a speed change rather than a trim.
            let next = speed.clamp(MIN_SPEED, MAX_SPEED);
            let source_covered = clip.duration * clip.speed;
            clip.speed = next;
            clip.duration = (source_covered / next).max(MIN_CLIP_DURATION);
            Ok(Outcome::default())
        }

        Command::SetClipTransform { clip_id, scale, offset_x, offset_y, rotation } => {
            let timeline = project.active_mut();
            let Some(clip) = timeline.clip_mut(&clip_id) else {
                return Ok(Outcome::default());
            };
            if let Some(scale) = scale {
                clip.scale = scale.clamp(MIN_SCALE, MAX_SCALE);
            }
            if let Some(offset) = offset_x {
                clip.offset_x = offset.clamp(-MAX_OFFSET, MAX_OFFSET);
            }
            if let Some(offset) = offset_y {
                clip.offset_y = offset.clamp(-MAX_OFFSET, MAX_OFFSET);
            }
            if let Some(rotation) = rotation {
                // Kept in (-180, 180] so a full drag never accumulates turns.
                let wrapped = ((rotation % 360.0) + 540.0) % 360.0 - 180.0;
                clip.rotation = if wrapped == -180.0 { 180.0 } else { wrapped };
            }
            Ok(Outcome::default())
        }

        Command::DetachAudio { clip_id } => {
            let has_audio = {
                let timeline = project.active();
                let Some(clip) = timeline.clip(&clip_id) else {
                    return Ok(Outcome::default());
                };
                clip.kind == ClipKind::Video
                    && clip.muted != Some(true)
                    && project
                        .media_by_id(&clip.media_id)
                        .is_some_and(|media| media.has_audio)
                    && !timeline
                        .clips
                        .iter()
                        .any(|other| other.detached_from.as_deref() == Some(clip_id.as_str()))
            };
            if !has_audio {
                return Ok(Outcome::default());
            }

            let timeline = project.active_mut();
            let clip = timeline.clip(&clip_id).expect("checked above").clone();
            // A lane free for the whole span, or a fresh one.
            let track_id = {
                let end = clip.start + clip.duration;
                let free = timeline.tracks.iter().find(|track| {
                    !timeline.clips.iter().any(|other| {
                        other.track_id == track.id
                            && other.start < end
                            && clip.start < other.start + other.duration
                    })
                });
                match free {
                    Some(track) => track.id.clone(),
                    None => {
                        let id = mint.next("t");
                        let name = next_numbered(
                            "Track",
                            timeline.tracks.iter().map(|track| track.name.clone()),
                        );
                        timeline.tracks.push(Track {
                            id: id.clone(),
                            name,
                            visible: true,
                            muted: false,
                        });
                        id
                    }
                }
            };

            let mut sound = clip.clone();
            sound.id = mint.next("c");
            sound.track_id = track_id;
            sound.kind = ClipKind::Audio;
            sound.video_effects = Vec::new();
            sound.transition_in = None;
            sound.detached_from = Some(clip_id.clone());
            sound.muted = None;
            let sound_id = sound.id.clone();
            timeline.clips.push(sound);

            let video = timeline.clip_mut(&clip_id).expect("still present");
            video.muted = Some(true);
            video.filters = Vec::new();
            Ok(Outcome { created_id: Some(sound_id) })
        }

        Command::ReattachAudio { clip_id } => {
            let timeline = project.active_mut();
            let Some(clip) = timeline.clip(&clip_id) else {
                return Ok(Outcome::default());
            };
            let video_id = match (&clip.kind, &clip.detached_from) {
                (ClipKind::Audio, Some(source)) => source.clone(),
                _ => clip.id.clone(),
            };
            if timeline.clip(&video_id).is_none() {
                return Ok(Outcome::default());
            }
            let sounds: Vec<Clip> = timeline
                .clips
                .iter()
                .filter(|other| other.detached_from.as_deref() == Some(video_id.as_str()))
                .cloned()
                .collect();
            if sounds.is_empty() {
                return Ok(Outcome::default());
            }
            let doomed: Vec<String> = sounds.iter().map(|sound| sound.id.clone()).collect();
            timeline.clips.retain(|other| !doomed.contains(&other.id));
            let video = timeline.clip_mut(&video_id).expect("checked above");
            video.muted = None;
            video.filters = sounds[0].filters.clone();
            Ok(Outcome::default())
        }

        Command::AddTrack => {
            let timeline = project.active_mut();
            let id = mint.next("t");
            let name =
                next_numbered("Track", timeline.tracks.iter().map(|track| track.name.clone()));
            timeline.tracks.push(Track { id: id.clone(), name, visible: true, muted: false });
            Ok(Outcome { created_id: Some(id) })
        }

        Command::RemoveTrack { track_id } => {
            let timeline = project.active_mut();
            if timeline.tracks.len() <= 1 {
                return Err("A timeline needs at least one track.".to_owned());
            }
            timeline.tracks.retain(|track| track.id != track_id);
            timeline.clips.retain(|clip| clip.track_id != track_id);
            Ok(Outcome::default())
        }

        Command::RenameTrack { track_id, name } => {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Ok(Outcome::default());
            }
            let timeline = project.active_mut();
            if let Some(track) = timeline.tracks.iter_mut().find(|track| track.id == track_id) {
                track.name = trimmed.to_owned();
            }
            Ok(Outcome::default())
        }

        Command::SetTrackFlag { track_id, flag, value } => {
            let timeline = project.active_mut();
            if let Some(track) = timeline.tracks.iter_mut().find(|track| track.id == track_id) {
                match flag {
                    TrackFlag::Visible => track.visible = value,
                    TrackFlag::Muted => track.muted = value,
                }
            }
            Ok(Outcome::default())
        }

        Command::AddTimeline => {
            let id = mint.next("tl");
            let name = next_numbered(
                "Timeline",
                project.timelines.iter().map(|timeline| timeline.name.clone()),
            );
            let tracks = (1..=4)
                .map(|number| Track {
                    id: mint.next("t"),
                    name: format!("Track {number}"),
                    visible: true,
                    muted: false,
                })
                .collect();
            project.timelines.push(Timeline { id: id.clone(), name, tracks, clips: Vec::new() });
            project.active_timeline_id = id.clone();
            Ok(Outcome { created_id: Some(id) })
        }

        Command::RemoveTimeline { timeline_id } => {
            if project.timelines.len() <= 1 {
                return Err("A project needs at least one timeline.".to_owned());
            }
            let Some(index) =
                project.timelines.iter().position(|timeline| timeline.id == timeline_id)
            else {
                return Ok(Outcome::default());
            };
            if project.active_timeline_id == timeline_id {
                let neighbour = if index + 1 < project.timelines.len() { index + 1 } else { index - 1 };
                project.active_timeline_id = project.timelines[neighbour].id.clone();
            }
            project.timelines.remove(index);
            Ok(Outcome::default())
        }

        Command::RenameTimeline { timeline_id, name } => {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Ok(Outcome::default());
            }
            if let Some(timeline) =
                project.timelines.iter_mut().find(|timeline| timeline.id == timeline_id)
            {
                timeline.name = trimmed.to_owned();
            }
            Ok(Outcome::default())
        }

        Command::SelectTimeline { timeline_id } => {
            if project.timelines.iter().any(|timeline| timeline.id == timeline_id) {
                project.active_timeline_id = timeline_id;
            }
            Ok(Outcome::default())
        }

        Command::AddFont { family, path } => {
            if !project.fonts.iter().any(|font| font.path == path) {
                project.fonts.push(CustomFont { family, path });
            }
            Ok(Outcome::default())
        }

        Command::RemoveFont { family } => {
            // Clips keep the family name: the face may come back when the
            // file does.
            project.fonts.retain(|font| font.family != family);
            Ok(Outcome::default())
        }
    }
}
