const key = "scarlet.updatePlace";

export function captureProjectPlace(location: Pick<Location, "pathname" | "search" | "hash">) {
  if (!/^\/p\/[^/]+\/?$/.test(location.pathname)) return null;
  const place = new URL(location.pathname + location.search + location.hash, window.location.href);
  window.dispatchEvent(new CustomEvent("scarlet:bookmark-project", { detail: place }));
  return place.pathname + place.search + place.hash;
}

export function saveUpdatePlace() {
  const path = captureProjectPlace(window.location);
  if (!path) return;
  try { localStorage.setItem(key, path); } catch { /* Storage is optional. */ }
}

export function clearUpdatePlace() {
  try { localStorage.removeItem(key); } catch { /* Storage is optional. */ }
}

export function restoreUpdatePlace() {
  try {
    const path = localStorage.getItem(key);
    clearUpdatePlace();
    if (!path || window.location.pathname !== "/") return;
    const place = new URL(path, window.location.href);
    if (place.origin === window.location.origin && /^\/p\/[^/]+\/?$/.test(place.pathname)) {
      window.history.replaceState(null, "", place.pathname + place.search + place.hash);
    }
  } catch { /* Open the project library if the bookmark is unavailable. */ }
}

const lastKey = "scarlet.lastProject";
const openingKey = "scarlet.lastProject.opening";

/** The project on screen, so Scarlet reopens it after a quit. Null once the editor goes back to the library. */
export function rememberProject(id: string | null) {
  try {
    if (id) localStorage.setItem(lastKey, id);
    else localStorage.removeItem(lastKey);
    localStorage.removeItem(openingKey);
  } catch { /* Storage is optional. */ }
}

/**
 * Open the project that was on screen when Scarlet last closed. A project that didn't finish opening last
 * time isn't tried again, so one that can't open never keeps the editor out of the library.
 */
export function restoreLastProject() {
  try {
    const id = localStorage.getItem(lastKey);
    const failed = localStorage.getItem(openingKey);
    localStorage.removeItem(openingKey);
    if (!id || !/^[\w-]+$/.test(id) || window.location.pathname !== "/") return;
    if (failed === id) return void localStorage.removeItem(lastKey);
    localStorage.setItem(openingKey, id);
    window.history.replaceState(null, "", `/p/${id}`);
  } catch { /* Open the project library if the bookmark is unavailable. */ }
}
