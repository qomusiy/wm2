type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean };

/* iPhones can't put a page element in full screen (only a <video>, natively). For YouTube (no <video> of ours) the
   stage fills the window instead: "pseudo" full screen. */
let pseudo: HTMLElement | null = null;
const pseudoListeners = new Set<() => void>();
const onPseudoKey = (e: KeyboardEvent) => {
  if (e.key === 'Escape') setPseudo(null);
};

function setPseudo(el: HTMLElement | null): void {
  pseudo?.removeAttribute('data-pseudo-fullscreen');
  pseudo = el;
  el?.setAttribute('data-pseudo-fullscreen', '');
  if (el) document.addEventListener('keydown', onPseudoKey);
  else document.removeEventListener('keydown', onPseudoKey);
  for (const fn of pseudoListeners) fn();
}

function nativeFullscreenElement(): Element | null {
  const d = document as FsDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export function fullscreenElement(): Element | null {
  return nativeFullscreenElement() ?? (pseudo?.isConnected ? pseudo : null);
}

export function canFullscreenElement(): boolean {
  const el = document.documentElement as FsElement;
  return Boolean(el.requestFullscreen || el.webkitRequestFullscreen);
}

/** Fullscreen the whole stage (so overlays stay visible); iPhone only supports native video fullscreen. */
export async function toggleFullscreen(stage: HTMLElement, video: HTMLVideoElement | null): Promise<void> {
  const d = document as FsDocument;
  if (pseudo) {
    setPseudo(null);
    return;
  }
  if (nativeFullscreenElement()) {
    await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
    return;
  }
  const el = stage as FsElement;
  if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
  else if (video && (video as IosVideo).webkitEnterFullscreen) (video as IosVideo).webkitEnterFullscreen!();
  else setPseudo(stage);
}

export function onFullscreenChange(cb: () => void): () => void {
  document.addEventListener('fullscreenchange', cb);
  document.addEventListener('webkitfullscreenchange', cb);
  pseudoListeners.add(cb);
  return () => {
    document.removeEventListener('fullscreenchange', cb);
    document.removeEventListener('webkitfullscreenchange', cb);
    pseudoListeners.delete(cb);
  };
}
