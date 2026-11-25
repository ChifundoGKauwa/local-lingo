use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct ExtensionModelManager {
    text_history: Vec<String>,
    max_history_items: usize,
}

#[wasm_bindgen]
impl ExtensionModelManager {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            text_history: Vec::new(),
            max_history_items: 10,
        }
    }

    /// Receives raw transcription chunks from Transformers.js,
    /// deduplicates them against recent history, and formats them cleanly.
    pub fn process_transcript_chunk(&mut self, raw_text: &str) -> String {
        let cleaned_text = raw_text.trim();
        if cleaned_text.is_empty() {
            return String::new();
        }

        // Simple text deduplication check against the immediate last segment
        if let Some(last_segment) = self.text_history.last() {
            if last_segment == cleaned_text {
                return String::new(); // Skip duplicate string drops
            }
        }

        // Maintain historical text size limits
        if self.text_history.len() >= self.max_history_items {
            self.text_history.remove(0);
        }
        self.text_history.push(cleaned_text.to_string());

        // Return a beautifully capitalized or formatted string block
        format!(" {}", cleaned_text)
    }

    /// Clears the historical state when a user stops or resets a recording session
    pub fn reset_session(&mut self) {
        self.text_history.clear();
    }
}
