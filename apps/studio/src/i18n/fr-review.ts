/**
 * Catalogue français, partie 4 : suites de la revue de la phase 4 (D-024) — rejeu estimé
 * avant de partir et annulable (P4-F5), routage hérité par le rejeu et la bifurcation
 * (P4-F2), options de litige montrées en entier ou refusées (P4-F11), verdicts révisés en
 * tête de la relecture (P4-F12) et règle « local seulement » de la mémoire du plan (P4-F3).
 */
import type { Catalogue } from './core';
import type { enReview } from './en-review';

export const frReview: Record<keyof typeof enReview, Catalogue[keyof Catalogue]> = {
  'replay.note':
    'Choisissez un modèle, un protocole ou les deux, puis estimez : rien n’est dépensé avant que vous n’appuyiez sur Lancer le rejeu. Les nœuds de code gardent un critique d’un autre fournisseur.',
  'replay.noteRun':
    'Rien n’est encore dépensé. Lancer le rejeu exécute cette estimation une fois, via le contrôle de budget, et vous pouvez l’annuler pendant qu’il tourne. Changer de modèle ou de protocole demande une nouvelle estimation.',
  'replay.estimate': 'Estimer le rejeu',
  'replay.estimating': 'Estimation…',
  'replay.run': 'Lancer le rejeu (plafond {cap})',
  'replay.estimateTitle': 'Avant toute dépense',
  'replay.routingLocalRun': 'Modèles locaux seulement (hérité de l’exécution d’origine).',
  'replay.routingLocalYours': 'Modèles locaux seulement (votre réglage).',
  'replay.routingExcludeRun':
    'Fournisseurs exclus (hérité de l’exécution d’origine) : {providers}.',
  'replay.routingExcludeYours': 'Fournisseurs exclus (votre réglage) : {providers}.',
  'replay.routingOpen': 'Aucune restriction de fournisseur héritée de l’exécution d’origine.',
  'replay.routingProfile': 'Profil de routage : {profile}.',
  'replay.routingSameProvider':
    'Diversité des fournisseurs levée (comme dans l’exécution d’origine) : un critique peut être du même fournisseur que l’auteur.',
  'replay.scopeProblem': 'Problème de périmètre, le rejeu ne peut pas partir : {problem}',
  'replay.cancel': 'Annuler le rejeu',
  'replay.cancelling': 'Annulation du rejeu de #{id}…',
  'replay.announce.planned':
    'Rejeu du nœud {id} estimé : probable {expected}, plafond {cap}. Rien n’est encore dépensé.',
  'replay.announce.cancelling': 'Annulation du rejeu du nœud {id}',
  'replay.announce.cancelled': 'Rejeu du nœud {id} annulé',
  'fail.replayPlan': 'Le rejeu n’a pas pu être estimé : {error}',
  'verify.revised': {
    one: '1 verdict révisé',
    other: '{count} verdicts révisés',
  },
  'verify.perRevised': '{cost} par verdict révisé',
  'verify.noRevised': 'aucun verdict révisé',
  'verify.rawIssues': 'problèmes soulevés bruts : {count}',
  'productivity.reviewValue':
    '{review} dépensés · verdicts révisés : {count} ({per} chacun) · problèmes soulevés bruts : {issues}',
  'plan.memoryLocalOnlyRule': 'Règle « local seulement » : {rule}',
  'dispute.truncated': 'Cette réponse a été coupée par le noyau : elle ne peut pas être choisie.',
  'tui.disputeKeys': {
    one: '1 = sélectionner la réponse, ] et [ = la faire défiler, puis o = la choisir · n, Échap ou Entrée = tout rejeter (par défaut)',
    other:
      '1–{count} = sélectionner une réponse, ] et [ = la faire défiler, puis o = la choisir · n, Échap ou Entrée = tout rejeter (par défaut)',
  },
  'tui.disputePicked': {
    one: 'Réponse {n} sélectionnée : {label} (1 ligne). Appuyez sur o pour la choisir.',
    other: 'Réponse {n} sélectionnée : {label} ({count} lignes). Appuyez sur o pour la choisir.',
  },
  'tui.disputePickedLong': {
    one: 'Réponse {n} sélectionnée : {label}. Lisez-la jusqu’au bout avec ] avant de la choisir avec o (1 ligne).',
    other:
      'Réponse {n} sélectionnée : {label}. Lisez-la jusqu’au bout avec ] avant de la choisir avec o ({count} lignes).',
  },
  'tui.disputeWindow': 'Réponse {n} : lignes {from}–{to} sur {total} · ] suivant · [ précédent',
  'tui.disputeRead': 'Réponse {n} lue jusqu’au bout. Appuyez sur o pour la choisir.',
  'tui.disputeReadFirst':
    'Lisez d’abord la réponse {n} jusqu’au bout ({seen} lignes sur {total} affichées) : appuyez sur ].',
  'tui.disputeTruncated':
    'La réponse {n} a été coupée par le noyau et ne peut pas être choisie. Choisissez-en une autre, ou appuyez sur n pour tout rejeter.',
};
