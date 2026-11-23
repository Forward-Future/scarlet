import { useEffect, useState } from "react";
import type { ServerSettings } from "@scarlet/shared";
import { api, errorMessage } from "../../lib/client";

/**
 * One engine setting the same for every project, read when shown and saved as chosen. The choice shows at once and
 * goes back to what it was if the engine refuses it.
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
  const choose = async (next: ServerSettings[K]) => {
    const previous = value;
    setValue(next);
    setError("");
    setBusy(true);
    try {
      const update: Partial<ServerSettings> = {};
      update[key] = next;
      setValue((await api.updateSettings(update)).settings[key]);
    } catch (e) {
      setValue(previous);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { value, busy, error, choose };
}
