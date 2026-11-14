use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use webkit2gtk::glib::{self, prelude::{Cast, ObjectType}};
use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};

/// WebKitGTK denies unhandled microphone requests. Let the editor grant the main webview access for voice input.
pub fn enable_voice_input(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let dev_url = if tauri::is_dev() { window.config().build.dev_url.clone() } else { None };
    let owner = window.clone();
    window.with_webview(move |webview| {
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(move |view, request| {
            let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else { return false };
            let url = view.uri().and_then(|uri| url::Url::parse(&uri).ok());
            let from_editor = url.is_some_and(|url|
                (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
                || dev_url.as_ref().is_some_and(|dev| dev.origin() == url.origin()));
            // Audio can accompany a display capture too. WebKit exposes this check in its C API.
            let display = unsafe { webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(media.as_ptr()) != 0 };
            if !from_editor || display || media.is_for_video_device() || !media.is_for_audio_device() {
                request.deny();
                return true;
            }
            let (send, answer) = tokio::sync::oneshot::channel();
            owner.dialog().message("Allow Scarlet to use your microphone for voice input?")
                .parent(&owner).buttons(MessageDialogButtons::OkCancelCustom("Allow".into(), "Cancel".into()))
                .show(move |allow| { let _ = send.send(allow); });
            // The dialog can answer from another thread. Resolve WebKit's request on the GTK thread.
            let request = request.clone();
            glib::MainContext::default().spawn_local(async move {
                if answer.await == Ok(true) { request.allow(); } else { request.deny(); }
            });
            true
        });
    })
}
