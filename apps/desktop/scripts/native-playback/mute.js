// Installed at document creation only in the disposable benchmark WebView.
(() => {
  const media = HTMLMediaElement.prototype;
  const muted = Object.getOwnPropertyDescriptor(media, "muted");
  const volume = Object.getOwnPropertyDescriptor(media, "volume");
  const play = media.play;
  function silence(el) { muted.set.call(el, true); volume.set.call(el, 0); }
  Object.defineProperty(media, "muted", { ...muted, set() { muted.set.call(this, true); } });
  Object.defineProperty(media, "volume", { ...volume, set() { volume.set.call(this, 0); } });
  media.play = function(...args) { silence(this); return play.apply(this, args); };
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof HTMLMediaElement) silence(node);
      node.querySelectorAll?.("video,audio").forEach(silence);
    }
  }).observe(document, { subtree: true, childList: true });
  window.__scarletBenchMuted = true;
})();
