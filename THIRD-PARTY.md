# Third-party notices

This package is MIT licensed (see [LICENSE](./LICENSE)). Three pieces of it come from
someone else and keep their own terms.

## `vendor/qrcode-generator.mjs`

[`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator) by Kazuhiko Arase — MIT License,
Copyright (c) 2009 Kazuhiko Arase. Vendored verbatim so that a `link:`-installed plugin needs no
`node_modules`; the license notice is preserved in the file header.

It exists because the WeChat platform hands back a *landing-page URL* for login rather than an image, so the
bridge has to render the QR code itself.

## `vendor/silk-wasm/`

[`silk-wasm`](https://www.npmjs.com/package/silk-wasm) 3.7.1 - MIT License, Copyright (c) idranme; upstream at
<https://github.com/idranme/silk-wasm>. The ESM bundle and its `silk.wasm` are vendored **unchanged**, with the
upstream `LICENSE` beside them and a `README.md` recording the registry hash they were verified against
(`sha512-mXPwLRtZxrYV3TZx41jMAeKc80wvmyrcXIcs8HctFxK15Ahz2OJQENYhNgEPeCEOdI6Mbx1NxQsqxzwc3DKerw==`).

It exists for the **incoming** direction: WeChat delivers voice as SILK and nothing else on a normal machine can
play it, so an inbound voice message is decoded to a playable WAV (`silkToWav()`), falling back to the raw `.silk`. The
same use is made of this module by Tencent's own WeChat channel. (The *outgoing* direction cannot use it: a WeChat
voice bubble is not deliverable through this API - see the README.) Vendored rather than declared as a dependency,
because this plugin is installed as a directory and an `npm install` never runs.
## `ilink.js`

The iLink bot protocol implementation was ported to JavaScript from
[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
(MIT License, Copyright (c) Tencent), the official OpenClaw WeChat channel. Only the protocol facts and
wire shapes were carried over; the code here is a fresh, dependency-free rewrite including the media
upload/download path, the QR state machine and the inbound message normalization.
