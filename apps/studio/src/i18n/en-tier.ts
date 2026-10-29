/** English catalogue, part 7: disclosure tiers (Simplicity Charter §3, P5-F5). Labels a
 * beginner reads (`*.plain`) keep to the Charter's beginner words. Same key order as
 * `fr-tier.ts`. */
export const enTier = {
  'tier.label': 'Level',
  'tier.beginner': 'Beginner',
  'tier.regular': 'Regular',
  'tier.expert': 'Expert',
  'tier.announce': 'Level: {tier}',
  'palette.tier': 'Set the level to {tier}',
  'palette.delegate': 'Delegate a whole project',
  'palette.delegateHint': 'KP does a whole project for you; you approve the plan and its cost',
  'view.workspace.plain': 'My tasks',
  'view.enterprise.plain': 'Delegated projects',
  'view.enterpriseAsks.plain': {
    one: 'Delegated projects · 1 question',
    other: 'Delegated projects · {count} questions',
  },
  'palette.workspace.plain': 'Show my tasks',
  'palette.enterprise.plain': 'Show delegated projects',
} as const;
