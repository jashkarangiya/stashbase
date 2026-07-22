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
  fences and language label concealed; entering or selecting inside reveals
  them as one editable construct and leaving restores the block, all without
  changing source. The parser owns block boundaries, so backticks inside
  content and unterminated fences do not corrupt them, and the language label
  is only concealed markup — never parsed or executed.
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
- Rich preview support must preserve the local preview trust boundary.
- Links, anchors, assets, find, and search-result navigation should preserve
  the reader's place and lead to the intended source context.

## Contribution Map

### Next

- Make editing more writer-first: reduce code-editor cues and improve headings,
  lists, links, and image insertion.
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
