# References And Attribution

Slides from Anything integrates and adapts ideas from related slide, design, and
local-runtime projects. This file records project lineage and what is reused.

## OpenPPT

OpenPPT provides the slide authoring/runtime direction for SFA: project
workspace, deck generation, preview workbench, export expectations, and local
daemon integration.

## Design Vault

Design Vault provides reusable visual systems and template evidence. In this
repository it runs as an embedded application and writes runtime templates to an
ignored data directory.

## Open Slide

Open Slide provides the canonical deck authoring contract and workbench model
used by OpenPPT-style slide workflows.

## guizang-ppt-skill

The Guizang-style deck skill influences the magazine/web-PPT workflow and the
quality checklist culture for deck generation. Preserve upstream licenses and
authorship where files are vendored.

## html-ppt-skill

The HTML PPT skill family provides deck templates and presenter/runtime patterns.
Preserve upstream licenses and authorship where files are vendored.

## Local Agent Tooling

The repository keeps a local daemon and sidecar-based lifecycle so the web UI,
desktop shell, and packaged runtimes can share the same status, logs, and
process management model.

## Release Boundary

Do not use reference projects as an excuse to import personal template data,
private downloaded assets, credentials, or generated local projects into this
repository.
