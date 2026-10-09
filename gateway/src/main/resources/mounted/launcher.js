/*
 * Web IDE launch tile - redirect stub.
 *
 * Served at /res/scriptide/launcher.js and mounted as the Gateway home-page
 * "Web IDE" nav tile (see ScriptIdeModuleHook#setup and
 * ModuleConstants.LAUNCHER_BUNDLE_NAME). The Gateway shell script-loads this
 * file, reads the UMD global window.ScriptIdeLauncher, and renders its
 * `ScriptIdeLauncher` export as a React function component. That component
 * opens the standalone full-page SPA in a NEW TAB and leaves the Gateway page
 * where it was.
 *
 * A new tab, not a redirect (01/09/2026): the IDE is a place you sit in
 * for a while with unsaved buffers, so taking over the Gateway tab means the
 * Back button lands you on a page holding editors you did not mean to leave.
 *
 * Popup blockers are the catch. window.open outside a user gesture is blocked
 * silently and returns null, and by the time React renders this component the
 * click that caused it may no longer count as user activation. So: try to open,
 * and if the handle comes back null, fall back to the old in-place redirect.
 * That degrades to "it still works, just in this tab" rather than to a nav tile
 * that does nothing at all, which is the failure users cannot diagnose.
 *
 * Hand-written rather than bundled, on purpose. It needs no React import (it
 * returns null), and keeping it out of the Vite bundle means the one file the
 * Gateway shell loads through SystemJS stays dependency-free - which matters,
 * because React 19 dropped UMD builds and the shell's loader needs a UMD global.
 * The wrapper mirrors the shape webpack's `libraryTarget: "umd"` emits, so the
 * loader resolves it as window[moduleName][exportName].
 *
 * The redirect target is duplicated from ScriptIdePaths.SPA_LAUNCH_TARGET - a
 * static asset cannot import a Java constant. Keep the two in sync. The trailing
 * slash is load-bearing: /data/scriptide (no slash) returns 404.
 */
(function (root, factory) {
  if (typeof exports === "object" && typeof module === "object") {
    module.exports = factory();
  } else if (typeof define === "function" && define.amd) {
    define("ScriptIdeLauncher", [], factory);
  } else if (typeof exports === "object") {
    exports.ScriptIdeLauncher = factory();
  } else {
    root.ScriptIdeLauncher = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Keep in sync with ScriptIdePaths.SPA_LAUNCH_TARGET.
  var TARGET = "/data/scriptide/";

  // Renders nothing. Opens the IDE in a new tab, falling back to an in-place
  // redirect if the browser blocked it.
  //
  // Returns true if a tab was actually opened.
  //
  // Do NOT pass "noopener" in the features string: per spec that makes
  // window.open return null even when it succeeded, so blocked and opened
  // become indistinguishable and the fallback below would fire every time,
  // redirecting in place and silently deleting the feature. Open plainly, then
  // sever the opener by hand — the target is same-origin, so the assignment is
  // allowed, and a blocked popup is then unambiguously null.
  function openIdeTab() {
    try {
      var handle = window.open(TARGET, "_blank");
      if (!handle) {
        return false;
      }
      try {
        handle.opener = null;
      } catch (e) {
        // Not fatal - the target is our own same-origin SPA, so an opener
        // handle is hygiene rather than an exposure.
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function redirectInPlace() {
    try {
      var win = (window.top && window.top !== window.self) ? window.top : window;
      win.location.replace(TARGET);
    } catch (e) {
      // Cross-origin framing guard - fall back to this window.
      window.location.replace(TARGET);
    }
  }

  function ScriptIdeLauncher() {
    if (!openIdeTab()) {
      redirectInPlace();
    }
    return null;
  }

  return {
    ScriptIdeLauncher: ScriptIdeLauncher,
    default: ScriptIdeLauncher
  };
});
