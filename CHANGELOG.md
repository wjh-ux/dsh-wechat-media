# Changelog

## 0.1.1

Card fixes reported from real use:

- **Adding a second account is now obvious.** The primary button always reads
  *Add an account (QR code)* instead of switching to *Pair again* once one account
  existed — that label made a second account look impossible. Each account row keeps
  its own *Pair again* and *Unpair*.
- **A pairing attempt can be cancelled.** Clicking the QR button by mistake used to
  leave a live QR code with no way out but waiting for it to expire; the card now
  offers *Cancel*, and the cancelled attempt disappears from the card immediately.
- The account count reads *N 个账号 / account(s)*, and the scan hint explains that
  scanning a different WeChat account adds another one while the same account merely
  refreshes its login.
- Two regression tests cover both behaviours (49 tests total).

## 0.1.0

First release: QR pairing for one or more personal WeChat accounts, one DSH
conversation per contact or group, two-way text / image / video / document / archive
transfer, media decrypted into `$DSH_HOME/wechat-inbox`, persistent accounts and
routes, and the `wechat_send_text` / `wechat_send_file` / `wechat_status` tools.
