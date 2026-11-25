import { useEffect, useRef, useState } from "react";
import type { ServerSettings } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";

/**
 * One engine setting the same for every project, read when shown and saved as chosen. The choice shows at once and
 * goes back to what it was if the engine refuses it. `choose` says whether the engine kept it.
 */
export function useServerSetting<K extends keyof ServerSettings>(key: K) {
  const [value, setValue] = useState<ServerSettings[K] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void api.settings().then(r => { if (current) setValue(r.settings[key]); }).catch(e => { if (current) setError(errorMessage(e)); });
    return () => { current = false; };
  }, [key]);
  // Two choices made one after the other are both on their way: the later one's answer is the one that shows, so the
  // earlier answer never puts back a list without what the later one added.
  const latest = useRef(0);
  const choose = async (next: ServerSettings[K]) => {
    const previous = value;
    const turn = ++latest.current;
    setValue(next);
    setError("");
    setBusy(true);
    try {
      const update: Partial<ServerSettings> = {};
      update[key] = next;
      const saved = (await api.updateSettings(update)).settings[key];
      if (turn === latest.current) setValue(saved);
      return true;
    } catch (e) {
      if (turn === latest.current) {
        setValue(previous);
        setError(errorMessage(e));
      }
      return false;
    } finally {
      if (turn === latest.current) setBusy(false);
    }
  };
  return { value, busy, error, choose };
}
