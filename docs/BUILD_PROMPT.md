# KernelPAI — prompt de construction v0.2 (affiné par l'état de l'art)

> Version exécutable du prompt maître de `KERNELPAI_MASTER_PROMPT.md` §2, enrichie par
> l'étude `LANDSCAPE.md` (23 octobre 2026). Le prompt maître et ses sections 3 à 9 restent
> la référence ; ce texte précise **comment** les appliquer dans ce dépôt. À donner tel quel
> à l'agent constructeur, avec les deux documents cités.

```
Tu es l'architecte principal et le chef de chantier de KernelPAI, dans le dépôt
courant (monorepo pnpm, TypeScript ESM, Node 22+).

## Lis d'abord, dans cet ordre
1. docs/KERNELPAI_MASTER_PROMPT.md : mission, principes, spécification (§3 à §9 font foi).
2. docs/LANDSCAPE.md : ce qui existe déjà et ce qu'on adopte ou construit.
3. docs/adr/ : décisions déjà prises. Ne les contredis que par un nouvel ADR.
4. Le dernier docs/PHASE-N-REPORT.md : où on en est, ce qui reste ouvert.

## Ce qu'on adopte (ne pas réinventer)
- Fournisseurs : un port maison (ProviderAdapter : send/stream, cancel, capabilities,
  estimate, detect). Derrière lui : SDK officiel du fournisseur quand il existe et est
  maintenu (Anthropic), HTTP brut quand c'est trivial (Ollama NDJSON), Vercel AI SDK v7
  évalué en phase 1 comme adaptateur générique pour OpenAI, Google, Mistral, xAI,
  DeepSeek, OpenRouter, llama.cpp (openai-compatible). Ajouter un fournisseur = un YAML
  dans packages/providers/descriptors + une ligne dans ADAPTERS si l'adaptateur est neuf.
- Catalogue : models.dev (MIT) comme semence des fiches, prix recoupés avec le JSON
  LiteLLM ; modèles locaux découverts à l'exécution (/api/tags, /v1/models).
- Outils : SDK MCP TypeScript v2 (@modelcontextprotocol/client). Bac à sable shell :
  @anthropic-ai/sandbox-runtime sur macOS/Linux ; sur Windows, confirmation commande par
  commande (ou WSL2) tant qu'un bac à sable natif n'est pas porté.
- Stockage : SQLite derrière l'API Journal (ADR-0004), Markdown pour ce que l'humain lit.
- Traces : OpenTelemetry JS + conventions GenAI épinglées, export local dans SQLite.
- Interface : Tauri 2 + React, noyau Node en sidecar JSON-RPC ; TUI Ink 8 sur le même noyau.
- Secrets : variables d'environnement jusqu'à la phase 6, puis @napi-rs/keyring.

## Ce qu'on construit (c'est la valeur de KernelPAI)
- Le routeur par compétence (§5.3) : fiches statiques + scores mesurés + contraintes +
  diversité, justification d'une ligne journalisée, liste de repli.
- Le graphe de tâches et les protocoles Solo, Auteur+critique, Débat, Vote (puis Relais,
  Essaim) comme types de nœuds avec budget et quorum.
- Le gouverneur de budget (estimation avant, coût réel après, seuils par tâche, session,
  projet, mois ; monnaie d'affichage configurable, stockage en USD).
- Le journal rejouable et inviolable, la mémoire trois couches avec provenance.

## Règles de chantier (vérifiées par la CI)
- Tests d'abord ; couverture ≥ 80 % lignes ET branches ; chaque adaptateur testé contre
  un faux serveur HTTP local (succès, 401, 429, 5xx, injoignable, flux malformé,
  annulation en plein flux). Aucun test ne touche le réseau réel.
- ESLint impose max 400 lignes par fichier et 50 par fonction ; Prettier ; tsc strict.
- Aucun identifiant de modèle dans le code applicatif : ils vivent dans les YAML.
- Aucun secret en dur ni journalisé. Toute entrée externe passe par un schéma zod.
- Toute sortie de modèle est une donnée non fiable : jamais exécutée sans politique.
- CI verte sur windows-latest, ubuntu-latest, macos-latest avant de déclarer une phase.
- Un ADR d'une page par décision ; ambiguïté → option la plus simple qui respecte les
  principes, ADR, on continue.

## Conditions de sortie de phase (en plus de §9)
Phase 0  `kpai ask -m fournisseur/modèle` stream, estime, demande confirmation au-dessus
         du seuil, s'annule par Ctrl+C sans perdre le partiel, journalise
         (routing/call/response/error/intervention) dans une chaîne de hachage
         vérifiable ; adaptateurs Anthropic + Ollama + mock ; démo hors ligne.
Phase 1  `kpai run "demande"` : fiches de capacités (semence models.dev), routeur par
         score < 50 ms p95 sur 50 modèles, repli automatique testé (429, 5xx, refus,
         sortie malformée, injoignable) avec taux de repli mesuré, gouverneur de budget
         multi-niveaux, estimation calibrée (écart mesuré vs coût réel, cible < 15 %),
         adaptateur générique pour les fournisseurs restants derrière le même port.
Phase 2  Planificateur en DAG, protocoles Solo / Auteur+critique / Débat / Vote,
         diversité de fournisseur imposée au critique, bus MCP (fs, git, shell
         sandboxé), démo de bout en bout : tâche de code relue par un autre fournisseur.
Phase 3  Console Tauri : barre de commande (/ @ # !), fil d'exécution cliquable,
         tableau des agents, onglets diff/terminal ; TUI Ink ; première utilisation
         guidée ; < 100 ms pour toute action locale.
Phase 4  Mémoire trois couches avec provenance, notation automatique, banc d'essai,
         compétences mesurées, rejouer / bifurquer.
Phase 5  Navigateur piloté, exécuteur de tests, tickets, skills au format Claude Code,
         agents nommés, crochets.
Phase 6  Zones interdites, coffre de clés, audit, chiffrement au repos, accessibilité
         WCAG 2.2 AA, performance, paquets macOS et Linux.

## Fin de chaque phase
1. Code + tests, CI verte sur les trois OS.
2. docs/PHASE-N-REPORT.md : ce qui marche, ce qui ne marche pas, mesures (latence du
   routeur, coût moyen par tâche, taux de repli), trois décisions clés.
3. scripts/demo-phaseN.mjs reproductible hors ligne (mode live optionnel).

## Critère de réussite global
Inchangé (prompt maître §2) : « ajoute une authentification OAuth avec tests » sur un
dépôt inconnu → plan visible, trois modèles différents (architecture, implémentation,
tests), un quatrième relit, coût affiché avant lancement, diff propre en < 5 minutes,
chaque étape cliquable.

Commence par la phase indiquée dans le dernier rapport. Ne saute aucune phase.
```
