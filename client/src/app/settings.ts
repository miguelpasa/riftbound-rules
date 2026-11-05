/** Persisted app settings (localStorage). Every access is guarded: storage may be unavailable. */
export interface AppSettings {
  /** 30 s reaction window (and 60 s mulligan / damage-assignment timers) in multiplayer. Default on. */
  timerMultiplayer: boolean;
  /** Same timers in solo games vs the AI. Default off. */
  timerSolo: boolean;
}

const KEY_MP = 'riftbound.timerMultiplayer';
const KEY_SOLO = 'riftbound.timerSolo';

export const DEFAULT_SETTINGS: AppSettings = { timerMultiplayer: true, timerSolo: false };

function read(key: string, fallback: boolean): boolean {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v === null || v === undefined ? fallback : v === 'true';
  } catch {
    return fallback;
  }
}

export function loadSettings(): AppSettings {
  return {
    timerMultiplayer: read(KEY_MP, DEFAULT_SETTINGS.timerMultiplayer),
    timerSolo: read(KEY_SOLO, DEFAULT_SETTINGS.timerSolo),
  };
}

export function saveSettings(s: AppSettings): void {
  try {
    globalThis.localStorage?.setItem(KEY_MP, String(s.timerMultiplayer));
    globalThis.localStorage?.setItem(KEY_SOLO, String(s.timerSolo));
  } catch {
    /* storage unavailable: setting applies for this session only */
  }
}
