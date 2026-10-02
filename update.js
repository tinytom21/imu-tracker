// Android app only: on launch (and when brought back to the front) compare the bundled version with
// the live one on the website, and offer the new APK. The website itself always serves the latest
// version, so the browser build skips this.

const CHECK_EVERY_MS = 30 * 60 * 1000;

// "0.12" > "0.9": compare dot-separated numbers, not strings.
export function isNewer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa.at(i) || 0, y = pb.at(i) || 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function initUpdateCheck(config) {
  if (!window.AndroidIMU || !config.updateUrl) return;
  const box = document.getElementById('update');
  let lastCheck = 0;

  async function check() {
    lastCheck = Date.now();
    let live;
    try {
      const r = await fetch(`${config.updateUrl}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return;
      live = await r.json();
    } catch { return; } // offline: try again next time
    const current = window.APP_VERSION;
    if (!live.version || !live.apkUrl || !isNewer(live.version, current)) { box.hidden = true; return; }
    let dismissed = null;
    try { dismissed = localStorage.getItem('imuUpdateDismissed'); } catch { /* storage unavailable */ }
    if (dismissed === live.version) return;

    box.innerHTML = '';
    const text = document.createElement('div');
    text.className = 'update-text';
    text.innerHTML = `<b>Version ${live.version} is available</b> <span>(you have ${current})</span>`;
    if (live.notes) { const n = document.createElement('div'); n.className = 'update-notes'; n.textContent = live.notes; text.append(n); }
    // An ordinary link: the app opens anything outside its own files in the phone's browser,
    // which downloads the APK and hands it to the Android installer.
    const get = document.createElement('a');
    get.className = 'update-get';
    get.href = live.apkUrl;
    get.textContent = 'Download';
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'update-later';
    later.setAttribute('aria-label', 'Dismiss');
    later.textContent = '✕';
    later.addEventListener('click', () => {
      box.hidden = true;
      try { localStorage.setItem('imuUpdateDismissed', live.version); } catch { /* storage unavailable */ }
    });
    box.append(text, get, later);
    box.hidden = false;
  }

  check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck > CHECK_EVERY_MS) check();
  });
}
