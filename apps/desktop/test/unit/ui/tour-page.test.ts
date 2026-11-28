// Feedback 16.11.2026 (owner F15: "bevor man den QR-Code scannen kann … so ein Video …, was einem zeigt, wie man da
// Feedback macht"): the phone's feedback video. The Android app's own page (scripts/tour-page.mjs bundles
// src/ui/tour/phone-page.tsx and src/ui/tour/phone-page.css with esbuild into one tour.html; apps/android/build.ps1
// puts it into the APK) is one self-contained page that plays the phone's tour at once, with Skip, and opens the
// address the app takes as done; the replay dialog plays the phone's tour in the phone
// layout and keeps the variant it opened with. Owner 26.11.2026: no phone starts the video by itself.
// Owns: these assertions (one in-memory esbuild run, source checks for the .tsx/.java wiring). Never: a WebView or a phone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundleTourPage } from '../../../scripts/tour-page.mjs';

const source = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

test('the Android app\'s page: one self-contained page with the phone tour; Skip and Continue open the done address', async () => {
  const html = await bundleTourPage();
  assert.match(html, /^<!doctype html>\n<html lang="en" data-theme="system">/, 'light or dark like the phone');
  assert.ok(html.includes(`content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"`), 'nothing but its own inline code');
  assert.match(html, /<body class="tour-page"><div id="tour"><\/div><script>/);
  assert.doesNotMatch(html, /<script src|<link |@import|url\(\s*["']?(?:https?:|\/\/)/, 'nothing loaded from anywhere');
  assert.ok(html.includes('autark-tour:done'), 'the address the app takes as done');
  assert.ok(html.includes('How to send feedback') && html.includes('Feedback is the megaphone, top right.'), 'the phone tour inside');
  assert.ok(html.includes('.tour-dock') && html.includes('--surface'), 'the tour\'s styles and the tokens inline');
  assert.ok(html.length < 400_000, `small (${html.length} bytes)`);
  assert.match(source('src/ui/tour/phone-page.tsx'), /<TourPlayer variant="phone" bubble autoplay skip note=\{VOLUME_NOTE\} onDone=\{\(\) => \{ location\.href = DONE_ADDRESS; \}\} \/>/);
  assert.ok(html.includes('it follows your finger.'), 'the Android tour with its bubble chapter');
  const app = readFileSync(new URL('../../../../android/app/src/main/java/com/teydralab/autark/android/IntroTour.java', import.meta.url), 'utf8');
  assert.match(app, /DONE = "autark-tour:done"/, 'the app takes the same address');
});

// 28.11.2026 (Mac test of 0.3.22: the dialog covered the very first screen of the phone UI; owner 26.11.2026: the feedback
// bubble is explained in the PC's introduction, never on the phone): no phone UI opens the tour by itself. The replay paths stay.
test('no phone opens the feedback tour on its own; the replay and the PC\'s own openings stay', () => {
  const shell = source('src/ui/shell/Shell.tsx');
  assert.doesNotMatch(shell, /openTour|firstVideoHere/, 'the shell opens no tour by itself');
  assert.doesNotMatch(source('src/ui/pwa/native.ts'), /firstVideoHere|VIDEO_SEEN_KEY|feedbackVideoSeen/, 'no "seen" mark: nothing plays on a first start');
  assert.match(shell, /<TourDialog phone=\{isMobile\.value\} desktopBubble=\{desktopBubble\.value\.available\} \/>/, 'the phone layout plays the phone\'s tour when a person opens it');
  const dialog = source('src/ui/tour/TourDialog.tsx');
  assert.match(dialog, /<TourModal variant=\{tourVariant\(Boolean\(props\.phone\)\)\} desktopBubble=\{props\.desktopBubble\} \/>/, 'the opening\'s variant stays while it plays (open.ts tourVariant – tour-variant.test.ts)');
  assert.match(dialog, /<TourPlayer onDone=\{closeTour\} autoplay=\{tourAutoplay\.peek\(\)\} variant=\{variant\} desktopBubble=\{showDesktopBubble\.current\} \/>/);
  // the PC's openings: the first run's card and "Set up a new company", Settings › Feedback, the palette
  assert.match(source('src/ui/onboarding/ChoiceCard.tsx'), /openTour\(\{ autoplay: true \}\)/);
  assert.match(source('src/ui/settings/FeedbackPage.tsx'), /onClick=\{\(\) => openTour\(\)\}/);
  assert.match(source('src/ui/shell/CommandPalette.tsx'), /run: \(\) => openTour\(\)/);
  assert.doesNotMatch(source('../android/app/src/main/java/com/teydralab/autark/android/MainActivity.java'), /IntroTour\.due/, 'the Android app does not start it either');
});