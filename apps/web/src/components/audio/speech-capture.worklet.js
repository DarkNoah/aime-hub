// Batch mono PCM to avoid posting a message for every 128-sample render quantum.
class SpeechCaptureProcessor extends AudioWorkletProcessor {
  buffer = new Float32Array(2048);
  offset = 0;

  constructor() {
    super();
    this.port.onmessage = () => {
      this.flush();
      this.port.postMessage('flushed');
    };
  }

  flush() {
    if (!this.offset) return;
    const chunk = this.buffer.slice(0, this.offset);
    this.port.postMessage(chunk, [chunk.buffer]);
    this.offset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame++) {
      let sample = 0;
      for (const channel of channels) sample += channel[frame];
      this.buffer[this.offset++] = sample / channels.length;
      if (this.offset === this.buffer.length) this.flush();
    }
    return true;
  }
}

registerProcessor('speech-capture', SpeechCaptureProcessor);
