# fixtures

## `lilto-client.ts`

A **verbatim copy** of `~/Developer/lilto/temp/src/relay/client.ts` as of
2026-08-23, kept here as a contract snapshot.

lilto is the main consumer and is meant to run against this daemon **without a
single change on its side**. `test/compat-lilto.mjs` drives this exact file
against the real daemon + mock ext, so any change here that would break lilto
fails the suite instead of failing in production.

Do not edit it to make a test pass. If it needs to change, the daemon broke
compatibility — either restore compatibility, or re-copy the file *after*
lilto has actually been updated, and say so in the commit.

Node runs it directly: native type stripping, no build step.
