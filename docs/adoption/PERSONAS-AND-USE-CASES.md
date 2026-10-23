# KP Studio — personas and use-case coverage

Owner: S9. Date: 2026-10-23. Companion to `ADOPTION-AUDIT.md`. Fit is judged against a clean
build of HEAD `bc81a7f` as a first-time user; "with packs" is the fit once `@kernelpai/packs`
is wired in through the work items (`WORK-ITEMS.md`). Fit key: ✓ good · ◐ partial · ✗ blocked.

The matrix includes a column **"non-code outputs"** (models, maps, configs, documents,
assets) per the Sponsor's scope extension: ✓ = that output is a first-class artifact; ◐ =
possible as text only; ✗ = not expressible. Today every profile is ✗/◐ here because of F3
(code-patch-only output); "with packs" declares the deliverable, and WI-S1-02/S4-01/S6-01
make it a real artifact.

## Coverage matrix

| #   | Profile                          | Inputs (beyond repo)                  | Tools / MCP they expect                | Task types / protocols                         | Local/cloud              | Safety & scope                         | Outputs                           | Non-code outputs   | Success metric                                     | Fit today | With packs                  |
| --- | -------------------------------- | ------------------------------------- | -------------------------------------- | ---------------------------------------------- | ------------------------ | -------------------------------------- | --------------------------------- | ------------------ | -------------------------------------------------- | --------- | --------------------------- |
| 1   | Software engineer (be/fe/mobile) | repo                                  | GitHub MCP, Playwright, fs/git/shell   | design→impl→test→review; author+critic         | both                     | zones; critic diversity                | patch + tests                     | n/a (code)         | clean reviewed diff, tests pass in <5 min          | ✓         | ✓                           |
| 2   | Legacy porting (COBOL, C→Rust)   | old source, build files               | GnuCOBOL, c2rust, Bear [U]             | inventory→strategy→golden→port→review          | both (local for IP)      | keep proprietary source local          | patch + equivalence tests         | ◐ inventory report | behaviour-equivalent port, golden tests pass       | ◐         | ✓                           |
| 3   | Reverse engineer / CTF           | binaries, firmware, pcaps             | Ghidra/IDA/radare2 MCP, Kaitai, tshark | triage→function analysis→report; author+critic | local preferred          | **authorised scope**; never run sample | findings report                   | ✓ report           | correct findings with addresses, in scope          | ✗         | ◐ (F5 binary input)         |
| 4   | Pentest / red team (authorised)  | scope, scan output                    | Burp MCP, Nmap (user-run)              | scope-check→analyse→report                     | local preferred          | **authorised scope**, expiry           | findings report + retest list     | ✓ report           | scoped, evidence-backed report                     | ✗         | ✓                           |
| 5   | Infosec / GRC (defensive)        | logs, rules, policies                 | Sigma, Semgrep MCP [U], Timesketch     | detection/incident/governance plans            | local for raw logs       | personal data; relax rule-name zones   | rules, timelines, policies        | ✓ rules/docs       | rule with test cases; sourced timeline             | ✗ (F2)    | ✓                           |
| 6   | Designer / UX                    | Figma, tokens, screenshots            | Figma MCP, axe, Storybook              | audit→proposal (design)                        | cloud ok (confidential?) | client confidentiality                 | annotated spec / design           | ✓ design spec      | spec using only known components; WCAG pass        | ✗         | ◐ (F5 images)               |
| 7   | Creative (writing/music/art)     | manuscript, score, sketches           | LilyPond                               | context→draft→revise; author+critic            | both                     | drafts stay private                    | prose, score, sketch code         | ✓ document         | draft keeps voice & continuity                     | ◐ (text)  | ✓                           |
| 8   | Data scientist / ML              | datasets (csv/parquet), notebooks     | Jupyter MCP, DVC, MLflow               | explore→experiment→report                      | local for PII            | personal data; sample not whole file   | notebook + metrics report         | ✓ notebook         | reproducible result, no leakage, uncertainty       | ✗         | ◐ (F5 data, F3 notebook)    |
| 9   | IoT / embedded                   | firmware, datasheets, serial          | PlatformIO, pyserial                   | design→impl→host-test                          | both                     | flashing confirmed; host test first    | firmware build + host tests       | ✓ build config     | builds; host tests pass before flashing            | ✗         | ✓                           |
| 10  | Automation / DevOps / SRE        | IaC, CI, runbooks                     | Terraform MCP, tflint                  | plan→change→runbook                            | both                     | blast radius; apply confirmed          | patch + runbook                   | ✓ runbook          | change + rollback runbook; no unbounded destroy    | ◐ (code)  | ✓                           |
| 11  | Researcher / analyst / writer    | sources, PDFs, bib                    | Zotero [U], Pandoc                     | gather→draft→claim-check                       | both                     | source confidentiality                 | sourced document                  | ✓ document         | every claim cited; nothing fabricated              | ◐ (text)  | ✓                           |
| 12  | Student / learner / non-dev      | notes, homework                       | none by default                        | explain→one-step                               | local ($0)               | nothing runs without asking            | explanation + next step           | ✓ explanation      | understands; one safe step done in <10 min         | ✗ (F1,F6) | ✓                           |
| 13  | Regulated / air-gapped team      | code/data that may not leave          | local models only                      | local-only work                                | **local only**           | no egress; zones immovable             | as per domain, local              | ✓ (domain)         | task done with zero egress                         | ◐         | ✓ (full needs R-602)        |
| 14  | Team lead / manager              | journal, repo history                 | none (read-only)                       | assess→decision record                         | cheap/local              | read-only                              | review + decision record          | ✓ report           | cost/risk summary from journal, no code touched    | ◐         | ✓                           |
| 15  | Game creation                    | Unity/Godot/Unreal, GDD, assets       | Godot, Aseprite                        | design-note→impl; GDD; balance review          | both                     | large assets are inputs                | code + GDD + asset specs          | ✓ GDD/spec         | mechanic fits engine; GDD states player experience | ✗         | ✓ (code) / ◐ (assets F5)    |
| 16  | 3D printing / CAD / maker        | OpenSCAD/CadQuery, STL/3MF, slicer    | OpenSCAD, CadQuery, PrusaSlicer        | spec→model; print-settings review              | both                     | firmware safety; meshes are inputs     | parametric model + print settings | ✓ model/config     | parametric, printable model; safe settings         | ✗         | ✓ (scripts) / ◐ (meshes F5) |
| 17  | Home AI / smart home             | HA YAML, ESPHome, flows               | Home Assistant, ESPHome                | design→automation→dry-run                      | **local preferred**      | **actuation confirmed; secrets local** | automation config + dry-run plan  | ✓ config           | automation works in simulation before real devices | ✗         | ✓                           |
| 18  | GIS / geospatial                 | GeoJSON/Shapefile/GeoPackage, rasters | GDAL/OGR, geopandas, QGIS              | inspect→analysis→map                           | local for personal       | **location = personal data**; zones    | analysis script + map             | ✓ map              | correct CRS/topology; personal data kept local     | ✗         | ◐ (F5 rasters)              |

Additional material profiles considered and folded in: **self-hoster / homelab** (served by
smart-home + regulated + devops packs), **accessibility specialist** (inside design-ux),
**open-ended / community domains** (agriculture, health research, legal, education, robotics,
audio-video, science labs, finance) — these are the point of the open pack mechanism and the
`general` fallback pack; each is one YAML file away, no code change (see `PACK-AUTHORING.md`).

## Per-profile: top-3 gaps and the "first 10 minutes" scenario that must work

Each scenario is the smallest real task that must succeed, offline-fakeable for tests.

1. **Software engineer.** Gaps: (a) no onboarding (F6); (b) images for UI review (F5);
   (c) one-provider users hit diversity wall (F-DEF-1). _First 10 min:_ open a Node repo, "add
   an input-validation helper with tests", see the plan+cost, get a reviewed diff, apply it.
2. **Legacy porting.** Gaps: (a) no `translation` type / port plan (F4); (b) output is a patch,
   inventory has no home (F3); (c) IP must stay local but no per-task residency yet (R-601).
   _First 10 min:_ point at a COBOL folder, get an inventory report of modules and data layouts.
3. **Reverse engineer / CTF.** Gaps: (a) workspace guard refuses a lone binary (F1); (b) no
   scope concept (F8); (c) models can't see bytes, only text (F5). _First 10 min:_ opt in a
   `crackme.elf` folder, declare the CTF scope, get a triage report (format, imports, strings).
4. **Pentest.** Gaps: (a) no scope/expiry (F8); (b) no `security_assessment` type (F4); (c)
   loot must never egress — needs the zone add (F2). _First 10 min:_ declare a host scope, feed
   an Nmap XML, get a scoped analysis with severities.
5. **Infosec / GRC.** Gaps: (a) `*secret*`/`credentials*` block rule & policy files (F2); (b)
   no detection/incident plan (F4); (c) raw logs should prefer local (R-601). _First 10 min:_
   in a `detections/` folder (zone relaxed, approved), "write a Sigma rule for lsass access"
   with true/false-positive cases.
6. **Designer / UX.** Gaps: (a) can't ingest Figma/images (F5); (b) output is a patch, not a
   design spec (F3); (c) no `design` type (F4). _First 10 min:_ share a Figma frame via MCP,
   get an accessibility + token-conformance audit as a spec.
7. **Creative.** Gaps: (a) no continuity memory across chapters until phase 4; (b) output is
   text-only, fine, but no document artifact/versioning (F3); (c) jargon (F-JARG-1). _First 10
   min:_ point at a `chapters/` folder, "draft chapter 3 in the same voice", get an editor's
   critique and a revision.
8. **Data scientist.** Gaps: (a) guard refuses a data folder (F1); (b) can't attach a dataset,
   models reason over samples only (F5); (c) notebook output not first-class (F3). _First 10
   min:_ open a folder with a CSV, "explore this dataset and propose a baseline", get an EDA
   report and baseline cells.
9. **IoT / embedded.** Gaps: (a) guard refuses a `platformio.ini`-only folder until marker
   added (F1); (b) flashing not modelled as physical/confirmed+dry-run (F-SAFE-1); (c) no
   serial tool. _First 10 min:_ open a PlatformIO project, "add a debounce to the button ISR",
   get a diff + host test, flashing left to the user.
10. **DevOps / SRE.** Gaps: (a) runbook output is text, not an artifact (F3); (b) apply/destroy
    not distinguished from generic shell (F-SAFE-1); (c) no `.tf` marker until pack (F1).
    _First 10 min:_ open a Terraform module, "add lifecycle prevent_destroy and a runbook",
    get the diff plus an apply/rollback runbook.
11. **Researcher / writer.** Gaps: (a) no web/source tool by default; (b) document not a
    first-class artifact (F3); (c) citations can't be auto-verified without a tool. _First 10
    min:_ point at a `sources/` folder, "write a 1-page brief citing these", get a draft and a
    claim-check pass.
12. **Student / non-dev.** Gaps: (a) guard + no onboarding (F1, F6); (b) jargon (F-JARG-1);
    (c) cost fear without the $0 path surfaced (F-COST-2). _First 10 min:_ "explain what this
    folder is and suggest one thing I could try", in plain language, $0 on a local model.
13. **Regulated / air-gapped.** Gaps: (a) no one-switch air-gap yet (R-602, phase 6); (b)
    per-task residency (R-601); (c) must be sure zones never relax for keys (holds — F2 fix
    keeps credentials immovable). _First 10 min:_ with `--local-only`, run a task end to end and
    confirm the journal shows zero egress.
14. **Team lead.** Gaps: (a) read-only review plan not built (F4); (b) verification-ROI view is
    phase 4 (R-404); (c) free viewer seats are a pricing decision (Q-6). _First 10 min:_ point
    at a finished run, get a one-page decision record with cost and risk from the journal.
15. **Game creation.** Gaps: (a) guard refuses `project.godot`/`Assets/` folders (F1); (b) no
    `game_design` type / GDD plan (F4); (c) binary art/audio can't be inputs (F5). _First 10
    min:_ open a Godot project, "add a double-jump mechanic", get a design note + GDScript diff.
16. **CAD / 3D printing.** Gaps: (a) guard refuses `.scad`/STL folders (F1); (b) output is a
    model/config, not a patch (F3); (c) STL/3MF meshes are binary inputs (F5). _First 10 min:_
    open an OpenSCAD folder, "make a parametric bracket 40 mm wide", get a parametric script.
17. **Smart home.** Gaps: (a) actuation must be simulated/confirmed first (F-SAFE-1); (b)
    secrets.yaml must be a zone (handled by pack add); (c) config output not first-class (F3).
    _First 10 min:_ open a Home Assistant config, "turn on the porch light at sunset", get the
    automation YAML plus a dry-run checklist before it controls a device.
18. **GIS.** Gaps: (a) guard refuses `.gpkg`/`.geojson` folders (F1); (b) rasters are large
    binary inputs (F5); (c) map output not first-class (F3). _First 10 min:_ open a folder with
    a GeoJSON, "buffer these points by 500 m and summarise", get a geopandas script stating the
    CRS and a described map.

## How the packs move the needle

The 18 built-in domain packs plus `general` (see `packages/packs/packs`) clear F1 (markers),
F2 (zone relaxations for the two profiles that need them), F4 (plan hints + proposed types),
F7 (the mechanism itself) and F8 (authorised scope) as **data**. They declare the non-code
`deliverable` for every profile, so once WI-S1-02/S4-01/S6-01 land, the "non-code outputs"
column turns ✓ across the board. The remaining ✗/◐ are F5 (multimodal input — S2/S1) and the
phase-6 residency/air-gap items, which are engineering, not data.
