/**
 * Rest-timer audio cues.
 *
 * Synthesised with Web Audio rather than shipped as audio files: nothing to fetch, nothing
 * to cache, and it works on the very first offline run.
 *
 * Two platform facts shape this module. iOS Safari refuses to start an AudioContext outside
 * a user gesture, so the context is created lazily on the first cue — which is always
 * downstream of the tap on Start. And iOS caps how many contexts a page may create, so we
 * keep one for the lifetime of the tab instead of opening and closing one per beep.
 */

export type CueName = 'warn' | 'tick' | 'go';

/**
 * Which cue belongs to a given number of seconds remaining, or none.
 *
 * A warning ten seconds out, then a tick on each of the last five, then the go chime. Pure
 * and separately tested, because getting `<= 5` versus `< 5` wrong is a silent one-beep bug
 * that is tedious to notice by ear.
 */
export function cueForSecondsLeft(secondsLeft: number): CueName | null {
  if (!Number.isFinite(secondsLeft)) return null;
  if (secondsLeft <= 0) return 'go';
  if (secondsLeft === 10) return 'warn';
  if (secondsLeft <= 5) return 'tick';
  return null;
}

interface Blip {
  /** Hz. */
  freq: number;
  /** Offset from the start of the cue, in seconds. */
  at: number;
  /** How long the tone sounds, in seconds. */
  length: number;
  /** Peak gain, 0–1. */
  gain: number;
}

const CUES: Record<CueName, readonly Blip[]> = {
  // One soft mid tone — "ten seconds".
  warn: [{ freq: 660, at: 0, length: 0.14, gain: 0.18 }],
  // A short dry click, one per second over the last five. Deliberately quieter and higher
  // than the warning so a run of them does not become annoying.
  tick: [{ freq: 1046, at: 0, length: 0.05, gain: 0.13 }],
  // Two rising tones — go.
  go: [
    { freq: 880, at: 0, length: 0.16, gain: 0.25 },
    { freq: 1320, at: 0.18, length: 0.16, gain: 0.25 },
  ],
};

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export function playCue(name: CueName): void {
  try {
    const audio = context();
    if (!audio) return;
    // Safari suspends the context when the app is backgrounded mid-workout.
    if (audio.state === 'suspended') void audio.resume();

    const now = audio.currentTime;
    for (const blip of CUES[name]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = blip.freq;

      // Ramp rather than step: setting gain instantly produces an audible click.
      const start = now + blip.at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(blip.gain, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + blip.length);

      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + blip.length + 0.02);
    }
  } catch {
    // Audio is a nicety. Never let it break a workout.
  }
}

/** Test seam — drops the cached context. */
export function __resetAudio(): void {
  ctx = null;
}
