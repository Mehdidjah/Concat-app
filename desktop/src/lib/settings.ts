/**
 * App-level preferences, in localStorage.
 *
 * These are machine preferences, not edit state: which Whisper model to use,
 * which language to expect. They deliberately do not live in the project -
 * copying a project to a machine without the model should not break it, and
 * the choice is about this computer's speed/quality tradeoff.
 */

const MODEL_KEY = "wolfcut.transcriber.model";
const LANGUAGE_KEY = "wolfcut.transcriber.language";

/** The default model: the speed/quality sweet spot, per the settings panel. */
export const DEFAULT_TRANSCRIBER_MODEL = "base.en";

export function getTranscriberModel(): string {
  return localStorage.getItem(MODEL_KEY) ?? DEFAULT_TRANSCRIBER_MODEL;
}

export function setTranscriberModel(id: string): void {
  localStorage.setItem(MODEL_KEY, id);
}

/** A Whisper language code, or "auto" to let the model decide. */
export function getTranscriberLanguage(): string {
  return localStorage.getItem(LANGUAGE_KEY) ?? "auto";
}

export function setTranscriberLanguage(code: string): void {
  localStorage.setItem(LANGUAGE_KEY, code);
}
