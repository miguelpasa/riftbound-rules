import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'riftbound.showImages';

export function loadShowImages(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function saveShowImages(v: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(v));
  } catch {
    /* storage unavailable: ignore */
  }
}

interface Ctx {
  showImages: boolean;
  setShowImages: (v: boolean) => void;
}

const CardImagesContext = createContext<Ctx>({ showImages: true, setShowImages: () => undefined });

export function CardImagesProvider({ children }: { children: ReactNode }) {
  const [showImages, setState] = useState<boolean>(loadShowImages);
  const setShowImages = useCallback((v: boolean) => {
    setState(v);
    saveShowImages(v);
  }, []);
  const value = useMemo(() => ({ showImages, setShowImages }), [showImages, setShowImages]);
  return <CardImagesContext.Provider value={value}>{children}</CardImagesContext.Provider>;
}

export function useCardImages(): Ctx {
  return useContext(CardImagesContext);
}

/** Global 'Card images' on/off toggle (needs a CardImagesProvider to persist). */
export function ImageToggle() {
  const { showImages, setShowImages } = useCardImages();
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-300">
      <input
        type="checkbox"
        checked={showImages}
        onChange={(e) => setShowImages(e.target.checked)}
        className="h-4 w-4 accent-indigo-500"
      />
      Card images
    </label>
  );
}
