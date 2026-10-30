# Third-Party Notices

## OpenClaw

> **Note (2026-09-30):** OpenClaw is not required and not used. DéjàML runs its own native agents and calls OpenAI or Anthropic directly; the CLI integration described below was removed, and no OpenClaw code, package, or binary is part of DéjàML. This entry is kept as a historical record.

DéjàML previously integrated with the external OpenClaw runtime through its documented CLI JSON contracts.

- Project: OpenClaw
- Version tested: `2026.9.5`
- Revision reported by the installed runtime: `ec9c1a1`
- Source: <https://github.com/openclaw/openclaw>
- License: MIT

No OpenClaw source files are copied into this repository at this phase. Operators installing OpenClaw should retain the license and third-party notices distributed with that installation.

## onetake and Kokoro (Feasibility and Viability video)

`docs/media/dejaml-feasibility-and-viability.mp4` was made with onetake's
"clearing" case and narrated with the Kokoro text-to-speech model (voice
`af_aoede`). The sound effects were generated, not downloaded.

- onetake: <https://github.com/feitangyuan/onetake>, under a noncommercial
  license, so the video is for presentations, reports and posts, not paid
  advertising.
- Kokoro: <https://huggingface.co/hexgrad/Kokoro-82M>

The video is not part of the MIT-licensed source code.

## Inside DéjàML explainer (`site/`)

- RobotExpressive model by Tomás Laulhé (Quaternius), modified by Don McCurdy,
  from the three.js examples: CC0 1.0. Stored in `site/models/` and embedded
  into the built page.
- three.js r169 (MIT) is loaded from jsDelivr at run time and is not copied
  into this repository.
- Newsreader, Schibsted Grotesk and JetBrains Mono (SIL Open Font License 1.1)
  are loaded from Google Fonts at run time.
