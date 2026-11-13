// Reset only the private web view after a missed automation event.
window.scarletPlaybackBench = { run: async () => {
  const slider = document.querySelector(".cut-transport .timeline-slider");
  const rect = slider.getBoundingClientRect();
  const value = Number(slider.getAttribute("aria-valuenow"));
  const start = Number(slider.getAttribute("aria-valuemin"));
  const end = Number(slider.getAttribute("aria-valuemax"));
  const x = rect.left + Math.min(rect.width-1, Math.max(1, (value-start)/(end-start)*rect.width));
  await webkit.messageHandlers.scarletBenchPointer.postMessage({type:"pointerup", x, y:rect.top+rect.height/2});
  return { released: true };
} };
