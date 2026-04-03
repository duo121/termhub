# AGENTS.md

This repository follows these execution rules.

## npm publishing

- For npm publishing, always use the interactive web confirmation flow.
- Trigger browser-based verification first, open the npm verification page for the user, and wait for the user to confirm in the browser.
- After browser confirmation succeeds, continue the publish flow and verify the published npm version.
- Never ask for a 6-digit OTP code.
- Never suggest `--otp`.
- Never propose switching this repository's npm publish flow to 6-digit verification.

## Messaging and positioning

- termhub is an AI-native terminal control tool.
- Preferred product framing:
  - Let AI inspect open terminals.
  - Let AI open a new terminal window or tab.
  - Let AI launch Codex inside that terminal.
  - Let AI send a prompt or task to Codex.
  - Let AI capture the result and report it back to the user.
  - Let AI monitor many Codex terminals in parallel, including a "30 Codex terminals" scenario for social copy.

## Social copy direction

- Social copy should focus on what the user asks the AI to do, not on raw feature lists.
- Lead with the pain being removed:
  - no more manually opening terminals
  - no more switching tab by tab
  - no more checking Codex sessions one by one
  - no more copying results back by hand
- Emphasize the closed loop:
  - open terminal
  - open tab
  - start Codex
  - send task
  - wait for response
  - bring answer back
- Include stronger scale framing when relevant:
  - one AI assistant can watch 30 Codex terminals for me

## README and social asset sync workflow

- When command behavior or key parameters change, always update both:
  - `README.md` and `README.zh-CN.md`
  - `social/readme-cover.en.html` and `social/readme-cover.zh-CN.html`
- `assets/readme-cover.en.png` and `assets/readme-cover.zh-CN.png` must be generated from the HTML sources above by screenshot export.
- Do not directly hand-edit or paint the PNG files as the source of truth.
- If README and social copy drift, fix both in the same change before finishing.
