// Dictation opens the microphone plain (no echo cancellation, noise suppression, gain control): on Android those make the
// WebView record as a call. Calls and voice conversations keep the full set.
import assert from 'node:assert/strict';
import { microphoneConstraints } from '../../../src/ui/lib/microphone.ts';

assert.deepEqual(microphoneConstraints(true), { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
assert.deepEqual(microphoneConstraints(false), { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
assert.deepEqual(microphoneConstraints(undefined), { echoCancellation: true, noiseSuppression: true, autoGainControl: true });
console.log('microphone-constraints: 3/3');
