/** Fila com prioridade e concorrência limitada. Se encher, descarta o item de menor prioridade (e mais antigo). */
export class PriorityQueue {
  constructor({ concurrency = 3, maxSize = 30 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.maxSize = Math.max(1, maxSize);
    this.items = [];
    this.active = 0;
    this.seq = 0;
    this.closed = false;
  }

  add({ priority = 1, run, onDrop }) {
    if (this.closed) return;
    this.items.push({ priority, run, onDrop, seq: this.seq++ });
    while (this.items.length > this.maxSize) {
      let idx = 0;
      for (let i = 1; i < this.items.length; i++) {
        const a = this.items[i];
        const b = this.items[idx];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) idx = i;
      }
      const [dropped] = this.items.splice(idx, 1);
      try { dropped.onDrop?.(); } catch { /* ignora */ }
    }
    this.#pump();
  }

  #pump() {
    while (!this.closed && this.active < this.concurrency && this.items.length) {
      let idx = 0;
      for (let i = 1; i < this.items.length; i++) {
        const a = this.items[i];
        const b = this.items[idx];
        if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) idx = i;
      }
      const [item] = this.items.splice(idx, 1);
      this.active++;
      Promise.resolve()
        .then(() => item.run())
        .catch(() => {})
        .finally(() => {
          this.active--;
          this.#pump();
        });
    }
  }

  close() {
    this.closed = true;
    this.items = [];
  }
}
