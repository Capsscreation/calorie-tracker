// Barcode reading. Uses the browser's BarcodeDetector where it exists (Android Chrome)
// and falls back to the html5-qrcode library (needed on iPhone).
const LIB = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];
let loading = null;

function loadLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIB;
    s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error('Could not load the barcode scanner. Are you offline?')); };
    document.head.append(s);
  });
  return loading;
}

function libFormats() {
  const F = window.Html5QrcodeSupportedFormats;
  return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128];
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = NATIVE_FORMATS.filter(f => supported.includes(f));
    return formats.length ? new window.BarcodeDetector({ formats }) : null;
  } catch {
    return null;
  }
}

// Starts the camera inside the element with id `elId`. Calls onCode once with the first barcode.
// Returns a stop() function.
export async function startLiveScan(elId, onCode) {
  await loadLib();
  const scanner = new window.Html5Qrcode(elId, {
    formatsToSupport: libFormats(),
    useBarCodeDetectorIfSupported: true,
    experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    verbose: false,
  });
  let done = false;
  const stop = async () => {
    try { if (scanner.isScanning) await scanner.stop(); scanner.clear(); } catch { /* already stopped */ }
  };
  await scanner.start(
    { facingMode: 'environment' },
    {
      fps: 12,
      qrbox: (w, h) => ({ width: Math.max(120, Math.floor(w * 0.85)), height: Math.max(80, Math.floor(Math.min(w, h) * 0.45)) }),
      aspectRatio: 1.333,
    },
    text => { if (done) return; done = true; stop(); onCode(text); },
    () => {},
  );
  return stop;
}

// Reads a barcode from a photo file. Throws if none is found.
export async function scanImageFile(file) {
  const det = await nativeDetector();
  if (det) {
    try {
      const bmp = await createImageBitmap(file);
      const found = await det.detect(bmp);
      if (found.length) return found[0].rawValue;
    } catch { /* fall through to the library */ }
  }
  await loadLib();
  let host = document.getElementById('scan-file-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'scan-file-host';
    host.hidden = true;
    document.body.append(host);
  }
  const scanner = new window.Html5Qrcode('scan-file-host', { formatsToSupport: libFormats(), verbose: false });
  try {
    return await scanner.scanFile(file, false);
  } catch {
    throw new Error("Couldn't find a barcode in that photo. Try again closer, with the barcode flat and in focus.");
  } finally {
    try { scanner.clear(); } catch { /* nothing to clear */ }
  }
}
