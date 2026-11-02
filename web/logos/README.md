# Provider marks

Vendored from [Lobe Icons](https://github.com/lobehub/lobe-icons), revision c385b2b8d1f9e19aa86e628d4e23c91ee1111a47.
The SVGs retain their original geometry and render locally as image assets.
Claude uses claude.svg; GPT / Codex uses openai.svg; Grok uses grok.svg; Gemini uses gemini.svg.
Upstream MIT license is preserved in LICENSE. Brand marks identify their providers.

`pixels.ts` is a derived monochrome pixel mask for weekly quota plates. Each SVG is
rasterized at 16px, centered in a 20px grid, and sampled at alpha >= 96. The plate
renderer retains the source shape with discrete squares instead of smooth curves.
These derived masks use the same upstream MIT license and provider identification.
