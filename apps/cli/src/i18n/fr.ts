/** Messages en français de la CLI `kpai` (WI-S6-02) : mêmes clés et paramètres qu'en anglais. */
import type { Catalogue } from './core.js';

export const fr: Catalogue = {
  usage: `KernelPAI (phase 3)

Utilisation :
  kpai do <demande>                    Planifie un graphe de tâches, montre qui fait quoi et le coût,
                                       l'exécute avec relecture par un autre fournisseur, montre les correctifs
  kpai plan <demande>                  Le même plan et la même estimation, à blanc
      [--planner template|model] [--apply] [--yes-apply] [--allow-same-provider]
      [--isolated]  exécution dans son propre worktree git, fusionné après confirmation
      [--scope <fichier>]  périmètre autorisé (YAML/JSON) pour les packs qui l'exigent
      --yes n'accepte que les questions de coût ; écrire exige --yes-apply ou o à la question
  kpai checkpoints [--session <id>]   Points de reprise pris avant les écritures, par exécution
  kpai restore <réf>                   Restaure un point de reprise (demande toujours ; annulation affichée)
  kpai merge <id-exécution>            Fusionne le worktree d'une exécution isolée (demande avec le diff)
  kpai discard <id-exécution>          Supprime le worktree d'une exécution isolée
  kpai pack list|show|detect|check|init  Packs de domaine (voir kpai pack help)
  kpai tools                           Outils utilisables par les modèles, leur risque et leur source
  kpai studio [--port N] [--allow-test] Démarre le serveur noyau local de KP Studio, affiche son URL
                                       (--allow-test : fournisseurs simulés hors ligne par défaut)
  kpai run <demande>                   Classe, route selon la compétence, vérifie le budget,
                                       exécute avec repli automatique, journalise tout
  kpai route <demande>                 Même plan et même routage, à blanc (rien n'est envoyé)
      [--type T] [--criticality low|normal|critical] [--profile economy|balanced|performance]
      [--local-only] [--exclude p1,p2] [--max-tokens N] [--yes] [--over-budget]
      [--new-session] [--allow-test] [--verbose]          --allow-test autorise le routage vers les fournisseurs simulés
  kpai stats [--session <id>]          Taux de repli, coût par tâche, erreur d'estimation, latence du routeur
  kpai providers                       Détecte les fournisseurs et liste les modèles
  kpai ask -m <fournisseur/modèle> <texte>  Envoie une requête, diffuse la réponse, la journalise
      [--system <texte>] [--max-tokens N] [--yes]
  kpai log [--session <id>] [--limit N] Liste les sessions, ou les événements d'une session
  kpai export <session> [--out fichier] Exporte une session en Markdown
  kpai verify                          Vérifie la chaîne de hachage du journal

Global : --db <chemin> (par défaut $KPAI_HOME/journal.db, KPAI_HOME=~/.kernelpai)
         --lang en|fr (par défaut $KPAI_LANG, puis LC_ALL, LC_MESSAGES, LANG)
`,
  'error.usage': '{message}\n\n{usage}',
  'error.provider': 'erreur ({kind}) : {message}\n',
  'error.generic': 'erreur : {message}\n',
  'error.unknownCommand': 'Commande inconnue « {command} »',
  'error.unknownOption': 'Option inconnue {option}',
  'error.badArguments': 'Arguments invalides : {detail}',
  'error.lang': '--lang doit valoir en ou fr, pas « {value} »',
  'error.positiveInt': '--{name} doit être un entier positif',
  'error.port': '--port doit être un numéro de port (0 en choisit un libre)',
  'error.oneOf': '--{name} doit valoir l’une de ces valeurs : {allowed}',
  'error.graphNeedsRequest': 'plan et do ont besoin d’une demande',
  'error.runNeedsRequest': 'run et route ont besoin d’une demande',
  'error.askNeedsPrompt': 'ask a besoin d’un texte à envoyer',
  'error.exportNeedsSession': 'export a besoin d’un identifiant de session',
  'error.restoreNeedsRef': 'restore a besoin d’une référence de point de reprise',
  'error.mergeNeedsRunId': 'merge a besoin d’un identifiant d’exécution',
  'error.discardNeedsRunId': 'discard a besoin d’un identifiant d’exécution',
  'plan.header': 'plan   {count} nœud(s) · {createdBy} : {reason}',
  'plan.unroutable': 'non routable ({error})',
  'plan.noCandidate': 'aucun candidat',
  'plan.total': 'total  probable {likely} · au plus {cap} (plafond) avant exécution',
  'plan.totalBlocked':
    'total  probable {likely} · au plus {cap} (plafond) avant exécution (exécution impossible telle que prévue : {problems})',
  'confirm.prompt': '{question} [o/N] ',
  'confirm.yesWords': 'o, oui, y, yes',
  'confirm.budget': 'Le coût prévu {expected} dépasse votre seuil {threshold}. Continuer ?',
};
