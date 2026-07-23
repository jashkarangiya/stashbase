# Markdown

Markdown is the clearest example of the StashBase approach: an ordinary local
source file that people can write, preview, search, link, and hand to an Agent
without a conversion layer becoming the product.

## Current

- Markdown source is directly readable, editable, and indexable.
- Users can switch between a writing surface and a rendered document preview.
- Preview supports common document conventions: headings, lists, tables, task
  lists, code blocks, links, images, footnotes, and GitHub-flavoured Markdown.
- In Live Editing, complete supported links present readable text without
  changing their source offsets: click reveals source, modifier-click or
  keyboard activation follows safe local links in StashBase and HTTP(S) links
  through the system browser.
- In Live Editing, fenced code presents as an inert monospace block with its
  fences and language label concealed; recognized language labels receive
  static editor syntax highlighting. Entering or selecting inside reveals
  them as one editable construct and leaving restores the block, all without
  changing source. The parser owns block boundaries, so backticks inside
  content and unterminated fences do not corrupt them; unknown labels remain
  ordinary source and no code is executed. Inactive blocks expose their
  language label as an accessible copy control for the code contents; typing
  an opening triple fence completes its closing fence and a single inline
  backtick pairs its closing delimiter.
- In Live Editing, parser-recognized list markers have a reading-oriented
  presentation in a two-space hanging list gutter: an unordered `-` becomes a
  dot while ordered markers remain their actual numbers. Source spaces and
  item indentation remain unchanged. The gutter
  begins as soon as a marker and following space form a list, including an
  empty item. Only a cursor or selection on that marker reveals it. Enter continues a list or quote; from the start of a non-empty item's content it detaches that text into the next normal paragraph without adding vertical space; empty
  nested items outdent one level, and Tab or Shift+Tab moves an item with its
  child branch without trapping focus outside a list. Task markers are plain,
  disabled native HTML checkboxes. They remain source-backed and
  non-interactive in this slice.
- Live Editing copy, cut, paste, and Find operate on Markdown source even
  where the writing surface conceals syntax or presents a widget; Reading
  View retains its rendered-text clipboard and Find behaviour.
- Safe local links remain in StashBase; external links retain their normal
  browser behaviour.
- Agent responses and Markdown documents remain distinct presentation contexts.

## Experience Contract

- Markdown is the source of truth for editing and indexing.
- Preview should feel like a readable document, not a browser window or code
  editor.
- Editing should increasingly feel calm, typographic, and focused on document
  structure.
- Interactive editing presentation must remain a projection over Markdown:
  link navigation never writes source or becomes an undo step, and malformed
  or unsupported links remain ordinary source.
- Source-oriented Live Editing operations must not substitute rendered labels
  or convert clipboard HTML into Markdown. Find and selected-word occurrence
  highlighting share one source match model, reveal each intersected source
  construct, and keep the active result editable and visually distinct.
- Rich preview support must preserve the local preview trust boundary.
- Links, anchors, assets, find, and search-result navigation should preserve
  the reader's place and lead to the intended source context.

## Contribution Map

### Next

- Make editing more writer-first: reduce code-editor cues and improve headings,
  links, and image insertion.
- Improve preview fidelity and narrow-window behaviour for tables, long inline
  content, tasks, and large documents.
- Improve continuity between editor, preview, anchors, find, and search
  navigation.
- Evaluate offline-friendly math or diagrams only when they preserve safety and
  performance.

### Coordinate First

- Parser, sanitization, preview-trust-boundary, or local-asset behaviour.
- Link handling, anchor identity, preview navigation, or file-drop behaviour.
- Features that add executable content, remote resource loading, or otherwise
  change the security model.

### Not Planned

- Replacing Markdown with a proprietary document format.
- Treating generated HTML as a user-managed source file.
- Turning preview into an unrestricted browser or script host.

Markdown belongs inside the [Local File Workspace](library.md); preparation and
retrieval contracts are described in [Architecture](../architecture.md).
