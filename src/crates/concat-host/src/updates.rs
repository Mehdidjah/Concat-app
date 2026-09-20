// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

//! Release notifications, never an installer.
//!
//! A check reads public release metadata from one build-configured GitHub
//! repository. It sends no project, machine identifier, or account data.
//! The caller decides when to check and whether to open the returned page;
//! this module never downloads or runs a release asset. Call it on a worker
//! thread, not the window thread.

use std::io::Read;
use std::time::Duration;

use semver::Version;
use serde::Deserialize;

// A release list can contain long notes and many assets. Bound the decoded
// response as well as the time spent reading it, including chunked bodies.
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_NOTES_CHARS: usize = 4000;

/// A newer published version with an installer for this target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    /// The version without the tag's optional `v` prefix.
    pub version: String,
    /// Plain release-note text, bounded for display in a window.
    pub notes: String,
    /// The canonical GitHub release page, constructed locally.
    pub url: String,
}

/// Whether the release workflow produces an installer for this Rust target.
pub fn supported_target(target: &str) -> bool {
    asset_suffixes(target).is_some()
}

/// Find the highest eligible version newer than `current` for `target`.
///
/// `repository` is a public GitHub `owner/name`, not a URL; `target` is a
/// Rust target triple. The most recent 100 releases are inspected, excluding
/// drafts and releases whose platform asset is not uploaded yet. A stable
/// installation sees stable releases only; a pre-release installation also
/// sees newer pre-releases. Versions are compared by SemVer precedence,
/// ignoring build metadata.
/// Network, malformed-response, and configuration errors remain distinct
/// from a successful check with no update.
pub fn check(repository: &str, current: &str, target: &str) -> Result<Option<Release>, String> {
    validate_repository(repository)?;
    let current = parse_current(current)?;
    let suffixes = asset_suffixes(target)
        .ok_or_else(|| format!("No release installer is defined for target {target}"))?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        // A renamed repository must be configured by the next build, not
        // silently redirect this request to an arbitrary response location.
        .redirects(0)
        .user_agent("Concat-release-check")
        .build();
    let response = agent
        .get(&format!(
            "https://api.github.com/repos/{repository}/releases?per_page=100"
        ))
        .set("Accept", "application/vnd.github+json")
        .set("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|error| format!("Could not check releases: {error}"))?;
    // ureq treats 3xx without a followed redirect as a response, not an
    // error. Only a successful JSON list is a completed update check.
    if response.status() != 200 {
        return Err(format!(
            "Unexpected release response status: {}",
            response.status()
        ));
    }
    let releases = read_releases(response.into_reader())?;
    Ok(select_release(repository, &current, suffixes, releases))
}

fn validate_repository(repository: &str) -> Result<(), String> {
    let valid = repository.split_once('/').is_some_and(|(owner, name)| {
        !owner.is_empty()
            && owner.len() <= 39
            && owner
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            && !owner.starts_with('-')
            && !owner.ends_with('-')
            && !name.is_empty()
            && name.len() <= 100
            && name != "."
            && name != ".."
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    });
    valid
        .then_some(())
        .ok_or_else(|| "Release repository must be a GitHub owner/name".to_owned())
}

fn parse_current(current: &str) -> Result<Version, String> {
    Version::parse(current.strip_prefix('v').unwrap_or(current))
        .map_err(|_| "The installed app version is not a semantic version".to_owned())
}

// These are the names produced by build-app.yml / mobile.yml and listed
// in scripts/models.py. Check architecture too: offering an Intel-only
// release to an ARM Linux installation is not a usable update.
fn asset_suffixes(target: &str) -> Option<&'static [&'static str]> {
    match target {
        "aarch64-apple-darwin" => Some(&["macos-arm64.dmg"]),
        "x86_64-apple-darwin" => Some(&["macos-x86_64.dmg"]),
        "x86_64-unknown-linux-gnu" => Some(&[
            "linux-x86_64.deb",
            "linux-x86_64.rpm",
            "linux-x86_64.AppImage",
        ]),
        "aarch64-unknown-linux-gnu" => Some(&[
            "linux-aarch64.deb",
            "linux-aarch64.rpm",
            "linux-aarch64.AppImage",
        ]),
        "x86_64-pc-windows-msvc" => Some(&["windows-x86_64-setup.exe", "windows-x86_64.msi"]),
        "aarch64-pc-windows-msvc" => Some(&["windows-aarch64-setup.exe", "windows-aarch64.msi"]),
        "aarch64-linux-android" => Some(&["android-arm64.apk"]),
        "aarch64-apple-ios" => Some(&["ios-arm64.ipa"]),
        _ => None,
    }
}

#[derive(Deserialize)]
struct PublishedRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    state: String,
    size: u64,
}

fn read_releases(reader: impl Read) -> Result<Vec<PublishedRelease>, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read releases: {error}"))?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("Release response is too large".to_owned());
    }
    let releases: Vec<PublishedRelease> = serde_json::from_slice(&bytes)
        .map_err(|_| "Release response is not a valid release list".to_owned())?;
    if releases.len() > 100 {
        return Err("Release response contains too many releases".to_owned());
    }
    Ok(releases)
}

fn select_release(
    repository: &str,
    current: &Version,
    suffixes: &[&str],
    releases: Vec<PublishedRelease>,
) -> Option<Release> {
    releases
        .into_iter()
        .filter_map(|release| {
            if release.draft || release.tag_name.len() > 128 {
                return None;
            }
            let version = Version::parse(
                release
                    .tag_name
                    .strip_prefix('v')
                    .unwrap_or(&release.tag_name),
            )
            .ok()?;
            // The tag and GitHub's flag must agree on the channel. SemVer
            // also limits the tag to URL-safe characters; no API-provided
            // link is opened. Stable users never switch to preview builds.
            let preview = !version.pre.is_empty();
            if release.prerelease != preview
                || (current.pre.is_empty() && preview)
                || !version.cmp_precedence(current).is_gt()
            {
                return None;
            }
            let prefix = format!("Concat-{version}-");
            // The workflow can append a pre-release suffix to a stable
            // workspace version, so v0.2.3-alpha.4 ships Concat-0.2.3-*.
            // Keep the exact version too for a workspace already carrying
            // the pre-release suffix in Cargo.toml.
            let base_prefix = format!(
                "Concat-{}.{}.{}-",
                version.major, version.minor, version.patch
            );
            let has_asset = release.assets.iter().any(|asset| {
                asset.state == "uploaded"
                    && asset.size > 0
                    && [&prefix, &base_prefix].iter().any(|prefix| {
                        asset
                            .name
                            .strip_prefix(prefix.as_str())
                            .is_some_and(|suffix| suffixes.contains(&suffix))
                    })
            });
            has_asset.then_some((version, release))
        })
        .max_by(|(left, _), (right, _)| left.cmp_precedence(right))
        .map(|(version, release)| Release {
            version: version.to_string(),
            notes: bounded_notes(release.body.as_deref().unwrap_or_default()),
            url: format!(
                "https://github.com/{repository}/releases/tag/{}",
                release.tag_name
            ),
        })
}

fn bounded_notes(notes: &str) -> String {
    let mut chars = notes.chars();
    let mut result: String = chars.by_ref().take(MAX_NOTES_CHARS).collect();
    if chars.next().is_some() {
        result.push('…');
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn published(version: &str, suffix: &str) -> Value {
        json!({
            "tag_name": format!("v{version}"),
            "draft": false,
            "prerelease": !Version::parse(version).unwrap().pre.is_empty(),
            "body": "Fixes and features.",
            "assets": [{
                "name": format!("Concat-{version}-{suffix}"),
                "state": "uploaded",
                "size": 1024,
            }],
        })
    }

    fn select(current: &str, target: &str, releases: Vec<Value>) -> Option<Release> {
        let bytes = serde_json::to_vec(&releases).unwrap();
        select_release(
            "owner/Concat",
            &parse_current(current).unwrap(),
            asset_suffixes(target).unwrap(),
            read_releases(bytes.as_slice()).unwrap(),
        )
    }

    #[test]
    fn numeric_versions_and_unordered_releases_choose_the_highest() {
        let result = select(
            "0.9.0",
            "aarch64-apple-darwin",
            vec![
                published("0.9.1", "macos-arm64.dmg"),
                published("0.11.0", "macos-arm64.dmg"),
                published("0.10.0", "macos-arm64.dmg"),
            ],
        )
        .unwrap();
        assert_eq!(result.version, "0.11.0");
        assert_eq!(
            result.url,
            "https://github.com/owner/Concat/releases/tag/v0.11.0"
        );
        assert_eq!(result.notes, "Fixes and features.");
    }

    #[test]
    fn equal_older_and_metadata_only_versions_are_not_updates() {
        assert!(
            select(
                "0.10.0+installed",
                "aarch64-apple-darwin",
                vec![
                    published("0.9.9", "macos-arm64.dmg"),
                    published("0.10.0", "macos-arm64.dmg"),
                    published("0.10.0+newbuild", "macos-arm64.dmg"),
                ],
            )
            .is_none()
        );
    }

    #[test]
    fn stable_version_replaces_an_installed_prerelease() {
        assert_eq!(
            select(
                "v1.0.0-beta.2",
                "aarch64-apple-darwin",
                vec![published("1.0.0", "macos-arm64.dmg")],
            )
            .unwrap()
            .version,
            "1.0.0"
        );
    }

    #[test]
    fn preview_channel_compares_numeric_identifiers_and_accepts_workspace_asset_names() {
        let mut tenth = published("0.2.3-alpha.10", "macos-arm64.dmg");
        tenth["assets"][0]["name"] = json!("Concat-0.2.3-macos-arm64.dmg");
        assert_eq!(
            select(
                "0.2.3-alpha.8",
                "aarch64-apple-darwin",
                vec![tenth, published("0.2.3-alpha.9", "macos-arm64.dmg")],
            )
            .unwrap()
            .version,
            "0.2.3-alpha.10"
        );
        assert!(
            select(
                "0.2.3-alpha.10+installed",
                "aarch64-apple-darwin",
                vec![published("0.2.3-alpha.10+newbuild", "macos-arm64.dmg")],
            )
            .is_none()
        );
    }

    #[test]
    fn prerelease_flag_and_tag_must_agree_even_on_preview_channel() {
        let mut false_stable = published("0.2.3-alpha.2", "macos-arm64.dmg");
        false_stable["prerelease"] = json!(false);
        let mut false_preview = published("0.2.3", "macos-arm64.dmg");
        false_preview["prerelease"] = json!(true);
        assert!(
            select(
                "0.2.3-alpha.1",
                "aarch64-apple-darwin",
                vec![false_stable, false_preview],
            )
            .is_none()
        );
    }

    #[test]
    fn drafts_prereleases_and_nonversion_tags_are_never_offered() {
        let mut draft = published("1.0.0", "macos-arm64.dmg");
        draft["draft"] = json!(true);
        let mut preview = published("2.0.0", "macos-arm64.dmg");
        preview["prerelease"] = json!(true);
        let mut models = published("3.0.0", "macos-arm64.dmg");
        models["tag_name"] = json!("models-v1");
        assert!(
            select(
                "0.1.0",
                "aarch64-apple-darwin",
                vec![
                    draft,
                    preview,
                    models,
                    published("4.0.0-beta.1", "macos-arm64.dmg"),
                ],
            )
            .is_none()
        );
    }

    #[test]
    fn all_shipping_targets_require_their_own_installer() {
        for (target, suffix) in [
            ("aarch64-apple-darwin", "macos-arm64.dmg"),
            ("x86_64-apple-darwin", "macos-x86_64.dmg"),
            ("x86_64-unknown-linux-gnu", "linux-x86_64.AppImage"),
            ("aarch64-unknown-linux-gnu", "linux-aarch64.rpm"),
            ("x86_64-pc-windows-msvc", "windows-x86_64-setup.exe"),
            ("aarch64-pc-windows-msvc", "windows-aarch64.msi"),
            ("aarch64-linux-android", "android-arm64.apk"),
            ("aarch64-apple-ios", "ios-arm64.ipa"),
        ] {
            assert!(supported_target(target));
            assert!(select("0.1.0", target, vec![published("0.2.0", suffix)]).is_some());
            assert!(select("0.1.0", target, vec![published("0.2.0", "source.zip")]).is_none());
        }
        assert!(!supported_target("wasm32-unknown-unknown"));
        assert!(!supported_target("aarch64-apple-ios-sim"));
    }

    #[test]
    fn wrong_architecture_version_and_unfinished_assets_are_not_updates() {
        let mut empty = published("0.2.0", "macos-arm64.dmg");
        empty["assets"][0]["size"] = json!(0);
        let mut uploading = published("0.3.0", "macos-arm64.dmg");
        uploading["assets"][0]["state"] = json!("starter");
        let mut mismatched = published("0.4.0", "macos-arm64.dmg");
        mismatched["assets"][0]["name"] = json!("Concat-0.3.0-macos-arm64.dmg");
        assert!(
            select(
                "0.1.0",
                "aarch64-apple-darwin",
                vec![
                    empty,
                    uploading,
                    mismatched,
                    published("0.5.0", "macos-x86_64.dmg"),
                ],
            )
            .is_none()
        );
    }

    #[test]
    fn missing_newest_target_falls_back_to_the_newest_compatible_release() {
        assert_eq!(
            select(
                "0.1.0",
                "aarch64-apple-darwin",
                vec![
                    published("0.3.0", "macos-x86_64.dmg"),
                    published("0.2.0", "macos-arm64.dmg"),
                ],
            )
            .unwrap()
            .version,
            "0.2.0"
        );
    }

    #[test]
    fn response_urls_cannot_change_the_opened_page() {
        let mut release = published("0.2.0", "macos-arm64.dmg");
        release["html_url"] = json!("file:///tmp/execute-me");
        release["assets"][0]["browser_download_url"] = json!("https://untrusted.example/app");
        assert_eq!(
            select("0.1.0", "aarch64-apple-darwin", vec![release])
                .unwrap()
                .url,
            "https://github.com/owner/Concat/releases/tag/v0.2.0"
        );
        let mut traversal = published("0.2.0", "macos-arm64.dmg");
        traversal["tag_name"] = json!("../settings");
        assert!(select("0.1.0", "aarch64-apple-darwin", vec![traversal]).is_none());
    }

    #[test]
    fn invalid_configuration_is_rejected_before_any_request() {
        for repository in [
            "",
            "https://github.com/owner/repo",
            "owner/repo/extra",
            "owner/..",
            "owner/repo?token=secret",
            "owner/repo#fragment",
            "-owner/repo",
            "owner/repo\n",
            "owner/répo",
        ] {
            assert!(check(repository, "0.1.0", "aarch64-apple-darwin").is_err());
        }
        assert!(validate_repository("owner-name/Concat.app_2").is_ok());
        assert!(check("owner/repo", "not-a-version", "aarch64-apple-darwin").is_err());
        assert!(check("owner/repo", "0.1.0", "unknown").is_err());
    }

    #[test]
    fn malformed_truncated_or_api_error_responses_are_errors() {
        for bytes in [
            b"[".as_slice(),
            b"[{\"tag_name\":\"v1.0.0\"}]",
            b"{\"message\":\"API rate limit exceeded\"}",
            b"<html>Error</html>",
        ] {
            assert!(read_releases(bytes).is_err());
        }
        assert!(read_releases(b"[]".as_slice()).unwrap().is_empty());
    }

    #[test]
    fn oversized_responses_and_excess_release_counts_are_rejected() {
        let huge = std::io::repeat(b' ').take(MAX_RESPONSE_BYTES + 20);
        assert_eq!(
            read_releases(huge).err().unwrap(),
            "Release response is too large"
        );
        let releases = vec![published("0.2.0", "macos-arm64.dmg"); 101];
        let bytes = serde_json::to_vec(&releases).unwrap();
        assert!(read_releases(bytes.as_slice()).is_err());
    }

    #[test]
    fn notes_are_optional_and_unicode_safe_when_bounded() {
        let mut release = published("0.2.0", "macos-arm64.dmg");
        release["body"] = Value::Null;
        assert!(
            select("0.1.0", "aarch64-apple-darwin", vec![release])
                .unwrap()
                .notes
                .is_empty()
        );
        let notes = "é".repeat(MAX_NOTES_CHARS + 1);
        let bounded = bounded_notes(&notes);
        assert_eq!(bounded.chars().count(), MAX_NOTES_CHARS + 1);
        assert!(bounded.ends_with('…'));
        assert_eq!(bounded_notes("Short note"), "Short note");
    }
}
