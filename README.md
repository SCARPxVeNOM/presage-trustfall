# TrustFall

**A crash-test lab for camera vital signs.** Record one clean minute of yourself. TrustFall replays it through the [SmartSpectra SDK](https://github.com/Presage-Security/SmartSpectra) with one controlled change at a time (darkness, sensor noise, blur, camera sway, distance, video-call compression, low frame rate, a covered face, flickering light, a still photo) and checks whether the SDK's own confidence noticed when the readings moved.

> Wellness and measurement only. TrustFall is not a medical device, does not diagnose anything, and makes no claim that the SDK is accurate or inaccurate. It reports what was measured on your clip.

## Why replay one clip?

Camera vitals have no ground truth at home: you usually don't have an ECG next to your laptop. TrustFall gets an expected answer another way. Every variant is **the same recording**, so the person's real pulse and breathing are identical across all of them. When a reading changes, the picture changed it. For a few variants the expected answer is known exactly:

| Variant | Expected reading | Why |
| --- | --- | --- |
| Most damage (dim, blur, sway, …) | same as the original | only the picture changed |
| Played 15% faster / slower | original × 1.15 / × 0.85 | time is compressed, so true rates scale exactly |
| Mirror image, same file twice | same as the original | a face reads the same in a mirror; a replay should repeat |
| Still photo (± sensor noise) | **no reading** | a frozen frame has no pulse or breathing |

This is *metamorphic testing*, a standard way to test systems that have no oracle.

## The yardstick: the SDK's own contract

SmartSpectra's [Data Types reference](https://smartspectra.presagetech.com/docs/data-types) defines `stable` for each rate:

- pulse: `stable` ⇔ confidence ≥ 40 ⇔ within **±3 bpm**
- breathing: `stable` ⇔ confidence ≥ 45 ⇔ within **±1 br/min**

Its [model cards](https://smartspectra.presagetech.com/docs/model-cards-and-limitations) also say that motion, chewing and flickering light "may produce inaccurate measurements with high confidence". TrustFall measures that on your own setup.

The expected value is the SDK's own reading of the clean copy, which is itself only promised to be within ±3 bpm of the truth. So two stable readings of the same moment can honestly differ by up to **6 bpm** (2 br/min). TrustFall only calls a stable reading off when the gap is bigger than that, because then at least one of the two readings missed the documented range. For the speed variants the gap scales with the factor. Each reading after warm-up is classed as:

- **Right and stable**: marked stable and within 6 bpm (2 br/min) of the expected value
- **Stable but off**: marked stable and further away than that. At least one of the two stable readings is outside the SDK's documented range.
- **Withheld**: not marked stable

TrustFall also reports how many stable readings **moved** more than ±3 bpm from the clean copy. That measures consistency (the picture changed the answer), not proven error.

Each variant then gets one outcome: **Held**, **Flagged** (the SDK lowered confidence, which is honest), **Confident but off** (at least 3 s of stable-but-off readings making up over 20% of its stable readings), or **No reading**. Readings are resampled to two per second, so counts mean "half-seconds of output" whatever rate the SDK emits at.

## What you get

- **Setup verdict** (Ready / Fragile / Not ready) with concrete fixes backed by evidence, for example "Pulse readings held at 2 stops darker but lost their stable rating at 3 stops darker."
- **The stable-flag check**: the share of stable readings that were within tolerance, with sample sizes.
- **Confidence vs error** scatter and a **calibration** chart (is higher confidence more often right?).
- **Headroom** per condition: how much damage your setup takes before readings stop holding.
- **Every variant** with a thumbnail of the damaged frame, its readings over time, and the SDK's validation feedback.
- **Wind tunnel**: the live camera is damaged on a canvas *before* the SDK sees it. Move a slider and watch confidence react in real time.
- **Exports**: `samples.csv` (every reading), `summary.json`, `report.md`.

## Setup

Requirements: macOS on Apple Silicon, Windows x64 or Linux x64/arm64 (the SDK's Node platforms); Node 20+; ffmpeg.

```bash
git clone https://github.com/SCARPxVeNOM/presage-hack.git && cd presage-hack
npm install
brew install ffmpeg                # or apt install ffmpeg / choco install ffmpeg
cp .env.example .env               # then paste your key into .env
npm start                          # builds and opens the app
```

Get an API key at [physiology.presagetech.com](https://physiology.presagetech.com/auth/register). It goes in `.env` as `SMARTSPECTRA_API_KEY=...`. `.env` is git-ignored; never commit a key. No other licensed files are needed: the SDK's native runtime arrives with `npm install`.

`npm run mock` opens the app with a synthetic stand-in for the SDK so you can explore the interface without a key. Mock runs are stamped and labelled **MOCK DATA** everywhere and must not be cited.

## Re-run the same sequence from the command line

```bash
npm run crash -- path/to/face.mp4 --suite quick     # import + crash test, prints a summary
node src/cli.js suites                              # list every variant in smoke / quick / full
node src/cli.js list                                # clips and runs
node src/cli.js report <runId>                      # re-analyse a saved run
```

Suites: `smoke` (4 runs), `quick` (17 runs: every condition at one level, plus controls), `full` (41 runs: every condition at four levels). Each run is a full SDK session on about a minute of video. Each copy is played to the SDK at its own frame rate (`useFile` with `interframeDelayMs` = 1000 / fps), so a session takes about as long as the clip. Playing a file as fast as possible (`interframeDelayMs: 0`) made the SDK drop about 40% of frames and send 2 pulse readings for a 60 s clip instead of 55. Set `TRUSTFALL_FRAME_DELAY_MS` to override.

### As a CI gate

```yaml
- run: npm ci && sudo apt-get install -y ffmpeg
- run: node src/cli.js run test-assets/face.mp4 --suite quick --min-kept 80 --fail-on-fooled
  env:
    SMARTSPECTRA_API_KEY: ${{ secrets.SMARTSPECTRA_API_KEY }}
```

`--min-kept N` fails the job when fewer than N% of stable pulse readings were within ±3 bpm; `--fail-on-fooled` fails it if any variant produced confident-but-off readings. Use a clip of someone who has agreed to be in your test assets.

## How a variant is made

All variants are rendered by ffmpeg from the same 30 fps, 1280×720, near-lossless master (`crf 12`), with identical encoder settings, so the only difference between two files is the change under test. See [`src/core/suite.js`](src/core/suite.js) for each filter. A few notes:

- **Dim room** darkens in linear light (sRGB gamma 2.2), one stop = half the light.
- **Flickering light** multiplies brightness by `1 + 2%·sin(2πft)`, with *f* set 22 bpm away from your measured pulse, so a reading that follows the flicker is easy to spot. A second variant drifts exposure by 8% at a breathing-like rate.
- **Shaky camera** sways the whole frame with a mix of slow sines (0.2 to 0.8 Hz).
- **Face covered** boxes are placed from the face landmarks the SDK returns on the original clip.
- **Played faster / slower** retimes frames (`setpts`) and resamples to 30 fps.

## Consent and data handling

- **Consent.** The app opens on a consent screen that says what is recorded, where it is stored and what leaves the computer. The camera stays off until you agree, and after that only turns on when you press a button that says so. Consent can be withdrawn in *Consent & data*.
- **Storage.** Clips (video of your face), any reference pulse you type in, and crash-test readings are written to one folder: `./data` by default (`TRUSTFALL_DATA` overrides it). Nothing else is stored.
- **Sharing.** Nothing is uploaded. There are no accounts, analytics or AI services.
- **SDK network use.** SmartSpectra computes readings on-device and contacts Presage to check the API key and usage. TrustFall creates every SDK session with `enableTelemetry: false`, so no session summaries or readiness reports are sent ([SDK telemetry & privacy](https://smartspectra.presagetech.com/docs/telemetry-and-privacy)).
- **Retention and deletion.** Data is kept until you delete it. *Delete all data* (or `node src/cli.js delete-all --yes`) removes the whole folder; single clips can be deleted from the home screen.
- **Other people.** Only record yourself or someone who has agreed beforehand. No covert monitoring.

## Limits

One person, one clip and one camera make an **informal test**, not a validation study; every result is shown with its sample size. The damage is simulated: a darkened video is not the same as a dark room, which also changes camera exposure and noise. The expected value for "same" variants is the SDK's own reading of the original clip, so TrustFall measures *consistency under damage*, not absolute accuracy. If you add a reference reading (pulse oximeter or watch), the report compares it with the original clip.

## Project layout

```
src/core/     suite (variants), media (ffmpeg), measure (SDK runner), analyze, crash (orchestration), export
src/main/     Electron main process, crash-test worker (utility process), preload bridge
src/renderer/ UI: record, crash test, report, wind tunnel, charts
src/cli.js    command-line runner
test/         analysis tests (npm test)
```

Built for the [DEV Presage SmartSpectra SDK Challenge](https://dev.to/challenges/presage-2026-11-04). MIT licence for TrustFall's code; the SmartSpectra SDK has its own licence.
