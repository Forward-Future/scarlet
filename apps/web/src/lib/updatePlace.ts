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
const placeKey = "scarlet.lastPlace";
const openingKey = "scarlet.lastProject.opening";

/** The project on screen, so Scarlet reopens it after a quit. Null once the editor goes back to the library. */
export function rememberProject(id: string | null) {
  try {
    if (id) localStorage.setItem(lastKey, id);
    else {
      localStorage.removeItem(lastKey);
      localStorage.removeItem(placeKey);
    }
    localStorage.removeItem(openingKey);
  } catch { /* Storage is optional. */ }
}

/**
 * Where the editor is in the project on screen, kept as they go so a quit, a crash or a power cut brings them back to
 * it: the time on the cut, the speed, and the cut, edit or call that is open. Asked of the page as the way back from
 * Settings is. Nothing is written while the place hasn't changed.
 */
export function rememberPlace() {
  const path = captureProjectPlace(window.location);
  try {
    if (path && path !== localStorage.getItem(placeKey)) localStorage.setItem(placeKey, path);
  } catch { /* Storage is optional. */ }
}

/** The place kept for a project, when it is that project's and nothing else. */
function lastPlace(id: string) {
  const path = localStorage.getItem(placeKey);
  if (!path) return;
  const place = new URL(path, window.location.href);
  if (place.origin !== window.location.origin || place.pathname.replace(/\/$/, "") !== `/p/${id}`) return;
  return place.pathname + place.search;
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
    if (failed === id) {
      localStorage.removeItem(placeKey);
      return void localStorage.removeItem(lastKey);
    }
    localStorage.setItem(openingKey, id);
    window.history.replaceState(null, "", lastPlace(id) ?? `/p/${id}`);
  } catch { /* Open the project library if the bookmark is unavailable. */ }
}
