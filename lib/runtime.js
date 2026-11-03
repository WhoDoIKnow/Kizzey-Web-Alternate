'use strict';

// Shared runtime singletons. The original Python server kept these as module
// globals; Node modules get the same shape through this object.
module.exports = {
  STORE: null,
  GATEWAY: null,
  MIRROR: null,
  TICKER: null,
  BROWSER_LOGIN_LOCK: false,
  BROWSER_LOGIN_ABORT: false,
};