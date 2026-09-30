// Sensor capture: Generic Sensor API (Accelerometer + Gyroscope) with a
// devicemotion fallback. Emits merged samples:
// { t (s), ax, ay, az (m/s^2, incl. gravity), gx, gy, gz (rad/s) }

const NO_SENSOR_MSG = 'No motion sensors — open this on a phone over HTTPS';
const FIRST_SAMPLE_TIMEOUT_MS = 1500;
const DEG = Math.PI / 180;

export class Capture {
  /**
   * @param {{onSample:(s:object)=>void, onError?:(e:Error)=>void}} opts
   */
  constructor({ onSample, onError }) {
    this.onSample = onSample;
    this.onError = onError || (() => {});
    this.source = null;        // 'generic-sensor' | 'devicemotion' | null
    this.sampleRate = 0;       // measured Hz
    this._stops = [];
    this._times = [];          // recent timestamps for rate measurement
    this._running = false;
    this._iosPermissionAsked = false;
  }

  // Must be called directly from the Start click handler (iOS needs the user gesture).
  async requestPermission() {
    const DME = window.DeviceMotionEvent;
    if (DME && typeof DME.requestPermission === 'function') {
      const res = await DME.requestPermission();
      this._iosPermissionAsked = true;
      if (res !== 'granted') throw new Error('Motion sensor permission was denied.');
    }
  }

  /** Starts capture. Resolves once the first sample arrives, rejects if none does. */
  async start() {
    this.stop();
    this._running = true;
    this._times = [];
    this.sampleRate = 0;

    let genericError = null;
    if (typeof Accelerometer !== 'undefined' && typeof Gyroscope !== 'undefined') {
      try {
        await this._startGeneric();
        return;
      } catch (e) {
        genericError = e;
        this._teardown();
        this._running = true;
      }
    }
    try {
      await this._startDeviceMotion();
    } catch (e) {
      this._teardown();
      if (genericError && genericError.name && !/^(No motion|Timeout)/.test(genericError.message)) {
        e.message += ` (Generic Sensor API: ${genericError.name}: ${genericError.message})`;
      }
      throw e;
    }
  }

  stop() {
    this._running = false;
    this._teardown();
  }

  _teardown() {
    for (const f of this._stops) { try { f(); } catch { /* ignore */ } }
    this._stops = [];
    this.source = null;
  }

  _emit(s) {
    if (!this._running) return;
    const ts = this._times;
    ts.push(s.t);
    if (ts.length > 100) ts.shift();
    if (ts.length > 5) this.sampleRate = (ts.length - 1) / (ts[ts.length - 1] - ts[0]);
    this.onSample(s);
  }

  // Resolve on first emitted sample, reject on error / timeout.
  _firstSample(register) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      const timer = setTimeout(() => finish(new Error(NO_SENSOR_MSG)), FIRST_SAMPLE_TIMEOUT_MS);
      register(() => finish(), (err) => {
        if (done) { this.onError(err); return; }   // error after startup
        finish(err);
      });
    });
  }

  async _startGeneric() {
    for (const name of ['accelerometer', 'gyroscope']) {
      try {
        const p = await navigator.permissions.query({ name });
        if (p.state === 'denied') {
          const e = new Error(`Permission for ${name} is denied.`);
          e.name = 'NotAllowedError';
          throw e;
        }
      } catch (e) {
        if (e.name === 'NotAllowedError') throw e;
        // permissions.query unsupported for this name: carry on
      }
    }

    await this._firstSample((ok, fail) => {
      const acc = new Accelerometer({ frequency: 200, referenceFrame: 'device' });
      const gyr = new Gyroscope({ frequency: 200, referenceFrame: 'device' });
      let g0 = null, g1 = null; // last two gyro readings {t,x,y,z}

      gyr.addEventListener('reading', () => {
        g0 = g1;
        g1 = { t: gyr.timestamp / 1000, x: gyr.x, y: gyr.y, z: gyr.z };
      });
      acc.addEventListener('reading', () => {
        if (!g1) return;
        const t = acc.timestamp / 1000;
        let g = g1;
        if (g0 && g1.t > g0.t && t >= g0.t && t <= g1.t) {
          const f = (t - g0.t) / (g1.t - g0.t);
          g = { x: g0.x + (g1.x - g0.x) * f, y: g0.y + (g1.y - g0.y) * f, z: g0.z + (g1.z - g0.z) * f };
        }
        this._emit({ t, ax: acc.x, ay: acc.y, az: acc.z, gx: g.x, gy: g.y, gz: g.z });
        ok();
      });
      const onErr = (ev) => fail(ev.error || new Error('Sensor error'));
      acc.addEventListener('error', onErr);
      gyr.addEventListener('error', onErr);

      try {
        acc.start();
        gyr.start();
      } catch (e) { fail(e); }
      this._stops.push(() => { try { acc.stop(); } catch { /* */ } try { gyr.stop(); } catch { /* */ } });
    });
    this.source = 'generic-sensor';
  }

  async _startDeviceMotion() {
    if (typeof window.DeviceMotionEvent === 'undefined') throw new Error(NO_SENSOR_MSG);
    // iOS reports accelerationIncludingGravity with the opposite sign to Android.
    const flip = typeof DeviceMotionEvent.requestPermission === 'function' ? -1 : 1;

    await this._firstSample((ok) => {
      const handler = (e) => {
        const a = e.accelerationIncludingGravity;
        const r = e.rotationRate;
        if (!a || a.x == null || !r || r.alpha == null) return;
        this._emit({
          t: e.timeStamp / 1000,
          ax: flip * a.x, ay: flip * a.y, az: flip * a.z,
          gx: r.beta * DEG, gy: r.gamma * DEG, gz: r.alpha * DEG,
        });
        ok();
      };
      window.addEventListener('devicemotion', handler);
      this._stops.push(() => window.removeEventListener('devicemotion', handler));
    });
    this.source = 'devicemotion';
  }
}
