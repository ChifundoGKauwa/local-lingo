use wasm_bindgen::prelude::*;

pub struct Resampler {
    pub input_rate: f32,
    pub target_rate: f32,
    last_sample: f32,
    phase: f32,
}

impl Resampler {
    pub fn new(input_rate: u32) -> Self {
        Self {
            input_rate: input_rate as f32,
            target_rate: 16000.0, // Whisper requirement
            last_sample: 0.0,
            phase: 0.0,
        }
    }

    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        let ratio = self.input_rate / self.target_rate;
        let mut input_pos = self.phase;

        while input_pos < input.len() as f32 {
            let idx = input_pos.floor() as usize;
            let frac = input_pos - idx as f32;
            let left = if idx == 0 {
                self.last_sample
            } else {
                input[idx - 1]
            };
            let right = input[idx];

            output.push(left + frac * (right - left));
            input_pos += ratio;
        }
        self.phase = input_pos - input.len() as f32;
        self.last_sample = *input.last().unwrap();
    }
}

pub struct HighPassFilter {
    last_input: f32,
}

impl HighPassFilter {
    pub fn new() -> Self {
        Self { last_input: 0.0 }
    }

    pub fn process(&mut self, samples: &mut [f32]) {
        for sample in samples.iter_mut() {
            let current_input = *sample;
            *sample = current_input - 0.95 * self.last_input;
            self.last_input = current_input;
        }
    }
}

/// The Orchestrator exposed directly to JavaScript/WASM.
/// This replaces your old `AudioInput` struct.
#[wasm_bindgen]
pub struct BrowserAudioProcessor {
    channels: u16,
    filter: HighPassFilter,
    resampler: Resampler,
}

#[wasm_bindgen]
impl BrowserAudioProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new(input_sample_rate: u32, channels: u16) -> Self {
        Self {
            channels,
            filter: HighPassFilter::new(),
            resampler: Resampler::new(input_sample_rate),
        }
    }

    /// JavaScript calls this function directly inside the audio loop to clean and
    /// downmix incoming microphone or tab audio before feeding it to Whisper.
    pub fn process_buffer(&mut self, raw_samples: &[f32]) -> Vec<f32> {
        // 1. Downmix multi-channel streams into mono
        let mut mono: Vec<f32> = if self.channels == 1 {
            raw_samples.to_vec()
        } else {
            raw_samples
                .chunks_exact(self.channels as usize)
                .map(|chunk| chunk.iter().sum::<f32>() / self.channels as f32)
                .collect()
        };

        // 2. Apply your HighPassFilter
        self.filter.process(&mut mono);

        // 3. Resample the chunk to 16kHz
        let ratio = self.resampler.input_rate / self.resampler.target_rate;
        let mut resampled = Vec::with_capacity((mono.len() as f32 / ratio) as usize + 1);
        self.resampler.process(&mono, &mut resampled);

        resampled
    }
}
