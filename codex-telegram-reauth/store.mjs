import { createReauthState, loadState, saveState } from "./state.mjs";

export function createStateStore(statePath) {
  return {
    path: statePath,
    read() {
      return loadState(statePath);
    },
    write(state) {
      saveState(statePath, state);
      return state;
    },
    update(mutator) {
      const state = loadState(statePath);
      const next = mutator(state) ?? state;
      saveState(statePath, next);
      return next;
    },
    ensure() {
      const state = loadState(statePath);
      saveState(statePath, state.session ? state : createReauthState());
      return loadState(statePath);
    },
  };
}
