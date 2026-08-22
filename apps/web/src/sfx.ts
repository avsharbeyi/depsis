/**
 * The interface's own sounds.
 *
 * `Preferences.sound` was already in the contract, the top bar already had a switch for it and the
 * wallpaper screen already toasted "Arayüz sesleri açıldı" — but nothing in this tree ever made a
 * noise. A stored boolean is not a feature, and a switch whose only effect is a database row is the
 * same lie as a button that does nothing when it is pressed. So the reference's audio layer is
 * ported here: six short blips synthesised at play time.
 *
 * Web Audio rather than audio files, exactly as the reference does it, because the alternative is
 * shipping half a dozen encoded clips with the appliance for sounds that are four hundredths of a
 * second long. No new dependency either way.
 *
 * The context is created lazily and only ever after a click, because a browser refuses to start one
 * without a gesture and an `AudioContext` built at module load would sit `suspended` for the life of
 * the tab.
 */

let context: AudioContext | null = null;
let enabled = false;

function audio(): AudioContext | null {
  // A browser can refuse outright — an older engine, or a policy that forbids audio entirely. That
  // must not take the desktop down with it, so a failure here permanently disables the layer rather
  // than throwing into whichever click happened to ask for a sound.
  if (context === null) {
    try {
      context = new AudioContext();
    } catch {
      enabled = false;
      return null;
    }
  }
  return context;
}

/**
 * Follows the stored preference.
 *
 * Deliberately silent: this runs whenever the preference arrives from the server, including on the
 * first load of a tab, and a desktop that chirps at you before you have touched it is not what the
 * switch promised. The confirming sound belongs to the click, and the toggle plays it itself.
 *
 * The `resume` is here because a context built during page load starts `suspended` under every
 * browser's autoplay policy and stays that way until something asks it not to be.
 */
export function setSoundEnabled(next: boolean): void {
  enabled = next;
  if (!next) return;
  const a = audio();
  if (a === null) return;
  void a.resume();
}

function blip({
  frequency,
  seconds = 0.04,
  type = 'triangle',
  gain = 0.045,
  slide = 0,
}: {
  frequency: number;
  seconds?: number;
  type?: OscillatorType;
  gain?: number;
  slide?: number;
}): void {
  if (!enabled) return;
  const a = audio();
  if (a === null) return;

  const now = a.currentTime;
  const oscillator = a.createOscillator();
  const envelope = a.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  // Never ramp to zero or below: `exponentialRampToValueAtTime` throws on a non-positive target,
  // and a downward slide of 840 Hz from 1700 is one careless sum away from exactly that.
  if (slide !== 0) {
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(60, frequency + slide),
      now + seconds,
    );
  }

  // The attack is a linear ramp and the decay an exponential one. A gain that starts at full value
  // clicks audibly at this length; four milliseconds is enough to remove that without being heard
  // as a fade.
  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.linearRampToValueAtTime(gain, now + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

  oscillator.connect(envelope).connect(a.destination);
  oscillator.start(now);
  // Stopped rather than left running: an oscillator node that is never stopped is never collected,
  // and this fires on every window open for as long as the tab is up.
  oscillator.stop(now + seconds + 0.02);
}

/** Filtered white noise — the click and the window-open both want a transient that a pure tone
 *  cannot give them. */
function noise(seconds = 0.03, gain = 0.03): void {
  if (!enabled) return;
  const a = audio();
  if (a === null) return;

  const frames = Math.max(1, Math.floor(a.sampleRate * seconds));
  const buffer = a.createBuffer(1, frames, a.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) channel[i] = (Math.random() * 2 - 1) * (1 - i / frames);

  const source = a.createBufferSource();
  source.buffer = buffer;
  const highpass = a.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 1900;
  const level = a.createGain();
  level.gain.value = gain;

  source.connect(highpass).connect(level).connect(a.destination);
  source.start();
}

/**
 * The six sounds, with the reference's own frequencies and lengths.
 *
 * Copied rather than re-derived for the same reason the colours were: these are twenty numbers that
 * were tuned together, and "close enough" on each of them separately is how a sound set stops
 * sounding like itself.
 */
export const sfx = {
  click: (): void => {
    blip({ frequency: 1700, seconds: 0.03, gain: 0.04, slide: -840 });
    noise(0.02, 0.026);
  },
  open: (): void => {
    blip({ frequency: 450, seconds: 0.16, gain: 0.034, slide: 700, type: 'sine' });
    noise(0.032, 0.015);
  },
  close: (): void => blip({ frequency: 880, seconds: 0.11, gain: 0.03, slide: -520, type: 'sine' }),
  ok: (): void => {
    blip({ frequency: 900, seconds: 0.07, gain: 0.03, type: 'sine' });
    window.setTimeout(
      () => blip({ frequency: 1350, seconds: 0.09, gain: 0.028, type: 'sine' }),
      60,
    );
  },
  warn: (): void => {
    blip({ frequency: 420, seconds: 0.1, gain: 0.04, type: 'square' });
    window.setTimeout(
      () => blip({ frequency: 330, seconds: 0.13, gain: 0.035, type: 'square' }),
      90,
    );
  },
  error: (): void => {
    blip({ frequency: 300, seconds: 0.14, gain: 0.045, slide: -120, type: 'sawtooth' });
  },
};
