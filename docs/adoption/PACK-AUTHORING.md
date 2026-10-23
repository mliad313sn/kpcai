# Writing a KP Studio domain pack

Owner: S9. A **domain pack** teaches KP Studio about a kind of work — yours — without any code
change. It is one YAML file. If your domain is not in the built-in set (agriculture, health
research, legal, education, robotics, audio/video, a science lab, finance, anything), write a
pack and drop it in; KP Studio picks it up.

A pack is **data**. It never contains a model name, a price or a token limit — the router picks
models, and those live in the provider descriptors. A pack talks about _capabilities_, _task
types_, _markers_, _tools_ and _safety_.

## Where packs live (merge order)

KP Studio loads packs from three places, later overriding earlier by `id`:

1. **Built-in** — shipped with KP Studio (`packages/packs/packs`).
2. **`$KPAI_HOME/packs/`** — your personal packs (default `~/.kernelpai/packs`).
3. **`<repo>/.kpstudio/packs/`** — packs checked into a project, shared with the team.

A later layer can refine an earlier pack, but it can only **tighten** safety: it can add a
scope requirement, a forbidden zone, `preferLocal`, `physicalEffects` or `personalData`, never
remove one. A repository pack can therefore never switch off a safety rule a built-in pack set.

Files must be real files (no symlinks), at most 64 KB, with the extension `.yaml` or `.yml`.

## Validate as you go

```
node packages/packs/dist/bin.js path/to/your-pack.yaml     # or: kpai pack check <file> (when A-015 ships)
```

The validator prints `ok:` with a summary, or the errors with a `hint:` line telling you what
to fix (a misspelt field, a model id that slipped in, an over-broad zone relaxation, a task
type that is not one of the core types).

## Minimal pack

```yaml
id: my-domain # lower-case, dashes; this is the file-name-like key
name: My domain # short, human
description: What this profile does, in one or two plain sentences.
profiles: [the people who do this work]
```

That already works: it will show up and the generic plan applies. Add the parts you need.

## The fields

### markers — make your folders count as workspaces

The workspace guard refuses folders with no recognised project marker. Add yours:

```yaml
markers:
  - { glob: '*.ipynb', why: Jupyter notebook }
  - { glob: platformio.ini, why: PlatformIO project }
  - { glob: '*.bin', optIn: true, why: A raw binary — ambiguous, so opt-in }
```

- A glob without `/` matches a file at any depth; `x/**` matches the folder `x` and anything
  under it.
- `optIn: true` means "this file alone should not silently make a folder a workspace" (a lone
  `.bin` also looks like a downloads folder). KP asks before accepting it.
- `weak: true` is for generic files many folders have (a README, any `*.md`). They still accept
  a workspace, but count a quarter of a normal marker when packs are ranked, so they never
  outrank the files that really say what the folder is for.

### plans — a node sequence that fits the work

When a request contains one of `when:`, KP uses this sequence instead of the generic code
template. Nodes map onto the **existing** core task types.

```yaml
plans:
  - id: explore-experiment-report
    title: Explore, experiment, report
    when: [dataset, explore, train, baseline, evaluate]
    nodes:
      - {
          id: explore,
          title: Explore,
          type: analysis,
          protocol: solo,
          tools: [fs.list, fs.read],
          deliverable: report,
        }
      - {
          id: experiment,
          title: Experiment,
          type: code_generation,
          protocol: author_critic,
          dependsOn: [explore],
          deliverable: notebook,
        }
      - {
          id: report,
          title: Report,
          type: writing,
          protocol: author_critic,
          dependsOn: [experiment],
          deliverable: report,
        }
```

- `type` is one of the core task types: `analysis`, `code_generation`, `writing`, `research`,
  `test`, `critique`, `decision`. If your work needs a new one, see `proposedTaskTypes`.
- `protocol` is `solo`, `author_critic`, `debate` or `vote`.
- `deliverable` says what the node hands back: `answer`, `report`, `patch`, `notebook`,
  `design`, `build`, `model3d`, `map`, `config`, `asset`. Only `patch` is written to disk as a
  diff today; the others are shown and saved once the deliverable work items land. Choosing the
  right one means your users do **not** get a code diff when they wanted a report or a map.
- `dependsOn` wires the graph; it must be acyclic and reference ids in the same plan.

### proposedTaskTypes — ask for a new task type

Packs never edit `packages/core`. If your work is a genuinely new kind, propose it; until it is
added, `mapsTo` says which existing type to use meanwhile.

```yaml
proposedTaskTypes:
  - { id: geospatial_analysis, description: Analyse and visualise spatial data, mapsTo: analysis }
```

### reviewCriteria — what the cross-provider critic should check

```yaml
reviewCriteria:
  - Coordinate reference systems are explicit; no silent reprojection.
  - Personal location data is kept local, not sent to cloud models raw.
```

### tools — suggestions, never auto-installed

```yaml
tools:
  - {
      name: GDAL/OGR,
      kind: cli,
      purpose: 'Read, convert and warp spatial data',
      url: 'https://gdal.org',
      verified: false,
    }
```

`kind` is `mcp`, `cli`, `app` or `library`. Set `verified: true` only if you checked the tool
against a primary source; otherwise leave it `false` and it is shown with `[U]`. KP Studio
**suggests** these; it never installs anything on its own.

### zones — forbidden-zone additions and relaxations

```yaml
zones:
  add: ['loot/**', 'secrets.yaml'] # always forbidden for this profile
  relax:
    - { allow: 'detections/**', reason: 'Rule names like aws_secret_access.yml hold no secret.' }
```

- `add` always applies.
- `relax` exempts a **named folder** from the two name-heuristic zones (`*secret*`,
  `credentials*`) only. It is shown to the user and needs their approval; it is refused if it is
  too broad or would touch any credential file. You can **never** relax the credential zones
  (`.env`, `*.pem`, `*.key` material, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.netrc`). The
  validator refuses an unsafe relaxation.

### safety — scope, locality, physical effects

```yaml
safety:
  requiresScope: true # the user must declare an authorised scope before any node runs
  scopeKinds: [host, network] # kinds of target this work touches
  preferLocal: true # route sensitive inputs to local models
  physicalEffects: true # plans get a dry-run node; actuating steps are confirmed
  personalData: true # inputs may be personal data; keep them local
  limits:
    - Only targets in the signed scope, until its expiry.
    - KP Studio plans and documents; it does not launch scans on its own.
```

If `requiresScope` is true, the user supplies an **authorised scope** (targets, engagement
reference, `authorisedBy`, `expires`); KP validates it (bounded, unexpired, in-kind), shows it
in the plan, and journals it. This is for authorised, defensive, research, CTF and
interoperability work. **Never** write a pack to evade detection or attack third parties — such
packs are out of scope for KP Studio.

### glossary and tips — the first run

```yaml
glossary:
  - { term: CRS, meaning: 'Coordinate reference system: how coordinates map to the Earth.' }
tips:
  - Point KP at the headers of a big raster first; it reads samples, not the whole file.
```

## Detection

`detectPacks(root, packs)` suggests packs from the file names present (it opens no file, never
follows a symlink out of the root, and is bounded in depth and count). Good markers make your
pack suggest itself. If nothing matches, the `general` pack gives a safe understand→propose
first run — so a brand-new domain still works before anyone writes a pack for it.

## Checklist before you share a pack

- `node packages/packs/dist/bin.js your-pack.yaml` prints `ok:`.
- No model name, price or token count anywhere (the validator catches these).
- Markers match real files in a real project of yours; ambiguous ones are `optIn`.
- Each plan node's `deliverable` is what the user actually wants back.
- Any zone relaxation names a specific folder and never a credential.
- Security work sets `requiresScope` with the right `scopeKinds` and honest `limits`.

That is the whole mechanism. A new domain is one file; no code change, ever.
