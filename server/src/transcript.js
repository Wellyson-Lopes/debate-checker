/**
 * Junta os trechos finais do Deepgram em "falas" (um turno de um mesmo falante).
 * Uma fala é entregue quando o falante muda, quando o Deepgram marca fim de fala, ou após um tempo parado.
 */
export class TurnAssembler {
  constructor(onTurn, { idleMs = 3500, maxChars = 600 } = {}) {
    this.onTurn = onTurn;
    this.idleMs = idleMs;
    this.maxChars = maxChars;
    this.pending = null;
    this.timer = null;
    this.lastSpeaker = 0;
  }

  push(words, transcript, speechFinal) {
    const segments = [];
    if (words && words.length) {
      for (const w of words) {
        const speaker = Number.isInteger(w.speaker) ? w.speaker : 0;
        const token = w.punctuated_word ?? w.word ?? '';
        const last = segments[segments.length - 1];
        if (last && last.speaker === speaker) last.text += ` ${token}`;
        else segments.push({ speaker, text: token });
      }
    } else if (transcript) {
      segments.push({ speaker: this.lastSpeaker, text: transcript });
    }
    for (const seg of segments) {
      if (this.pending && this.pending.speaker !== seg.speaker) this.flush();
      if (!this.pending) this.pending = { speaker: seg.speaker, text: '' };
      this.pending.text = `${this.pending.text} ${seg.text}`.trim();
      this.lastSpeaker = seg.speaker;
    }
    if (speechFinal || (this.pending && this.pending.text.length > this.maxChars)) this.flush();
    else this.#arm();
  }

  /** Texto parcial para mostrar ao vivo: o que já está acumulado + o trecho provisório. */
  preview(interimSpeaker, interimText) {
    const sp = interimSpeaker ?? this.lastSpeaker;
    if (this.pending && this.pending.speaker === sp) return { speaker: sp, text: `${this.pending.text} ${interimText}`.trim() };
    return { speaker: sp, text: interimText };
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const turn = this.pending;
    this.pending = null;
    if (turn && turn.text.trim()) this.onTurn(turn);
  }

  #arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.idleMs);
  }

  dispose() {
    clearTimeout(this.timer);
    this.pending = null;
  }
}
