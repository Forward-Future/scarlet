//! Asking before Scarlet quits with work under way. Closing the window quits Scarlet, and so does ⌘Q: each asks the
//! engine what quitting would stop, says so in a native question, and quits at once when nothing would.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::host::api::Api;
use crate::AppState;

/// The menu item that stands in for the standard Quit, which ends Scarlet without a word.
#[cfg(target_os = "macos")]
pub const QUIT_MENU_ID: &str = "scarlet-quit";

/// What the engine says quitting would stop (GET /api/under-way).
#[derive(Debug, Default, Deserialize, PartialEq)]
pub struct UnderWay {
    #[serde(default)]
    pub edits: u32,
    #[serde(default)]
    pub queued: u32,
    #[serde(default)]
    pub exports: u32,
}

/// Why Scarlet is closing: the editor quit, or pressed Restart to update, after which it opens again by itself.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Leaving {
    Quit,
    Restart,
}

/// The question to ask before quitting or restarting, naming what would stop. None when nothing would.
pub fn warning(work: &UnderWay, leaving: Leaving) -> Option<String> {
    let name = |n: u32, one: &str, many: &str| match n {
        0 => None,
        1 => Some(one.to_string()),
        n => Some(many.replace("{n}", &n.to_string())),
    };
    let parts: Vec<String> = [
        name(work.edits, "the edit Scarlet is working on", "the {n} edits Scarlet is working on"),
        name(work.queued, "an edit waiting its turn", "{n} edits waiting their turn"),
        name(work.exports, "an export", "{n} exports"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let list = match parts.as_slice() {
        [] => return None,
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    // A run cut short by a quit resumes at the next launch, a queued edit starts then, and an export renders again.
    let carry_on = if work.edits + work.queued + work.exports == 1 { "It carries on" } else { "They carry on" };
    Some(match leaving {
        Leaving::Quit => format!("Quitting stops {list}. {carry_on} when you open Scarlet again."),
        Leaving::Restart => format!("Restarting stops {list}. {carry_on} when Scarlet reopens."),
    })
}

/// Ask the engine what quitting would stop. None when it can't say in a moment.
pub async fn under_way(url: &str, token: &str) -> Option<UnderWay> {
    match tokio::time::timeout(Duration::from_secs(2), Api::new(url, Some(token)).get::<UnderWay>("/under-way")).await {
        Ok(Ok(work)) => Some(work),
        Ok(Err(e)) => {
            log::warn!("could not ask the engine what quitting would stop: {e}");
            None
        }
        Err(_) => {
            log::warn!("the engine did not say in time what quitting would stop");
            None
        }
    }
}

/// What quitting would stop: what the engine says, or else the runs the agent host here has under way. An engine
/// that is gone or stuck can't say, and its exports are lost with it, but the runs here would still be cut short.
fn what_would_stop(engine: Option<UnderWay>, running_here: usize) -> UnderWay {
    engine.unwrap_or(UnderWay { edits: running_here as u32, ..Default::default() })
}

/// The window goes first: stopping the agents and the engine can take some seconds, and a window left on screen
/// meanwhile reads as Scarlet frozen.
fn quit_now(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    app.exit(0);
}

/// Return the editor's choice if ending this session would stop work.
pub async fn confirm_if_busy(app: &AppHandle, leaving: Leaving) -> bool {
    let doing = if leaving == Leaving::Quit { "quitting" } else { "restarting" };
    let Some(state) = app.try_state::<AppState>() else {
        log::info!("{doing} at once: Scarlet has not finished starting, so nothing is under way");
        return true;
    };
    let engine = state.engine.status();
    let said = match (engine.url.as_deref(), engine.token.as_deref()) {
        (Some(url), Some(token)) => under_way(url, token).await,
        _ => None,
    };
    let running_here = state.host.status().await.running.len();
    let Some(asked) = warning(&what_would_stop(said, running_here), leaving) else {
        log::info!("{doing} at once: nothing under way");
        return true;
    };
    log::info!("asking before {doing}: {asked}");
    let (title, yes) = if leaving == Leaving::Quit { ("Quit Scarlet?", "Quit") } else { ("Restart Scarlet?", "Restart") };
    let dialog = app.dialog().message(asked).title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), "Cancel".into()));
    #[cfg(windows)]
    let dialog = match app.get_webview_window("main") {
        Some(window) => dialog.parent(&window),
        None => dialog,
    };
    let (answer, received) = tokio::sync::oneshot::channel();
    dialog.show(move |yes| { let _ = answer.send(yes); });
    let yes_answered = received.await.unwrap_or(false);
    log::info!("asked before {doing}: the editor chose {}", if yes_answered { yes } else { "Cancel" });
    yes_answered
}

/// Close the window or quit: ask first when that would stop work, and quit at once when it wouldn't. `via` says what
/// asked to quit (the window or the menu), for the log.
pub fn ask_before_quitting(app: &AppHandle, via: &'static str) {
    static ASKING: AtomicBool = AtomicBool::new(false);
    // Another ⌘W while Scarlet asks gets the same question.
    if ASKING.swap(true, Ordering::SeqCst) {
        log::info!("quit requested via {via} while Scarlet is already asking; left to that question");
        return;
    }
    log::info!("quit requested via {via}");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if confirm_if_busy(&app, Leaving::Quit).await {
            log::info!("quitting (requested via {via})");
            quit_now(&app);
        } else {
            log::info!("quit cancelled; Scarlet stays open");
            ASKING.store(false, Ordering::SeqCst);
        }
    });
}

/// The standard Mac menu, with a Quit that asks first in place of the standard one.
#[cfg(target_os = "macos")]
pub fn menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    // The app's own menu comes first, and Quit is its last item.
    if let Some(MenuItemKind::Submenu(scarlet)) = menu.items()?.into_iter().next() {
        if let Some(MenuItemKind::Predefined(standard)) = scarlet.items()?.last() {
            let quit = MenuItem::with_id(app, QUIT_MENU_ID, format!("Quit {}", app.package_info().name), true, Some("CmdOrCtrl+Q"))?;
            scarlet.remove(standard)?;
            scarlet.append(&quit)?;
        }
    }
    Ok(menu)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::api::fake;

    #[test]
    fn names_what_quitting_would_stop() {
        let asks = |edits, queued, exports| warning(&UnderWay { edits, queued, exports }, Leaving::Quit);
        assert_eq!(asks(0, 0, 0), None);
        assert_eq!(asks(1, 0, 0).as_deref(), Some("Quitting stops the edit Scarlet is working on. It carries on when you open Scarlet again."));
        assert_eq!(asks(1, 2, 0).as_deref(), Some("Quitting stops the edit Scarlet is working on and 2 edits waiting their turn. They carry on when you open Scarlet again."));
        assert_eq!(asks(2, 1, 1).as_deref(), Some("Quitting stops the 2 edits Scarlet is working on, an edit waiting its turn and an export. They carry on when you open Scarlet again."));
        assert_eq!(asks(0, 0, 3).as_deref(), Some("Quitting stops 3 exports. They carry on when you open Scarlet again."));
        // Restart to update opens Scarlet again by itself, and says so in its own words.
        let restart = |edits, queued| warning(&UnderWay { edits, queued, exports: 0 }, Leaving::Restart);
        assert_eq!(restart(0, 0), None);
        assert_eq!(restart(1, 0).as_deref(), Some("Restarting stops the edit Scarlet is working on. It carries on when Scarlet reopens."));
        assert_eq!(restart(1, 2).as_deref(), Some("Restarting stops the edit Scarlet is working on and 2 edits waiting their turn. They carry on when Scarlet reopens."));
    }

    #[tokio::test]
    async fn asks_the_engine_and_else_counts_the_runs_here_before_quitting_at_once() {
        let busy = fake::engine(|route, _| match route {
            "GET /api/under-way" => (200, r#"{"edits":1,"queued":0,"exports":1}"#.into()),
            _ => (404, String::new()),
        })
        .await;
        let said = under_way(&busy.url, "sct_t").await;
        assert_eq!(said, Some(UnderWay { edits: 1, queued: 0, exports: 1 }));
        assert_eq!(warning(&what_would_stop(said, 1), Leaving::Quit).as_deref(), Some("Quitting stops the edit Scarlet is working on and an export. They carry on when you open Scarlet again."));
        // The engine's word stands over the host's: nothing under way, so Scarlet quits at once.
        let idle = fake::engine(|_, _| (200, r#"{"edits":0,"queued":0,"exports":0}"#.into())).await;
        assert_eq!(warning(&what_would_stop(under_way(&idle.url, "sct_t").await, 0), Leaving::Quit), None);
        // An engine that has gone, or one too old to say, can't: the runs under way here are what quitting would stop.
        let gone = format!("http://{}", std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap());
        let old = fake::engine(|_, _| (404, r#"{"error":{"code":"not_found","message":"Not found"}}"#.into())).await;
        for silent in [under_way(&gone, "sct_t").await, under_way(&old.url, "sct_t").await] {
            assert_eq!(silent, None);
            assert_eq!(warning(&what_would_stop(None, 2), Leaving::Quit).as_deref(), Some("Quitting stops the 2 edits Scarlet is working on. They carry on when you open Scarlet again."));
            assert_eq!(warning(&what_would_stop(silent, 0), Leaving::Quit), None);
        }
    }
}
