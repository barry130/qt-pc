// Source-engine all-frame DocumentStart RTC boundary (shared native asset).
(() => {
  const names = [
    "RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection",
    "RTCDataChannel", "RTCIceGatherer", "RTCIceTransport", "RTCDtlsTransport", "WebTransport",
  ];
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const failures = [];
  for (const name of names) {
    try {
      const current = descriptor(globalThis, name);
      if (current && "value" in current && current.value === undefined &&
          current.writable === false && current.configurable === false) continue;
      define(globalThis, name, { value: undefined, writable: false, configurable: false });
    } catch {
      // Do not leave the remaining capabilities enabled when one host property
      // cannot be replaced. Expose a sticky failure for the page to fail closed.
      failures.push(name);
    }
  }
  if (failures.length && !descriptor(globalThis, "__qtRtcLockFailures")) {
    define(globalThis, "__qtRtcLockFailures", {
      value: Object.freeze(failures), enumerable: false, writable: false, configurable: false,
    });
  }
})();
