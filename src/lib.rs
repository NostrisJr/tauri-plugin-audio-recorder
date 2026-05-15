use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;
mod paths;

pub use error::{Error, Result};
pub use paths::{get_cache_dir, get_recordings_dir, resolve_output_path, validate_path};

#[cfg(desktop)]
use desktop::AudioRecorder;
#[cfg(mobile)]
use mobile::AudioRecorder;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the audio-recorder APIs.
pub trait AudioRecorderExt<R: Runtime> {
    fn audio_recorder(&self) -> &AudioRecorder<R>;
}

impl<R: Runtime, T: Manager<R>> crate::AudioRecorderExt<R> for T {
    fn audio_recorder(&self) -> &AudioRecorder<R> {
        self.state::<AudioRecorder<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // Sur mobile, pas de Rust invoke_handler : toutes les invocations (y compris
    // registerListener / removeListener du Plugin.swift de base) passent directement
    // au plugin iOS/Android. Sur desktop, les commandes sont gérées côté Rust.
    #[allow(unused_mut)]
    let mut builder = Builder::new("audio-recorder");

    #[cfg(desktop)]
    {
        builder = builder.invoke_handler(tauri::generate_handler![
            commands::start_recording,
            commands::stop_recording,
            commands::pause_recording,
            commands::resume_recording,
            commands::get_status,
            commands::get_devices,
            commands::check_permission,
            commands::request_permission,
        ]);
    }

    builder
        .setup(|app, api| {
            #[cfg(mobile)]
            let audio_recorder = mobile::init(app, api)?;
            #[cfg(desktop)]
            let audio_recorder = desktop::init(app, api)?;
            app.manage(audio_recorder);
            Ok(())
        })
        .build()
}
