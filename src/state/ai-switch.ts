/**
 * AiSwitch: the session-only "AI: On / Off (fully local)" choice. No
 * persistence: a page refresh starts On again (when the build allows AI).
 */
import { useSyncExternalStore } from "react";

type Listener = () => void;

export class AiSwitch {
  private on = true;
  private readonly listeners = new Set<Listener>();

  getState = (): boolean => this.on;
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  isOn(): boolean {
    return this.on;
  }
  set(on: boolean): void {
    if (this.on === on) return;
    this.on = on;
    for (const l of this.listeners) l();
  }
}

export function useAiSwitch(sw: AiSwitch): boolean {
  return useSyncExternalStore(sw.subscribe, sw.getState);
}
