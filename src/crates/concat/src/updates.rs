// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

//! Release notifications, never an installer. The check runs off the UI
//! thread; the OS browser opens only when the user asks to view a release.

use std::time::{SystemTime, UNIX_EPOCH};

use concat_host::updates::{self, Release};

use crate::host::on_ui;
use crate::i18n::{t, tf};
use crate::prefs::UpdatePrefs;
use crate::studio::Studio;
use crate::ui::UpdateData;

const REPOSITORY: &str = env!("CONCAT_RELEASE_REPOSITORY");
const VERSION: &str = env!("CONCAT_RELEASE_VERSION");
const TARGET: &str = env!("BUILD_TARGET");
const DAY: u64 = 24 * 60 * 60;

#[derive(Default)]
enum Status {
    #[default]
    NotChecked,
    Current,
    Failed,
}

#[derive(Default)]
pub struct UpdateState {
    checking: bool,
    available: Option<Release>,
    prompt: bool,
    manual: bool,
    status: Status,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn due(prefs: &UpdatePrefs, repository: &str, time: u64) -> bool {
    prefs.automatic
        && (prefs.repository != repository
            || prefs
                .last_check
                .is_none_or(|last| time < last || time - last >= DAY))
}

impl UpdateState {
    fn should_present(&self, busy: bool, settings_open: bool) -> bool {
        self.prompt && !busy && (!settings_open || self.manual)
    }

    fn finish(
        &mut self,
        result: Result<Option<Release>, String>,
        prefs: &UpdatePrefs,
        manual: bool,
    ) {
        self.checking = false;
        // Turning automatic checks off while one is in flight also cancels
        // its notification. A manual request is independent of that switch.
        if !manual && !prefs.automatic {
            return;
        }
        match result {
            Ok(release) => {
                self.prompt = release.as_ref().is_some_and(|release| {
                    manual || prefs.skipped_version.as_deref() != Some(release.version.as_str())
                });
                self.manual = manual;
                self.available = release;
                self.status = Status::Current;
            }
            Err(error) => {
                log::warn!("release check failed: {error}");
                self.status = Status::Failed;
            }
        }
    }
}

impl Studio {
    pub fn check_updates(&mut self, manual: bool) {
        let time = now();
        if self.updates.checking || (!manual && !due(&self.prefs.updates, REPOSITORY, time)) {
            return;
        }
        if !updates::supported_target(TARGET) {
            return;
        }
        if self.prefs.updates.repository != REPOSITORY {
            self.prefs.updates.repository = REPOSITORY.into();
            self.prefs.updates.skipped_version = None;
        }
        // Record attempts as well as successes: offline launches and rate
        // limits must not result in a request on every timer tick.
        self.prefs.updates.last_check = Some(time);
        self.prefs.save(&self.host.dirs);
        self.updates.checking = true;
        let started = std::thread::Builder::new()
            .name("release-check".into())
            .spawn(move || {
                let result = updates::check(REPOSITORY, VERSION, TARGET);
                on_ui(move |studio, _, _| {
                    studio.updates.finish(result, &studio.prefs.updates, manual);
                });
            });
        if let Err(error) = started {
            self.updates
                .finish(Err(error.to_string()), &self.prefs.updates, manual);
        }
    }

    pub fn set_automatic_updates(&mut self, on: bool) {
        self.prefs.updates.automatic = on;
        if !on && !self.updates.manual {
            self.updates.prompt = false;
        }
        self.prefs.save(&self.host.dirs);
        if on {
            self.check_updates(false);
        }
    }

    pub fn show_update(&mut self) {
        self.updates.manual = true;
        self.updates.prompt = self.updates.available.is_some();
    }

    pub fn dismiss_update(&mut self, skip: bool) {
        self.updates.prompt = false;
        if skip {
            self.prefs.updates.skipped_version =
                self.updates.available.as_ref().map(|r| r.version.clone());
            self.prefs.save(&self.host.dirs);
        }
    }

    pub fn open_update(&mut self) {
        let Some(release) = self.updates.available.as_ref() else {
            return;
        };
        let url = release.url.clone();
        // The host constructs this URL from a validated repository and tag;
        // no remote release text or API-supplied URL reaches the opener.
        // On iOS this must run on the main event-loop thread.
        #[cfg(target_os = "ios")]
        self.update_browser_result(&url, webbrowser::open(&url).map_err(|e| e.to_string()));
        #[cfg(not(target_os = "ios"))]
        {
            // In particular, Linux can select a text browser that does not
            // return until it exits. Never park the editor behind that wait.
            self.dismiss_update(false);
            let target = url.clone();
            let started = std::thread::Builder::new()
                .name("release-browser".into())
                .spawn(move || {
                    let result = webbrowser::open(&target).map_err(|e| e.to_string());
                    on_ui(move |studio, _, _| studio.update_browser_result(&target, result));
                });
            if let Err(error) = started {
                self.update_browser_result(&url, Err(error.to_string()));
            }
        }
    }

    fn update_browser_result(&mut self, url: &str, result: Result<(), String>) {
        // A late handoff must not dismiss a different release's dialog.
        if self.updates.available.as_ref().is_none_or(|r| r.url != url) {
            return;
        }
        if let Err(error) = result {
            log::warn!("could not open release page: {error}");
            self.show_update();
            self.notify(
                &t("Could not open the browser. Copy the release link and open it manually."),
                true,
            );
        } else {
            self.dismiss_update(false);
        }
    }

    pub fn update_data(&self) -> UpdateData {
        let state = &self.updates;
        let release = state.available.as_ref();
        let status = if state.checking {
            t("Checking…")
        } else if !updates::supported_target(TARGET) {
            t("Update checks are unavailable for this platform.")
        } else if matches!(state.status, Status::Failed) {
            t("Could not check for updates. Check your connection and try again.")
        } else if let Some(release) = release {
            tf("Version {0} is available.", &[&release.version])
        } else if matches!(state.status, Status::Current) {
            t("No newer release is available for this platform and release channel.")
        } else {
            t("Updates have not been checked yet.")
        };
        UpdateData {
            // Keep the pending notification, but wait until editing/playback
            // and other sheets are out of the way before presenting it.
            open: state.should_present(
                self.playing
                    || self.echo.is_some()
                    || self.export.open
                    || self.relink.open
                    || self.project_sheet.open
                    || self.captions.open
                    || self.speech.open,
                self.settings.open,
            ),
            checking: state.checking,
            automatic: self.prefs.updates.automatic,
            version: release
                .map(|r| r.version.as_str())
                .unwrap_or_default()
                .into(),
            current_version: VERSION.trim_start_matches('v').into(),
            notes: release.map(|r| r.notes.as_str()).unwrap_or_default().into(),
            url: release.map(|r| r.url.as_str()).unwrap_or_default().into(),
            source: REPOSITORY.into(),
            status: status.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release() -> Release {
        Release {
            version: "0.3.0".into(),
            notes: String::new(),
            url: String::new(),
        }
    }

    #[test]
    fn old_preferences_enable_checks_without_losing_other_settings() {
        let prefs: crate::prefs::Preferences =
            serde_json::from_str(r#"{"locale":"fr","dark":false}"#).unwrap();
        assert!(prefs.updates.automatic);
        assert_eq!(prefs.locale.as_deref(), Some("fr"));
        assert_eq!(prefs.dark, Some(false));
        assert!(due(&prefs.updates, "owner/repo", 100));
    }

    #[test]
    fn automatic_checks_are_daily_and_handle_clock_or_repository_changes() {
        let mut prefs = UpdatePrefs {
            repository: "a/b".into(),
            last_check: Some(100),
            ..Default::default()
        };
        assert!(!due(&prefs, "a/b", 100));
        assert!(!due(&prefs, "a/b", 100 + DAY - 1));
        assert!(due(&prefs, "a/b", 100 + DAY));
        assert!(due(&prefs, "a/b", 90));
        assert!(due(&prefs, "a/c", 100));
        prefs.automatic = false;
        assert!(!due(&prefs, "a/c", u64::MAX));
    }

    #[test]
    fn skip_is_persisted_but_manual_checks_can_show_that_version() {
        let prefs = UpdatePrefs {
            skipped_version: Some("0.3.0".into()),
            ..Default::default()
        };
        let prefs: UpdatePrefs =
            serde_json::from_str(&serde_json::to_string(&prefs).unwrap()).unwrap();
        let mut state = UpdateState::default();
        state.finish(Ok(Some(release())), &prefs, false);
        assert!(!state.prompt);
        assert!(state.available.is_some());
        state.finish(Ok(Some(release())), &prefs, true);
        assert!(state.prompt);
        let newer = Release {
            version: "0.3.1".into(),
            ..release()
        };
        state.finish(Ok(Some(newer)), &prefs, false);
        assert!(state.prompt);
    }

    #[test]
    fn disabling_checks_suppresses_in_flight_automatic_results() {
        let prefs = UpdatePrefs {
            automatic: false,
            ..Default::default()
        };
        let mut state = UpdateState {
            checking: true,
            ..Default::default()
        };
        state.finish(Ok(Some(release())), &prefs, false);
        assert!(!state.checking);
        assert!(!state.prompt);
        state.finish(Ok(Some(release())), &prefs, true);
        assert!(state.prompt);
    }

    #[test]
    fn failed_checks_do_not_create_an_update_prompt() {
        let mut state = UpdateState {
            checking: true,
            ..Default::default()
        };
        state.finish(Err("offline".into()), &UpdatePrefs::default(), false);
        assert!(!state.checking);
        assert!(!state.prompt);
        assert!(matches!(state.status, Status::Failed));
    }

    #[test]
    fn busy_editing_defers_but_does_not_lose_a_notification() {
        let mut state = UpdateState::default();
        state.finish(Ok(Some(release())), &UpdatePrefs::default(), false);
        assert!(!state.should_present(true, false));
        assert!(!state.should_present(false, true));
        assert!(state.should_present(false, false));
        state.manual = true;
        assert!(state.should_present(false, true));
        assert!(!state.should_present(true, true));
        state.prompt = false;
        assert!(!state.should_present(false, false));
    }
}
