# 2youg1's MD2Prompt

[中文](README.md) · [Download](../../releases) · [Design spec (中文)](SPEC.md) · [Feedback](https://github.com/kaile9)

**One HTML file — the revision workbench between you and your AI.**

Double-click, edit Markdown like Word, and every change is tracked automatically. Hit "Copy Prompt" and the AI — without seeing the original file, without any tool calls — reads exactly what you changed and what you still want done.

![Render mode](docs/assets/render.png)

## Why it exists

Three chronic pains of remote AI co-writing:

1. **Word wastes tokens** — AI speaks Markdown natively; nobody wants to paste a `.docx`;
2. **Common renderers swallow prompt-style XML tags** — `<identity>`-style structural hints for agents vanish silently, and editing diagram source in Notepad is an escaping disaster;
3. **Every round means re-uploading the whole file** — three sentences changed, three hundred KB transferred.

MD2Prompt's answer: **the protocol matters more than the editor.** The editor is a thin layer; the real product is a protocol-precise `Prompt.md` diary — your edits and annotations, saved in real time, in a format an AI can consume exactly.

## 30-second quickstart

1. Grab `2youg1-md2prompt.html` from [Releases](../../releases) (one file, 6 MB, all deps inlined — no network, no API, no telemetry);
2. Double-click (Chrome/Edge recommended), click 「打开」 and pick your `.md` / `.jsonl` / `.xml`;
3. Just edit. Cards appear instantly in the right 「修订」 panel;
4. Click 「复制 Prompt」 and paste to your AI. It receives: file name, BLAKE3 hash, every edit (before + after + line + time), every annotation;
5. When the AI returns a new version, save it and 「打开」 again — if the hash pairs, **all your previous tracked changes restore automatically**. Keep iterating.

> Foolproof by design: the original stays clean and every action is auto-saved. Even if you close the tab outright, `name.prompt.md` in the same folder still gives you a paste-ready prompt.

## Feature tour

- **Edit-and-track**: replace / insert / delete / move / annotate — recorded at sentence granularity (old struck through, new highlighted), like Word track-changes without an "accept" step.
- **Annotations (B-class requests)**: select text → floating ✎ card (or `Alt+M`); dashed underline + pin; sidebar card shows the quote (truncated, click to expand), editable, withdrawable — the AI gets exactly "source text + your note".
- **Hide / Withdraw (two-stage)**: "Hide" collapses confirmed edits; "Withdraw" previews strikethrough first (cancellable), confirm to actually revert; withdrawn edits become C-class tombstones (capped at 50), revivable anytime.
- **Render / Source / Split modes**: WYSIWYG; a CodeMirror source editor (syntax highlighting, line numbers, find & replace); or split view with synchronized scrolling.
- **Edit XML cards in place**: prompt-style tag blocks render as cards whose source you edit directly — tracked per keystroke, no modal whole-block replacement.
- **Faithful rendering**: Mermaid, KaTeX, tables, images (relative paths via directory permission), footnote popovers.
- **JSONL dataset mode**: virtualized record-card stream (smooth at 10k+ lines), form/raw-JSON dual-tab editor — an AI training-data cleaning bench.
- **Large-document friendly**: auto-splits above 300 KB / 2000 lines; the editor only carries one section (a 950 KB doc opens in ~0.5 s).
- **3 themes × 2 styles**: pure-black / marble / warm-paper × geek / humanist; font size & weight, line height, page width, alignment, brightness/contrast, CJK & Latin font stacks, first-line indent, line-number gutter, guide lines — a genuine Word replacement for long-form writing.
- **Editing tools**: vertical tool rail + selection float card + customizable shortcuts.
- **Exports**: copy Prompt (tombstones omitted) / download Prompt.md / download clean copy / export PDF (header: source-file completion time, footer: export time).

![Night theme](docs/assets/night.png)
![Split view](docs/assets/split.png)

## The protocol at a glance

```xml
---
protocol: md2prompt/1.2.0
doc: constitution-zh.md
doc-hash: blake3:9f2c…
本次：B 类请求 1 条，A 类直接修改 2 条，C 类墓碑 0 条（无需执行）。
---
<requests>
<request id="B1" type="note" line="56" time="14:22">
Split this sentence in two and add an example.
<quote>The constitution guides Claude's values and behavior…</quote>
</request>
</requests>
---
<edits>
<edit id="A1" type="replace" line="102" time="14:25">
<before>…original…</before>
<after>…revised…</after>
</edit>
</edits>
```

- Semver protocol — same major version is backward compatible;
- op ids are stable across exports (cache-friendly for the AI side); large edits ship as `<del>/<ins>` patches (token-lean);
- C-class tombstones stay in the diary and are omitted when copying.

Full protocol in [SPEC.md](SPEC.md) (Chinese; the single source of truth, with the full revision history).

## Build & develop

```bash
bun install
bun run dev      # dev server
bun run build    # produces a single dist/2youg1-md2prompt.html
bun run check    # tsc --noEmit
bun test         # 142 unit tests (pure-function core, full coverage)
```

E2E (Playwright, requires Node): `cd e2e && node life.mjs` (plus v13/note/srcmode/export/look and more suites).

## FAQ

**Why not a VS Code extension?** Because the target workflow is writing, not programming: double-click to run, no runtime, no workflow change. A single HTML file is the lowest possible barrier.

**Does the AI need tool access to cooperate?** No — that's the point. Everything in Prompt.md is self-explanatory text; the AI reads it, knows exactly what to change and how, and returns the new full text. Zero function calls.

**Where does my data go?** Nowhere. No network requests, no API, no telemetry. File I/O goes through the browser's File System Access API; handles live in your own IndexedDB.

## License

MPL-2.0 (see [LICENSE](LICENSE)). Author: [2youg1](https://github.com/kaile9).
