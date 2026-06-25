/**
 * Browser-fingerprint hardening, injected into every page before its own
 * scripts run. The guiding principle is CONSISTENCY: we present a coherent
 * "Linux desktop Chrome on real hardware" identity. We deliberately do NOT
 * pretend to be Windows/Mac — the UA, platform and GPU would then contradict
 * each other, which is a stronger bot signal than just being what we are.
 *
 * It runs as a string (not a TS function) so the bundler can't instrument it
 * with helpers that don't exist in the browser context.
 */
export const STEALTH_SCRIPT = String.raw`(() => {
  // 1. Make absolutely sure automation isn't advertised.
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}

  // 2. deviceMemory — bundled Chromium often leaves this undefined; real
  //    Chrome reports a power-of-two value.
  try {
    if (navigator.deviceMemory === undefined) {
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    }
  } catch (e) {}

  // 3. The big one: WSL has no GPU, so WebGL falls back to SwiftShader (a
  //    classic VM/automation tell). Report a common real Linux Intel GPU.
  try {
    var VENDOR = 'Intel Inc.';
    var RENDERER = 'Mesa Intel(R) UHD Graphics (CML GT2)';
    var patch = function (proto) {
      if (!proto || !proto.getParameter) return;
      var orig = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === 37445) return VENDOR;   // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return RENDERER; // UNMASKED_RENDERER_WEBGL
        return orig.call(this, p);
      };
    };
    if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  } catch (e) {}

  // 4. Client Hints: present "Google Chrome" branding (bundled Chromium only
  //    advertises "Chromium"), kept Linux-consistent with the UA.
  try {
    if (navigator.userAgentData) {
      var brands = [
        { brand: 'Not)A;Brand', version: '99' },
        { brand: 'Google Chrome', version: '147' },
        { brand: 'Chromium', version: '147' }
      ];
      var fullVersionList = [
        { brand: 'Not)A;Brand', version: '99.0.0.0' },
        { brand: 'Google Chrome', version: '147.0.0.0' },
        { brand: 'Chromium', version: '147.0.0.0' }
      ];
      var high = {
        architecture: 'x86', bitness: '64', brands: brands,
        fullVersionList: fullVersionList, mobile: false, model: '',
        platform: 'Linux', platformVersion: '6.6.0',
        uaFullVersion: '147.0.0.0', wow64: false
      };
      var ud = {
        brands: brands, mobile: false, platform: 'Linux',
        getHighEntropyValues: function () { return Promise.resolve(high); },
        toJSON: function () { return { brands: brands, mobile: false, platform: 'Linux' }; }
      };
      Object.defineProperty(navigator, 'userAgentData', { get: function () { return ud; } });
    }
  } catch (e) {}

  // 5. Normalize the permissions/notifications quirk some detectors probe:
  //    automated Chrome can report 'denied' while Notification.permission says
  //    'default'. Keep them in agreement.
  try {
    var origQuery = navigator.permissions && navigator.permissions.query;
    if (origQuery) {
      navigator.permissions.query = function (params) {
        if (params && params.name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        return origQuery.call(navigator.permissions, params);
      };
    }
  } catch (e) {}
})();`;
