// Short confirmation messages over the graph ("Opened src/api: 6 items", "Copied").
const SHOW_MS = 2200;
const LEAVE_MS = 300;
const MAX_TOASTS = 3;

export class Toasts {
  constructor(private readonly root: HTMLElement) {}

  show(text: string): void {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = text;
    this.root.append(el);
    while (this.root.childElementCount > MAX_TOASTS) this.root.firstElementChild?.remove();
    // The entry is a CSS keyframe animation (.toast), so it runs on insertion.
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), LEAVE_MS);
    }, SHOW_MS);
  }
}
