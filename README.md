# Offset

Proof of concept: record a phone's accelerometer + gyroscope and estimate how far it moved (X right, Y forward, Z up) — for example a lever-arm offset on a vehicle. Working name; formerly "IMU Tracker" (the repo, Worker and Android package still use that name).

Live: https://tinytom21.github.io/imu-tracker/

## How it works

1. **Start hold (2 s still)** — gravity direction/magnitude and gyro bias are measured; the start attitude defines the world frame (Y = top of phone flattened to horizontal).
2. **Orientation** — bias-corrected gyro is integrated as a quaternion so accelerations are rotated into the world frame even while the phone turns.
3. **End hold** — the phone must be still before Stop. Residual tilt at the end corrects gyro drift; residual velocity (which must be zero) is removed as a linear ramp before the second integration.

Expect roughly ±2–5 cm on a quick (< 5 s) move in simulation; real-world error is larger and grows fast with move duration.

## Files

- `processing.js` — calibration, orientation, integration, drift correction
- `capture.js` — Generic Sensor API (Android Chrome) with `devicemotion` fallback
- `app.js`, `index.html`, `style.css` — UI
- `viz.js` — three.js 3D path + top/side 2D views
- `tests/test.html` — synthetic-trajectory tests for `processing.js` (serve the folder and open it)

## Android app

A native Android wrapper (WebView around the same web files plus a native sensor bridge) lives in `android/`. Chrome rounds sensor data to 0.1 m/s² / 0.1 °/s and caps it at ~55 Hz; the app records **full-rate, unrounded** accelerometer, gyroscope and rotation-vector data.

- Download the APK: https://github.com/tinytom21/imu-tracker/releases/tag/android-latest
- On the phone, allow **Install unknown apps** for your browser or file manager, then open the APK.
- Built by GitHub Actions (`.github/workflows/android.yml`) on every push that touches the web files or `android/`. The web files are copied into the app at build time, not duplicated.
- In the app, **Download raw data (CSV)** opens the Android share sheet.

Use **Download raw data (CSV)** on the phone and **Load CSV** on desktop to replay recordings.
