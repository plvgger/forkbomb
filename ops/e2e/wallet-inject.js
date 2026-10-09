// A scripted Wallet Standard wallet for the dApp e2e. Injected with page.evaluateOnNewDocument before any page
// script runs, after window.__E2E_WALLET__ = {name, address, publicKey: number[]} has been set the same way.
// It registers through the wallet-standard event protocol (wallet-standard:register-wallet / app-ready),
// exactly as browser-extension wallets do. It holds no key: signing and sending happen in the Node harness
// behind window.__e2eWallet(op, payloadJson) (page.exposeFunction), which decides to approve or reject.
// Plain JS on purpose: it is passed to the page as a string, untouched by any transpiler.
(function () {
  "use strict";
  var cfg = window.__E2E_WALLET__;
  if (!cfg || !cfg.address) return;

  var CHAINS = ["solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"];
  var ICON =
    "data:image/svg+xml;base64," +
    btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#14f195"/></svg>');

  function b64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(str) {
    var s = atob(str);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /** What the wallet says it can send. The harness sets window.__E2E_TX_VERSIONS (e.g. ["legacy"]) to act as a legacy-only wallet. */
  function txVersions() {
    var v = window.__E2E_TX_VERSIONS;
    return Array.isArray(v) ? v.slice() : ["legacy", 0];
  }

  var account = Object.freeze({
    address: cfg.address,
    publicKey: new Uint8Array(cfg.publicKey),
    chains: CHAINS.slice(),
    features: ["solana:signAndSendTransaction", "solana:signTransaction"],
    label: "e2e",
  });
  var accounts = [];
  var listeners = { change: [] };
  function emit(event, props) {
    (listeners[event] || []).slice().forEach(function (l) {
      try {
        l(props);
      } catch (e) {
        console.error(e);
      }
    });
  }

  /** Calls the Node bridge. A bridge error whose message has E2E_REJECT becomes a wallet-style rejection (4001). */
  function bridge(op, payload) {
    if (typeof window.__e2eWallet !== "function") return Promise.reject(new Error("e2e wallet bridge missing"));
    return window.__e2eWallet(op, JSON.stringify(payload || {})).catch(function (err) {
      var msg = String((err && err.message) || err);
      if (msg.indexOf("E2E_REJECT") >= 0) {
        var e = new Error("User rejected the request.");
        e.code = 4001;
        e.name = "WalletSignTransactionError";
        throw e;
      }
      // Surface the RPC's own words, like a wallet would.
      throw new Error(msg.replace(/^Error:\s*/, ""));
    });
  }

  var wallet = {
    version: "1.0.0",
    name: cfg.name || "E2E Wallet",
    icon: ICON,
    chains: CHAINS.slice(),
    get accounts() {
      return accounts.slice();
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: function () {
          return bridge("connect", {}).then(function () {
            accounts = [account];
            emit("change", { accounts: accounts.slice() });
            return { accounts: accounts.slice() };
          });
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: function () {
          accounts = [];
          emit("change", { accounts: [] });
          return Promise.resolve();
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: function (event, listener) {
          (listeners[event] = listeners[event] || []).push(listener);
          return function () {
            listeners[event] = (listeners[event] || []).filter(function (l) {
              return l !== listener;
            });
          };
        },
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        get supportedTransactionVersions() {
          return txVersions();
        },
        signAndSendTransaction: function () {
          var inputs = Array.prototype.slice.call(arguments);
          return inputs.reduce(function (p, input) {
            return p.then(function (out) {
              return bridge("signAndSend", {
                tx: b64(input.transaction),
                chain: input.chain,
                account: input.account && input.account.address,
                options: input.options || null,
              }).then(function (sig) {
                return out.concat([{ signature: unb64(sig) }]);
              });
            });
          }, Promise.resolve([]));
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        get supportedTransactionVersions() {
          return txVersions();
        },
        signTransaction: function () {
          var inputs = Array.prototype.slice.call(arguments);
          return inputs.reduce(function (p, input) {
            return p.then(function (out) {
              return bridge("sign", { tx: b64(input.transaction) }).then(function (signed) {
                return out.concat([{ signedTransaction: unb64(signed) }]);
              });
            });
          }, Promise.resolve([]));
        },
      },
    },
  };

  function callback(api) {
    api.register(wallet);
  }
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: callback }));
  } catch (e) {
    console.error("e2e wallet: register-wallet dispatch failed", e);
  }
  try {
    window.addEventListener("wallet-standard:app-ready", function (ev) {
      callback(ev.detail);
    });
  } catch (e) {
    console.error("e2e wallet: app-ready listener failed", e);
  }
  window.__e2eWalletRegistered = true;
})();
