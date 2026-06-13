import { createContext, useContext, useState, ReactNode } from 'react';

interface ToolBlockPrefsContextType {
  /** When true, new tool blocks render expanded; when false, collapsed. */
  toolsExpandedByDefault: boolean;
  setToolsExpandedByDefault: (expanded: boolean) => void;
}

const ToolBlockPrefsContext = createContext<ToolBlockPrefsContextType | undefined>(undefined);

const STORAGE_KEY = 'pi-assistant-tools-expanded';

function readStoredPreference(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function ToolBlockPrefsProvider({ children }: { children: ReactNode }) {
  const [toolsExpandedByDefault, setToolsExpandedState] = useState(readStoredPreference);

  const setToolsExpandedByDefault = (expanded: boolean) => {
    setToolsExpandedState(expanded);
    localStorage.setItem(STORAGE_KEY, String(expanded));
  };

  return (
    <ToolBlockPrefsContext.Provider value={{ toolsExpandedByDefault, setToolsExpandedByDefault }}>
      {children}
    </ToolBlockPrefsContext.Provider>
  );
}

export function useToolBlockPrefs() {
  const context = useContext(ToolBlockPrefsContext);
  if (!context) {
    throw new Error('useToolBlockPrefs must be used within ToolBlockPrefsProvider');
  }
  return context;
}