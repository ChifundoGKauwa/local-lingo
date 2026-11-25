pub mod audio;
pub mod model;

// Export both managers to the compiled wasm-pack build output
pub use audio::BrowserAudioProcessor;
pub use model::ExtensionModelManager;
