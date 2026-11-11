// Corre dentro del "hilo de audio" del navegador.
// Recibe la señal de entrada (iRig) y la manda en bloques al programa principal,
// junto con el número de muestra exacto en que empieza cada bloque.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1024;               // muestras por bloque (~21 ms a 48 kHz)
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.blockStart = 0;
    this.peak = 0;
    this.meterCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;

    if (this.n === 0) this.blockStart = currentFrame;
    this.buf.set(ch, this.n);
    this.n += ch.length;

    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > this.peak) this.peak = a;
    }

    if (this.n >= this.size) {
      this.port.postMessage(
        { type: 'chunk', frame: this.blockStart, data: this.buf, peak: this.peak },
        [this.buf.buffer]
      );
      this.buf = new Float32Array(this.size);
      this.n = 0;
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
