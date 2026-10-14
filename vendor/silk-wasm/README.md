# silk-wasm (vendored)

Tencent SILK codec, compiled to WebAssembly - the encoder that makes a **voice bubble** possible on personal
WeChat, which renders one only for SILK.

| | |
|---|---|
| Package | [`silk-wasm`](https://www.npmjs.com/package/silk-wasm) 3.7.1 |
| Upstream | https://github.com/idranme/silk-wasm |
| License | **MIT** (see `LICENSE` beside this file) |
| Integrity | the published tarball was verified against its registry hash `sha512-mXPwLRtZxrYV3TZx41jMAeKc80wvmyrcXIcs8HctFxK15Ahz2OJQENYhNgEPeCEOdI6Mbx1NxQsqxzwc3DKerw==` before being copied here |
| Files | `index.mjs` (the ESM bundle), `silk.wasm` (the codec), both unchanged from the published package |

It is **vendored** rather than declared as a dependency because this plugin is installed as a directory (a release
archive), not through `npm install` - a dependency would simply not be there at runtime. `voice.js` imports
`./silk-wasm/index.mjs` dynamically and only when SILK is actually needed.