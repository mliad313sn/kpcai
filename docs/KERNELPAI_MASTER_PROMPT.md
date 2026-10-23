# KernelPAI — Prompt maître et spécification fondatrice

> Document de conception v0.1 — 23 octobre 2026
> Objet : le prompt qui pilote la construction de KernelPAI, une console de développement multi-IA, plus la spécification des fonctionnalités, de l'ergonomie et de l'architecture qui l'entourent.

---

## 0. Comment utiliser ce document

Ce fichier contient trois choses, dans cet ordre :

1. **La thèse produit** (section 1) : ce que KernelPAI est, ce qu'il n'est pas, et pourquoi il n'existe pas encore.
2. **Le prompt maître** (section 2) : le texte à donner à l'IA (ou à l'équipe d'IA) chargée de construire KernelPAI. Il est autonome et peut être copié tel quel.
3. **La spécification détaillée** (sections 3 à 9) : fonctionnalités, ergonomie, architecture du routage, sécurité, feuille de route. Le prompt maître y renvoie.

Règle d'usage : on lance la construction en donnant à l'agent constructeur le prompt maître **et** ce fichier entier en pièce jointe. Le prompt dit quoi faire, la spécification dit comment juger que c'est fait.

---

## 1. Thèse produit

### 1.1 Le problème

Les consoles IA actuelles (Claude Code, Codex CLI, Gemini CLI, Cursor, Aider, OpenClaw et consorts) partagent trois limites :

- **Monomodèle par défaut.** Chacune est un client pour un fournisseur. Les routeurs existants (OpenRouter, LiteLLM) font du routage *d'API*, pas du routage *de compétence* : ils choisissent où envoyer un appel, pas qui est le meilleur pour cette sous-tâche précise.
- **Orchestration cachée ou absente.** Quand plusieurs agents collaborent, l'utilisateur ne voit ni qui fait quoi, ni pourquoi, ni combien ça coûte. Il ne peut pas intervenir au milieu.
- **Outils dispersés.** Terminal, éditeur, navigateur, tests, docs, tickets, déploiement sont dans des fenêtres différentes. L'IA doit « sauter » entre eux, et l'humain aussi.

### 1.2 La proposition

KernelPAI est un **noyau d'orchestration** (d'où le nom : kernel) qui traite les IA comme un système d'exploitation traite les processus et les périphériques :

- Chaque modèle d'IA est un **périphérique de calcul** décrit par une fiche de capacités (forces, faiblesses, coût, latence, contexte, modalités, juridiction des données).
- Chaque demande de l'utilisateur est décomposée en un **graphe de tâches**, et chaque nœud est routé vers le meilleur périphérique disponible, avec repli automatique.
- Les modèles **se vérifient mutuellement** : rédaction par l'un, critique par l'autre, arbitrage par un troisième si désaccord. La qualité émerge de la diversité, pas d'un seul modèle « génial ».
- Toute la chaîne est **visible, rejouable et interruptible** par l'humain, dans une seule console.

### 1.3 Ce qui n'existe pas encore (et que KernelPAI apporte)

| Capacité | Marché actuel | KernelPAI |
|---|---|---|
| Choix du modèle | Manuel, ou par coût/latence | Par compétence mesurée sur la sous-tâche, avec apprentissage continu |
| Collaboration inter-modèles | Chaînes fixes codées par le développeur | Graphe dynamique négocié par un orchestrateur, visible en direct |
| Vérification | Un modèle se relit lui-même | Débat contradictoire entre modèles d'origines différentes, arbitrage |
| Mémoire | Par session ou par projet, un seul fournisseur | Mémoire unifiée, portable entre modèles, avec provenance |
| Outils | Plugins par console | Bus d'outils universel (MCP natif) partagé par tous les modèles |
| Coût | Facture en fin de mois | Budget par tâche, prévisionnel avant exécution, réel après |
| Local / cloud | L'un ou l'autre | Mixte transparent : les modèles locaux sont des périphériques comme les autres |

### 1.4 Ce que KernelPAI n'est pas

- Pas un nouveau modèle d'IA. KernelPAI n'entraîne rien, il orchestre.
- Pas un simple proxy d'API. Le routage se fait au niveau de la tâche, pas de la requête HTTP.
- Pas un IDE complet. Il s'intègre à l'éditeur de l'utilisateur et fournit les panneaux qui manquent, il ne remplace pas VS Code.

---

## 2. Prompt maître

> À copier intégralement. Les crochets `[ ]` indiquent des points à renseigner avant lancement.
> Version affinée et appliquée à ce dépôt : `docs/BUILD_PROMPT.md`.

```
Tu es l'architecte principal et le chef de chantier de KernelPAI.

## Mission

Construire KernelPAI : une console de développement locale, multi-IA, qui
décompose chaque demande en un graphe de tâches, route chaque tâche vers le
modèle d'IA le plus compétent parmi tous ceux disponibles (cloud et locaux),
fait collaborer et se vérifier les modèles entre eux, et montre toute la
chaîne à l'utilisateur dans une interface unique, lisible et interruptible.

Le résultat doit être utilisable quotidiennement par un développeur seul dès
la première version livrée, puis évoluer vers un produit d'équipe.

## Contexte de départ

- Dossier de travail : [chemin du projet], vide au départ.
- Plateforme cible initiale : Windows 11, puis macOS et Linux.
- Spécification de référence : le fichier KERNELPAI_MASTER_PROMPT.md joint.
  Ses sections 3 à 9 font autorité pour les fonctionnalités, l'ergonomie,
  le routage, la sécurité et l'ordre de livraison.
- Fournisseurs à supporter dès la v1 : Anthropic, OpenAI, Google, Mistral,
  xAI, DeepSeek, Ollama (local), llama.cpp (local), OpenRouter (agrégateur).
  L'ajout d'un fournisseur ne doit jamais demander plus qu'un fichier de
  description et une classe d'adaptateur.

## Principes non négociables

1. Routage par compétence, pas par fournisseur. Aucune tâche n'est envoyée à
   un modèle « parce que c'est le défaut ». Chaque décision de routage est
   justifiée en une ligne, loggée et consultable.
2. Diversité obligatoire pour la vérification. Un livrable critique (code
   fusionné, commande destructive, texte publié) est relu par un modèle d'un
   fournisseur différent de celui qui l'a produit.
3. Transparence totale. L'utilisateur voit en permanence : qui travaille,
   sur quoi, depuis combien de temps, pour quel coût, avec quelle confiance.
4. Interruptibilité. Toute tâche peut être mise en pause, redirigée vers un
   autre modèle, ou annulée, sans perdre le travail déjà fait.
5. Local d'abord pour les données. Code, mémoire, journaux restent sur la
   machine. Seuls les extraits strictement nécessaires partent vers un
   fournisseur, et l'utilisateur peut imposer des zones « jamais envoyées ».
6. Budget avant exécution. Toute tâche estimée au-dessus du seuil configuré
   demande confirmation avec l'estimation affichée.
7. Un seul endroit pour tout. Terminal, fichiers, diff, navigateur, tests,
   tickets, tableau des agents : dans la console, jamais dans une fenêtre
   externe que l'utilisateur doit aller chercher.

## Méthode de travail imposée

- Travaille par phases livrables (voir section 9 de la spécification).
  Chaque phase se termine par une démo exécutable et un rapport.
- Avant d'écrire du code neuf, cherche l'existant (dépôts publics, paquets,
  protocoles comme MCP) et préfère adapter plutôt que réinventer.
- Tests d'abord. Couverture minimale 80 %. Les tests de routage incluent
  des scénarios de panne de fournisseur et de dépassement de budget.
- Fichiers courts (200 à 400 lignes), fonctions courtes (moins de 50 lignes),
  pas de secret en dur, validation de toute entrée externe.
- À chaque décision d'architecture, écris un ADR (Architecture Decision
  Record) d'une page dans docs/adr/.
- Quand une exigence de la spécification est ambiguë, choisis l'option la
  plus simple qui respecte les principes non négociables, note le choix dans
  un ADR, et continue. Ne bloque que si le choix est irréversible et coûteux.

## Pile technique recommandée (modifiable par ADR)

- Noyau et routeur : TypeScript sur Node 22+, ou Rust si la latence du
  routeur devient mesurablement limitante.
- Interface : application de bureau (Tauri) avec rendu web (React), plus un
  mode terminal pur (TUI) partageant le même noyau via IPC local.
- Protocole d'outils : MCP (Model Context Protocol) comme bus universel.
- Stockage local : SQLite pour journaux, mémoire, fiches de capacités ;
  fichiers Markdown pour ce que l'utilisateur doit pouvoir lire et éditer.
- Observabilité : OpenTelemetry pour les traces, exportable mais local par
  défaut.

## Livrable attendu à la fin de chaque phase

1. Code et tests dans le dépôt, CI verte.
2. Un fichier docs/PHASE-N-REPORT.md : ce qui marche, ce qui ne marche pas,
   mesures (latence du routeur, coût moyen par tâche, taux de repli), et
   les trois décisions les plus importantes prises.
3. Une vidéo ou un script de démo reproductible.

## Critère de réussite global

Un développeur ouvre KernelPAI sur un dépôt inconnu, demande « ajoute une
authentification OAuth avec tests », et voit : le plan se dessiner, trois
modèles différents prendre chacun une partie (architecture, implémentation,
tests), un quatrième relire, le coût afficher 0,40 € avant lancement, et un
diff propre arriver en moins de cinq minutes, chaque étape étant cliquable
pour voir qui a fait quoi et pourquoi.

Commence par la phase 0 décrite en section 9. Ne saute aucune phase.
```

---

## 3. Fonctionnalités

### 3.1 Noyau d'orchestration (le « kernel »)

**Décomposition.** Toute demande entre par un planificateur qui produit un graphe de tâches orienté acyclique. Chaque nœud porte : type de tâche (analyse, génération de code, rédaction, recherche, test, critique, décision), entrées, sorties attendues, criticité, budget alloué.

**Routeur de compétences.** Pour chaque nœud, le routeur calcule un score par modèle disponible à partir de :

- la fiche de capacités statique du modèle (déclarée par le fournisseur ou la communauté) ;
- les scores dynamiques mesurés sur ce projet (taux d'acceptation des diffs, échecs de tests, retours de la critique) ;
- les contraintes de l'utilisateur (budget, latence maximale, juridiction, modèles interdits pour ce dossier) ;
- la diversité requise (le critique ne peut pas venir du même fournisseur que l'auteur).

Le routeur rend une décision expliquée en une phrase, conservée dans le journal.

**Repli.** Chaque nœud a une liste ordonnée de modèles de repli. Panne, limite de débit, refus, ou sortie malformée déclenchent le repli sans intervention humaine, avec notification discrète.

**Protocoles de collaboration** (sélectionnables par tâche ou par défaut de projet) :

| Protocole | Usage | Fonctionnement |
|---|---|---|
| Solo | Tâches triviales | Un modèle, pas de relecture |
| Auteur + critique | Code courant | Un modèle produit, un autre relit, l'auteur corrige |
| Débat | Décisions d'architecture | Deux modèles argumentent, un troisième tranche |
| Vote | Classification, choix fermés | N modèles répondent, majorité pondérée par compétence |
| Relais | Longs documents | Chaque modèle traite une section et passe le contexte au suivant |
| Essaim | Exploration de code | Plusieurs instances parcourent en parallèle, fusion des trouvailles |

**Mémoire unifiée.** Trois couches : mémoire de session (contexte courant), mémoire de projet (conventions, décisions, erreurs passées), mémoire utilisateur (préférences, style). Chaque fait porte sa provenance (quel modèle, quelle date, quelle preuve). La mémoire est lisible et éditable en Markdown par l'utilisateur. Elle est injectée dans n'importe quel modèle, ce qui rend le changement de fournisseur indolore.

### 3.2 Catalogue de périphériques IA

- **Fiche de capacités** par modèle : modalités (texte, image, audio, vidéo, code), fenêtre de contexte, coût entrée/sortie, latence typique, forces et faiblesses déclarées, juridiction d'hébergement, politique de rétention.
- **Détection automatique** des modèles locaux (Ollama, llama.cpp, LM Studio) et des clés présentes dans l'environnement.
- **Banc d'essai intégré** : l'utilisateur peut lancer un jeu de tâches de référence sur son propre code pour recalibrer les scores de compétence.
- **Ajout d'un fournisseur** : un fichier YAML de description plus un adaptateur implémentant une interface unique (envoi, flux, outils, annulation).

### 3.3 Bus d'outils universel

- MCP natif : tout serveur MCP branché devient disponible pour tous les modèles, avec une politique de permission par outil et par modèle.
- Outils fournis d'origine : système de fichiers, terminal sandboxé, git, navigateur piloté, exécuteur de tests, recherche web, lecteur de documentation, gestion de tickets (GitHub, GitLab, Jira, Linear).
- **Permissions graduées** : lecture libre, écriture confirmée par lot, commandes destructives confirmées une à une, avec option « faire confiance pour cette session sur ce dossier ».

### 3.4 Gouvernance des coûts

- Estimation avant exécution, affichée dans le plan.
- Budget par tâche, par session, par projet, par mois. Dépassement bloque et propose : réduire le périmètre, passer sur des modèles moins chers, ou continuer.
- Tableau des coûts par modèle, par type de tâche, par projet, avec export.
- Mode « économe » qui privilégie les modèles locaux et réserve le cloud à la critique finale.

### 3.5 Journal et rejouabilité

- Chaque session est un journal structuré : plan, décisions de routage, appels, sorties, coûts, interventions humaines.
- **Rejouer** une session avec un autre modèle sur un nœud donné, pour comparer.
- **Bifurquer** depuis n'importe quel nœud.
- Export du journal en Markdown pour revue ou archivage.

### 3.6 Extensions

- Compétences (skills) : fichiers Markdown décrivant une procédure, injectés quand la tâche correspond. Compatibles avec le format existant de Claude Code pour réutiliser l'écosystème.
- Agents nommés : un rôle (par exemple « relecteur sécurité ») lié à un protocole, un modèle préféré et des outils autorisés.
- Crochets (hooks) : avant/après outil, avant/après tâche, à la fin de session.

---

## 4. Ergonomie et interface

### 4.1 Disposition de la console

Une fenêtre, cinq zones, toutes redimensionnables et masquables :

```
┌───────────────────────────────────────────────────────────────────┐
│ Barre de commande : saisie naturelle, /commandes, @fichiers, #tâches │
├─────────────┬───────────────────────────────┬─────────────────────┤
│ Explorateur │ Zone centrale (onglets) :      │ Tableau des agents  │
│ fichiers,   │ conversation, diff, fichier,  │ qui / quoi / depuis │
│ tâches,     │ navigateur, tests, terminal   │ quand / coût /      │
│ tickets     │                               │ confiance           │
├─────────────┴───────────────────────────────┴─────────────────────┤
│ Fil d'exécution : graphe des tâches en direct, cliquable, pausable │
└───────────────────────────────────────────────────────────────────┘
```

### 4.2 Le fil d'exécution (élément différenciant)

Le graphe de tâches est **la** vue principale, pas un détail caché. Chaque nœud affiche : l'icône du modèle assigné, l'état (en attente, en cours, en relecture, terminé, échoué, replié), la durée, le coût. Un clic ouvre le détail : prompt envoyé, réponse, justification du routage, boutons « rediriger vers », « rejouer », « bifurquer ».

### 4.3 Barre de commande

- Langage naturel par défaut.
- `/` ouvre les commandes (plan, route, budget, mémoire, replay, agents).
- `@` référence un fichier, un dossier, un symbole, une URL, un ticket.
- `#` référence une tâche du graphe en cours.
- `!` exécute directement dans le terminal.
- Suggestion contextuelle du protocole de collaboration adapté, modifiable d'un clic.

### 4.4 Tableau des agents

Liste vivante des modèles au travail. Pour chacun : nom, fournisseur, tâche courante, temps écoulé, jetons consommés, coût, indicateur de confiance (basé sur l'historique sur ce projet). Glisser une tâche d'un agent à un autre la redirige.

### 4.5 Principes d'interaction

- **Zéro surprise** : rien ne s'exécute sans que l'utilisateur ait pu le voir venir dans le plan.
- **Réponse en moins de 100 ms** pour toute action locale ; le réseau n'est jamais sur le chemin critique de l'interface.
- **Clavier d'abord** : tout est atteignable sans souris, palette de commandes universelle.
- **Mode terminal pur** (TUI) avec les mêmes fonctions pour les sessions SSH et les puristes.
- **Accessibilité** : contraste WCAG 2.2 AA, lecteurs d'écran supportés, pas d'information portée uniquement par la couleur.
- **Thème** : sombre et clair, densité réglable.

### 4.6 Première utilisation

1. Détection automatique des clés et des modèles locaux.
2. Proposition d'un profil (économe, équilibré, performance) qui règle les défauts de routage et de budget.
3. Mini-banc d'essai facultatif de deux minutes sur le dépôt courant pour calibrer.
4. Première tâche guidée.

---

## 5. Architecture technique

### 5.1 Composants

```
┌──────────────────────────────────────────────────────────────┐
│ Interfaces : application bureau (Tauri + React) │ TUI │ CLI  │
└───────────────────────────┬──────────────────────────────────┘
                            │ IPC local (JSON-RPC sur socket)
┌───────────────────────────▼──────────────────────────────────┐
│ Noyau KernelPAI                                               │
│  Planificateur → Routeur → Exécuteur → Vérificateur → Journal │
│  Mémoire unifiée │ Gouverneur de budget │ Gestion permissions │
└──────┬─────────────────────┬─────────────────────┬───────────┘
       │                     │                     │
┌──────▼──────┐   ┌──────────▼─────────┐   ┌───────▼─────────┐
│ Adaptateurs │   │ Bus d'outils (MCP) │   │ Stockage local  │
│ fournisseurs│   │ fs, git, shell,    │   │ SQLite + Markdown│
│ cloud/local │   │ navigateur, tests  │   │ OpenTelemetry   │
└─────────────┘   └────────────────────┘   └─────────────────┘
```

### 5.2 Contrats clés

- **Adaptateur fournisseur** : `send(messages, tools, options) → flux`, `cancel(id)`, `capabilities() → fiche`, `estimate(messages) → coût`.
- **Nœud de tâche** : identifiant, type, entrées, sorties, criticité, budget, modèle assigné, liste de repli, protocole, état, justification.
- **Événement de journal** : horodatage, nœud, modèle, type (routage, appel, outil, intervention), charge utile, coût.

### 5.3 Routage : algorithme de référence

```
pour chaque nœud prêt :
  candidats ← modèles compatibles (modalité, contexte, juridiction, autorisés)
  pour chaque candidat :
    score ← w1·compétence_statique(type)
          + w2·compétence_mesurée(projet, type)
          − w3·coût_estimé / budget_nœud
          − w4·latence_typique / latence_max
  si protocole exige diversité : exclure le fournisseur de l'auteur
  choisir le meilleur ; liste de repli ← suivants dans l'ordre
  journaliser la justification
```

Les poids sont réglés par le profil utilisateur et ajustés par le banc d'essai.

### 5.4 Apprentissage des compétences

Après chaque tâche, le résultat est noté automatiquement (tests passés, diff accepté sans modification, critique sans objection majeure) et manuellement si l'utilisateur le souhaite. La note met à jour la compétence mesurée du modèle pour ce type de tâche sur ce projet. Les scores sont locaux ; un partage anonymisé et optionnel pourra alimenter une base communautaire plus tard.

---

## 6. Sécurité et confidentialité

- Clés d'API dans le coffre du système d'exploitation, jamais dans un fichier du projet.
- **Zones interdites** : motifs de fichiers et dossiers qui ne quittent jamais la machine ; les modèles locaux peuvent les lire, les modèles cloud reçoivent un résumé ou rien.
- Terminal sandboxé par défaut ; les commandes destructives sont listées et confirmées.
- Toute sortie de modèle est traitée comme donnée non fiable : pas d'exécution automatique d'instructions trouvées dans des pages, fichiers ou réponses d'outils.
- Journal d'audit inviolable des appels sortants (quoi, vers qui, quand, taille).
- Chiffrement au repos de la mémoire et des journaux, optionnel mais activé par défaut.

---

## 7. Mesures de réussite

| Mesure | Cible v1 |
|---|---|
| Latence du routeur (décision) | < 50 ms |
| Taux de repli réussi sans intervention | > 95 % |
| Écart estimation / coût réel | < 15 % |
| Diffs acceptés sans modification humaine | > 60 % |
| Temps de la première tâche après installation | < 5 min |
| Couverture de tests du noyau | > 80 % |

---

## 8. Risques et parades

- **Explosion des coûts par sur-vérification.** Parade : criticité par nœud, la relecture croisée n'est obligatoire que pour les livrables critiques.
- **Latence cumulée des protocoles multi-modèles.** Parade : parallélisme par défaut, flux affiché dès le premier jeton, protocole Solo pour le trivial.
- **Dépendance aux fiches de capacités déclarées.** Parade : banc d'essai local et apprentissage mesuré priment sur le déclaratif.
- **Complexité perçue.** Parade : profils, défauts intelligents, le graphe peut être replié en une simple conversation.
- **Évolution rapide des API fournisseurs.** Parade : adaptateurs isolés, tests contractuels par fournisseur.

---

## 9. Feuille de route par phases

Chaque phase se termine par une démo exécutable et un rapport.

**Phase 0 — Fondations (2 semaines).** Dépôt, CI, structure monorepo, contrat d'adaptateur, deux adaptateurs (un cloud, Ollama en local), journal SQLite, CLI minimale qui envoie une demande à un modèle choisi et journalise. ADR pour la pile.

**Phase 1 — Routeur (3 semaines).** Fiches de capacités, routeur par score, repli, estimation de coût, gouverneur de budget. CLI : `kpai run "demande"` affiche le plan, le routage et le coût. Tests de panne de fournisseur.

**Phase 2 — Protocoles (3 semaines).** Planificateur en graphe, protocoles Solo, Auteur + critique, Débat, Vote. Bus MCP avec fs, git, shell sandboxé. Première démo de bout en bout : tâche de code avec relecture croisée.

**Phase 3 — Console (4 semaines).** Application bureau : barre de commande, fil d'exécution cliquable, tableau des agents, onglets diff et terminal. Mode TUI partageant le noyau. Première utilisation guidée.

**Phase 4 — Mémoire et apprentissage (3 semaines).** Mémoire unifiée trois couches, provenance, notation automatique, banc d'essai, mise à jour des compétences mesurées. Rejouer et bifurquer.

**Phase 5 — Outils et extensions (3 semaines).** Navigateur piloté, exécuteur de tests, tickets, compétences au format Claude Code, agents nommés, crochets. Fournisseurs restants.

**Phase 6 — Durcissement (2 semaines).** Zones interdites, coffre de clés, audit, chiffrement, accessibilité, performance. Préparation macOS et Linux.

Total indicatif : vingt semaines pour une v1 utilisable par un développeur seul.

---

## 10. Glossaire

- **Kernel** : le noyau d'orchestration, par analogie avec un système d'exploitation.
- **Périphérique IA** : un modèle décrit par une fiche de capacités et piloté par un adaptateur.
- **Nœud** : une tâche unitaire du graphe, routée vers un modèle.
- **Protocole** : la façon dont plusieurs modèles collaborent sur un nœud ou un groupe de nœuds.
- **Repli** : passage automatique au modèle suivant de la liste quand le premier échoue.
- **Fiche de capacités** : description statique d'un modèle (forces, coût, contexte, juridiction).
- **Compétence mesurée** : score dynamique d'un modèle sur un type de tâche, appris sur le projet.
- **MCP** : Model Context Protocol, protocole ouvert d'exposition d'outils aux modèles.
