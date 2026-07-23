# Preparation

Preparation makes hard-to-read local formats useful as Agent context while
preserving the original file as the user's visible object.

## Current

- Markdown is directly readable and indexable from its source.
- HTML remains visible as source content while its text can support retrieval.
- PDFs retain native preview and gain derived text for Agent reading and search.
- DOCX retains a readable source-based preview and gains derived retrieval text.
- Images remain visible while OCR can supply searchable text.
- Audio files and supported video containers can produce searchable,
  timestamped transcripts; video transcription extracts the audio track and
  does not make StashBase a video editor.
- Preparation runs in the background, prioritizes direct interaction, and can
  be retried when a recoverable failure needs user attention.

## Experience Contract

- Preparation improves a file; it must not make the source disappear or become
  unusable.
- Missing optional capability or incomplete background work must not block
  ordinary browsing.
- The UI distinguishes preparing, ready, unavailable, failed, and retryable
  states when that changes the user's next action.
- Derived output is valid only when it corresponds to the current source.
- Conversion completion and semantic indexing completion are different states.

## Contribution Map

### Next

- Make preparation progress, partial readiness, and recovery understandable.
- Improve diagnostics and repair paths for failed conversion.
- Improve format-specific fallback experiences without weakening source-file
  identity.
- Extend support where a new format materially improves local context.

### Coordinate First

- Derived-data ownership, cleanup, reconciliation, or retry semantics.
- New native tools, long-running work, or resource-intensive extractors.
- Changes that make visible preview depend on background conversion.

### Not Planned

- Asking users to manage generated text, checkpoints, or index artifacts.
- Replacing the source file with a converted file.
- Treating generated-artifact existence alone as proof it is current.

See [Architecture](../architecture.md) for lifecycle and ownership contracts,
and [Search and Retrieval](search.md) for how prepared text is used.
