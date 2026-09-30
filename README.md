# IMU Tracker

Proof of concept: record a phone's accelerometer + gyroscope in the browser and estimate how far it moved (X right, Y forward, Z up).

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

Use **Download raw data (CSV)** on the phone and **Load CSV** on desktop to replay recordings.
