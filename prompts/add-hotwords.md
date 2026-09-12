---
description: Add default hotwords to the pi-listen fork, test, push, and install
argument-hint: "<word-or-phrase> [...]"
---
Add these default hotwords to the personal pi-listen fork: $ARGUMENTS

Work in `/Users/pascal.seitz/Development/pi-listen` and complete the change end to end:

1. Add the terms to `DEFAULT_HOTWORDS` in `extensions/voice/config.ts`. Preserve the supplied spelling, avoid case-insensitive duplicates, and do not add them to personal Pi settings.
2. Update relevant tests and documentation when needed.
3. Run `npx --yes bun test tests/config.test.ts tests/sherpa-engine.test.ts` and `git diff --check`.
4. Commit the change with a concise commit message and push `main` to the `PSeitz/pi-listen` fork.
5. Run `pi update git:github.com/PSeitz/pi-listen` and verify that the installed checkout matches the pushed commit.
6. Report the added terms, test result, commit hash, and remind me to run `/reload`.

Keep changes minimal. Stop and explain rather than force-pushing or bypassing failed tests.
