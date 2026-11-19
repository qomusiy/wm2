import { createContext, useContext } from 'react';

/** Lets overlays inside the player (chat cards) keep the control bar from hiding while the pointer is on them. */
export interface PlayerChrome {
  pinControls(on: boolean): void;
}

export const PlayerChromeContext = createContext<PlayerChrome>({ pinControls: () => {} });
export const usePlayerChrome = () => useContext(PlayerChromeContext);
