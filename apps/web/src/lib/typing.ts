import { useCallback, useEffect, useRef } from 'react';
import type { RoomConnection } from './connection';

/**
 * Tells the room "X is typing" while someone composes: at most every 3 s while keys are pressed, and "stopped" after
 * 4 s of silence, when the box is emptied, or on unmount. The server clears typing itself when a message arrives.
 */
export function useTypingNotifier(conn: RoomConnection) {
  const sentAt = useRef(0);
  const stopTimer = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (stopTimer.current) window.clearTimeout(stopTimer.current);
    stopTimer.current = null;
    if (sentAt.current) conn.send({ type: 'typing', active: false });
    sentAt.current = 0;
  }, [conn]);
  useEffect(() => stop, [stop]);

  const input = useCallback((value: string) => {
    if (!value.trim()) return stop();
    if (Date.now() - sentAt.current > 3000) {
      conn.send({ type: 'typing', active: true });
      sentAt.current = Date.now();
    }
    if (stopTimer.current) window.clearTimeout(stopTimer.current);
    stopTimer.current = window.setTimeout(stop, 4000);
  }, [conn, stop]);

  /** After a message was sent: start fresh so the next keystroke announces again. */
  const sent = useCallback(() => {
    sentAt.current = 0;
    if (stopTimer.current) window.clearTimeout(stopTimer.current);
    stopTimer.current = null;
  }, []);

  return { input, stop, sent };
}
