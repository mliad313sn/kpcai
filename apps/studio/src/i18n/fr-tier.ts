/** Français, partie 7 : les niveaux d'affichage (Charte de simplicité §3, P5-F5). Même
 * ordre de clés que `en-tier.ts`. */
import type { enTier } from './en-tier';
import type { Message } from './core';

export const frTier: Record<keyof typeof enTier, Message> = {
  'tier.label': 'Niveau',
  'tier.beginner': 'Débutant',
  'tier.regular': 'Régulier',
  'tier.expert': 'Expert',
  'tier.announce': 'Niveau : {tier}',
  'palette.tier': 'Passer au niveau {tier}',
  'palette.delegate': 'Confier un projet entier',
  'palette.delegateHint':
    'KP réalise tout un projet pour vous ; vous approuvez le plan et son coût',
  'view.workspace.plain': 'Mes tâches',
  'view.enterprise.plain': 'Projets confiés',
  'view.enterpriseAsks.plain': {
    one: 'Projets confiés · 1 question',
    other: 'Projets confiés · {count} questions',
  },
  'palette.workspace.plain': 'Afficher mes tâches',
  'palette.enterprise.plain': 'Afficher les projets confiés',
};
