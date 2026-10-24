# scripts

Two checks that caught real defects, kept so the next change can be checked in seconds.

## `node scripts/bug-hunt.mjs` - acceptance run

```text
node scripts/bug-hunt.mjs              # offline fuzz + the running plugin
node scripts/bug-hunt.mjs --offline    # pure functions only: no plugin, no network, no credentials
node scripts/bug-hunt.mjs --live 19387 # one port, offline skipped
```

The offline half fuzzes the command parser, every help page (by name and by alias), the three pref normalisers, the QQ
payload builders and the scrapling validator. The live half hits the running plugin's HTTP routes with the shapes a buggy
caller sends; every live check is either a read or an expected 4xx, so running it cannot change an installation's data.

Exit code is 1 when anything fails, so it can gate a release.

## `node scripts/verify-release.mjs` - nothing left out, nothing doubled

```text
GH_TOKEN=... node scripts/verify-release.mjs [owner/repo]
```

Compares three sources of truth by blob hash: the work tree, GitHub `main`, and the installed copy restricted to the
`files[]` packing contract. Tests are deliberately not expected in the installed copy - they live in the repository only,
and pretending otherwise was the first version's false alarm.

## Why these exist

In the 1.5.x line, running these found five real defects that 44 passing suites did not: a garbage `allowed` value
silently un-allowlisting a chat, peers created for accounts that do not exist, a manual chat name overwritten by the next
inbound message, `COM0` accepted as a port, and a call to a helper (`wecomConfig()`) that was never defined - which made
every `POST /peers` answer 400 with an empty body. A test suite checks what was thought of; these check what a caller
actually sends.
