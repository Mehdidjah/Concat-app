//! The engine-owned editing session, exposed to the UI.
//!
//! One session at a time, held in managed state: open a project and the
//! engine holds the edit; every mutation arrives as a `relay_project`
//! [`Command`], is applied with undo recorded, and the new state goes back
//! over the wire. This is the API `lib/editor.ts` mirrors; the provisional
//! TypeScript model it replaced is gone - see
//! `engine/docs/decisions/0007-engine-owns-the-project.md`.
//!
//! Saving reuses `projects::save`'s temp-file-and-rename, so the document on
//! disk is written by exactly one code path whichever side owns the model.

use std::sync::Mutex;

use relay_project::{Command, DocumentSettings, Editor};
use serde::Serialize;

use crate::projects;

/// The one editing session, or None before a project is opened.
pub struct EditorState(pub Mutex<Option<Session>>);

pub struct Session {
    /// The project folder, for saving.
    path: String,
    settings: DocumentSettings,
    editor: Editor,
}

/// What every mutating call returns: the authoritative state plus history
/// availability, so the UI's undo/redo affordances are never guessing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorView {
    project: relay_project::Project,
    can_undo: bool,
    can_redo: bool,
    /// The settings as the session holds them - the document's own output
    /// size wins over the manifest's on open, exactly as the old loader
    /// preferred it.
    settings: SettingsView,
    /// The id a creating command minted, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    created_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    name: String,
    width: u32,
    height: u32,
    rate_num: i64,
    rate_den: i64,
}

fn view(session: &Session, created_id: Option<String>) -> EditorView {
    EditorView {
        project: session.editor.project().clone(),
        can_undo: session.editor.can_undo(),
        can_redo: session.editor.can_redo(),
        settings: SettingsView {
            name: session.settings.name.clone(),
            width: session.settings.width,
            height: session.settings.height,
            rate_num: session.settings.rate_num,
            rate_den: session.settings.rate_den,
        },
        created_id,
    }
}

/// The open session's document, project folder and settings, for features
/// that package the current edit (saving it as a template) rather than
/// editing it.
pub fn session_snapshot(
    state: &EditorState,
) -> Result<(serde_json::Value, String, DocumentSettings), String> {
    with_session(state, |session| {
        Ok((
            session.editor.to_document(&session.settings),
            session.path.clone(),
            session.settings.clone(),
        ))
    })
}

fn with_session<T>(
    state: &EditorState,
    operation: impl FnOnce(&mut Session) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "editor state poisoned".to_owned())?;
    let session = guard.as_mut().ok_or("no project is open")?;
    operation(session)
}

/// Opens a project folder as the editing session and returns its state.
///
/// A folder whose document is missing or unreadable opens as an empty
/// project rather than failing - the same grace the TS loader extends -
/// but a *corrupt* document is an error, because silently replacing an
/// edit with emptiness is how projects get lost.
#[tauri::command]
pub fn editor_open(
    state: tauri::State<'_, EditorState>,
    path: String,
    name: String,
    width: u32,
    height: u32,
    rate_num: i64,
    rate_den: i64,
) -> Result<EditorView, String> {
    let mut settings = DocumentSettings { name, width, height, rate_num, rate_den };
    let editor = match projects::read_document(&path) {
        Ok(document) => {
            // The document's frame wins over the manifest: it is where an
            // edited output size was saved.
            if let Some(video) = document.get("video") {
                if let (Some(width), Some(height)) = (
                    video.get("width").and_then(|value| value.as_u64()),
                    video.get("height").and_then(|value| value.as_u64()),
                ) {
                    if width > 0 && height > 0 {
                        settings.width = width as u32;
                        settings.height = height as u32;
                    }
                }
            }
            Editor::from_document(&document)
                .ok_or_else(|| format!("{path} holds a document this build cannot read"))?
        }
        // No document yet - a project created moments ago.
        Err(_) => Editor::new(),
    };

    let mut guard = state.0.lock().map_err(|_| "editor state poisoned".to_owned())?;
    *guard = Some(Session { path, settings, editor });
    let session = guard.as_ref().expect("just set");
    Ok(view(session, None))
}

/// Applies one edit command and returns the new state.
#[tauri::command]
pub fn editor_apply(
    state: tauri::State<'_, EditorState>,
    command: Command,
) -> Result<EditorView, String> {
    with_session(&state, |session| {
        let outcome = session.editor.apply(command)?;
        Ok(view(session, outcome.created_id))
    })
}

#[tauri::command]
pub fn editor_undo(state: tauri::State<'_, EditorState>) -> Result<EditorView, String> {
    with_session(&state, |session| {
        session.editor.undo();
        Ok(view(session, None))
    })
}

#[tauri::command]
pub fn editor_redo(state: tauri::State<'_, EditorState>) -> Result<EditorView, String> {
    with_session(&state, |session| {
        session.editor.redo();
        Ok(view(session, None))
    })
}

/// The current state without changing anything.
#[tauri::command]
pub fn editor_state(state: tauri::State<'_, EditorState>) -> Result<EditorView, String> {
    with_session(&state, |session| Ok(view(session, None)))
}

/// Writes the session's document to its project folder. The output size can
/// have been edited in the preview footer, so it rides along here.
#[tauri::command]
pub fn editor_save(
    state: tauri::State<'_, EditorState>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(), String> {
    with_session(&state, |session| {
        if let Some(width) = width {
            session.settings.width = width;
        }
        if let Some(height) = height {
            session.settings.height = height;
        }
        let document = session.editor.to_document(&session.settings);
        projects::save(&session.path, &document)
    })
}

/// Closes the session, dropping its undo history.
#[tauri::command]
pub fn editor_close(state: tauri::State<'_, EditorState>) {
    if let Ok(mut guard) = state.0.lock() {
        *guard = None;
    }
}
