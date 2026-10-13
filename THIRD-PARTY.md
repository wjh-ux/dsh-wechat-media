# Third-party notices

This package is MIT licensed (see [LICENSE](./LICENSE)). Two pieces of it come from
someone else and keep their own terms.

## `vendor/qrcode-generator.mjs`

[`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator) by Kazuhiko Arase — MIT License,
Copyright (c) 2009 Kazuhiko Arase. Vendored verbatim so that a `link:`-installed plugin needs no
`node_modules`; the license notice is preserved in the file header.

It exists because the WeChat platform hands back a *landing-page URL* for login rather than an image, so the
bridge has to render the QR code itself.

## `ilink.js`

The iLink bot protocol implementation was ported to JavaScript from
[`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
(MIT License, Copyright (c) Tencent), the official OpenClaw WeChat channel. Only the protocol facts and
wire shapes were carried over; the code here is a fresh, dependency-free rewrite including the media
upload/download path, the QR state machine and the inbound message normalization.
