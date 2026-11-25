class TabAudioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.phase = 0;
    this.batch = new Float32Array(4096);
    this.batchOffset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }
    if (!input?.length || !input[0]?.length) return true;

    const frames = input[0].length;
    const mono = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (const channel of input) sum += channel[frame] || 0;
      mono[frame] = sum / input.length;
    }

    let position = this.phase;
    while (position < frames) {
      const index = Math.floor(position);
      const fraction = position - index;
      // Interpolate between the samples surrounding the fractional source
      // position. Using the previous block's last sample at position zero
      // introduced a discontinuity at every render quantum (audible as clicks).
      const left = mono[index];
      const right = mono[Math.min(index + 1, frames - 1)];
      this.batch[this.batchOffset] = left + fraction * (right - left);
      this.batchOffset += 1;
      position += this.ratio;

      if (this.batchOffset === this.batch.length) {
        const chunk = this.batch;
        this.batch = new Float32Array(4096);
        this.batchOffset = 0;
        this.port.postMessage(chunk, [chunk.buffer]);
      }
    }

    this.phase = position - frames;
    return true;
  }
}

registerProcessor("tab-audio-capture", TabAudioCaptureProcessor);
