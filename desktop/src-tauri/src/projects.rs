//! Project folders on disk, and the list of recently opened ones.
//!
//! A project is a directory containing `relay.json`. That file is written the
//! moment the project is created, so a project is a real thing from the start
//! rather than a promise the app keeps only if you remember to save.
//!
//! The recents list lives in the app's config directory, not in any project.
//! It describes this machine's history, and copying a project folder to
//! another machine should not drag one person's recent files along with it.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MANIFEST: &str = "relay.json";
const RECENTS: &str = "recents.json";
/// Long enough to be useful, short enough that the list stays scannable.
const MAX_RECENTS: usize = 12;

/// Everything needed to reopen a project.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Frame rate as an exact fraction; the decimal is never stored.
    pub rate_num: i64,
    pub rate_den: i64,
    /// Milliseconds since the epoch.
    pub opened_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    relay: String,
    name: String,
    video: Video,
    /// Everything else in the file is ignored when reading settings for the
    /// recents list. `flatten` keeps it from being dropped on a rewrite.
    #[serde(flatten)]
    #[allow(dead_code)]
    rest: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Video {
    width: u32,
    height: u32,
    rate_num: i64,
    rate_den: i64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Creates the project folder and writes its manifest.
///
/// Refuses to touch a folder that already holds a manifest. Overwriting
/// someone's edit because they reused a name is not a recoverable mistake.
pub fn create(
    location: &str,
    name: &str,
    width: u32,
    height: u32,
    rate_num: i64,
    rate_den: i64,
) -> Result<ProjectInfo, String> {
    let root = Path::new(location).join(folder_name(name));
    let manifest = root.join(MANIFEST);

    if manifest.exists() {
        return Err(format!("a Relay project already exists at {}", root.display()));
    }

    std::fs::create_dir_all(&root)
        .map_err(|error| format!("could not create {}: {error}", root.display()))?;

    // Only the settings for now. The timeline joins them once the engine owns
    // the edit and there is a canonical form to serialise.
    let document = Manifest {
        relay: env!("CARGO_PKG_VERSION").to_owned(),
        name: name.to_owned(),
        video: Video { width, height, rate_num, rate_den },
        rest: serde_json::Map::new(),
    };

    let encoded = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("could not encode the manifest: {error}"))?;
    std::fs::write(&manifest, encoded)
        .map_err(|error| format!("could not write {}: {error}", manifest.display()))?;

    Ok(ProjectInfo {
        path: root.to_string_lossy().into_owned(),
        name: name.to_owned(),
        width,
        height,
        rate_num,
        rate_den,
        opened_at: now_millis(),
    })
}

/// Writes the whole project document to `relay.json`.
///
/// The document is passed through as opaque JSON rather than being mirrored
/// into Rust types. The edit model is still provisional and lives in the UI
/// (see `lib/project.ts`); duplicating it here would mean changing two
/// definitions in lockstep for no benefit, and the host has no decisions to
/// make about its contents.
///
/// Written to a temporary file and renamed into place, because a save
/// interrupted halfway is worse than no save at all - a truncated relay.json
/// loses the project, while a failed rename leaves the previous one intact.
pub fn save(path: &str, document: &serde_json::Value) -> Result<(), String> {
    let root = PathBuf::from(path);
    let manifest = root.join(MANIFEST);
    let temporary = root.join(format!("{MANIFEST}.saving"));

    std::fs::create_dir_all(&root)
        .map_err(|error| format!("could not create {}: {error}", root.display()))?;

    let encoded = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("could not encode the project: {error}"))?;

    std::fs::write(&temporary, encoded)
        .map_err(|error| format!("could not write {}: {error}", temporary.display()))?;

    std::fs::rename(&temporary, &manifest)
        .map_err(|error| format!("could not replace {}: {error}", manifest.display()))
}

/// Reads the whole project document back.
pub fn read_document(path: &str) -> Result<serde_json::Value, String> {
    let manifest = PathBuf::from(path).join(MANIFEST);
    let bytes = std::fs::read(&manifest)
        .map_err(|error| format!("could not read {}: {error}", manifest.display()))?;

    serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is not a Relay project: {error}", manifest.display()))
}

/// Reads an existing project's settings.
pub fn open(path: &str) -> Result<ProjectInfo, String> {
    let root = PathBuf::from(path);
    let manifest = root.join(MANIFEST);

    let bytes = std::fs::read(&manifest)
        .map_err(|error| format!("could not read {}: {error}", manifest.display()))?;
    let document: Manifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} is not a Relay project: {error}", manifest.display()))?;

    if document.video.rate_den == 0 {
        return Err(format!("{} has an invalid frame rate", manifest.display()));
    }

    Ok(ProjectInfo {
        path: root.to_string_lossy().into_owned(),
        name: document.name,
        width: document.video.width,
        height: document.video.height,
        rate_num: document.video.rate_num,
        rate_den: document.video.rate_den,
        opened_at: now_millis(),
    })
}

/// Moves a project to the front of the recents list.
pub fn remember(config: &Path, project: &ProjectInfo) -> Result<(), String> {
    let mut entries = read_recents(config);
    entries.retain(|entry| !same_path(&entry.path, &project.path));
    entries.insert(0, project.clone());
    entries.truncate(MAX_RECENTS);
    write_recents(config, &entries)
}

/// The recents list, most recent first, with vanished folders dropped.
///
/// Filtering on read rather than pruning on write means a project on a drive
/// that happens to be unplugged comes back when the drive does.
pub fn list(config: &Path) -> Vec<ProjectInfo> {
    read_recents(config)
        .into_iter()
        .filter(|entry| Path::new(&entry.path).join(MANIFEST).exists())
        .collect()
}

/// Removes one project from the list. The folder itself is left alone.
pub fn forget(config: &Path, path: &str) -> Result<(), String> {
    let mut entries = read_recents(config);
    entries.retain(|entry| !same_path(&entry.path, path));
    write_recents(config, &entries)
}

fn read_recents(config: &Path) -> Vec<ProjectInfo> {
    // A missing or corrupt list is not an error worth showing anyone; it just
    // means there is no history yet.
    std::fs::read(config.join(RECENTS))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_recents(config: &Path, entries: &[ProjectInfo]) -> Result<(), String> {
    std::fs::create_dir_all(config)
        .map_err(|error| format!("could not create {}: {error}", config.display()))?;

    let encoded = serde_json::to_vec_pretty(entries)
        .map_err(|error| format!("could not encode the recents list: {error}"))?;
    std::fs::write(config.join(RECENTS), encoded)
        .map_err(|error| format!("could not write the recents list: {error}"))
}

/// Compares paths case-insensitively, because Windows does.
fn same_path(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

/// Turns a project name into something a filesystem will accept.
fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|character| {
            if character.is_control() || r#"<>:"/\|?*"#.contains(character) {
                '-'
            } else {
                character
            }
        })
        .collect();

    // Windows refuses names ending in a dot or a space.
    let trimmed = cleaned.trim_matches(['.', ' ']);
    if trimmed.is_empty() {
        "Untitled project".to_owned()
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitises_names_windows_would_reject() {
        assert_eq!(folder_name("My: Project?"), "My- Project-");
        assert_eq!(folder_name("  trailing.  "), "trailing");
        assert_eq!(folder_name("..."), "Untitled project");
        assert_eq!(folder_name(""), "Untitled project");
    }

    #[test]
    fn paths_compare_case_insensitively() {
        assert!(same_path("D:\\Work\\Film", "d:\\work\\film"));
        assert!(!same_path("D:\\Work\\Film", "D:\\Work\\Other"));
    }
}
