/** Français, partie 6 : l’onglet Outils et compétences (R-501, R-502) et le résumé
 * Entreprise du terminal (R-5E14). Même ordre de clés que `en-tools.ts`. */
import type { Message } from './core';
import type { enTools } from './en-tools';

export const frTools: Record<keyof typeof enTools, Message> = {
  'tab.tools': 'Outils et compétences',
  'tools.intro':
    'Ce que les exécutions peuvent utiliser ici. Noms et descriptions viennent de fichiers : KP Studio les montre comme du texte et ne les suit jamais.',
  'tools.refresh': 'Actualiser',
  'tools.fail.load': 'Impossible de charger une partie de cet onglet : {error}',
  'tools.fail.ticket': 'Impossible d’ouvrir le ticket : {error}',
  'tools.fail.approve': 'Échec de l’approbation : {error}',
  'tools.error.badReply':
    'Le noyau a répondu à {method} d’une façon que KP Studio ne comprend pas.',
  'tools.untrusted': 'texte non fiable',
  'tools.origin.repo': 'de ce dépôt',
  'tools.origin.home': 'de votre dossier personnel',
  'tools.mcp.title': { one: 'Serveur MCP (1)', other: 'Serveurs MCP ({count})' },
  'tools.mcp.intro': {
    one: '1 outil intégré en plus d’eux.',
    other: '{count} outils intégrés en plus d’eux.',
  },
  'tools.mcp.readOnly':
    'Ce noyau montre les serveurs MCP en lecture seule : approuvez-en un dans un terminal avec la commande ci-dessous.',
  'tools.mcp.none': 'Aucun serveur MCP n’est autorisé. Les serveurs sont listés dans {file}.',
  'tools.mcp.tools': { one: '1 outil', other: '{count} outils' },
  'tools.mcp.version': 'version {version}',
  'tools.mcp.egress': 'peut joindre {hosts}',
  'tools.mcp.noEgress': 'aucun accès réseau',
  'tools.mcp.state.approved': 'approuvé',
  'tools.mcp.state.unapproved': 'pas encore approuvé',
  'tools.mcp.state.changed': 'modifié depuis l’approbation',
  'tools.mcp.state.blocked': 'bloqué',
  'tools.mcp.state.unreachable': 'injoignable',
  'tools.mcp.whatChanged':
    'Ce qui a changé : chaque appel est refusé jusqu’à ce que vous l’approuviez à nouveau.',
  'tools.mcp.changesUnknown':
    'Ce noyau ne dit pas ce qui a changé. La commande d’approbation montre chaque différence avant que vous décidiez.',
  'tools.mcp.blockedTools': { one: '1 outil bloqué :', other: '{count} outils bloqués :' },
  'tools.mcp.howTo': 'Examinez et approuvez avec',
  'tools.mcp.approve': 'Examiner et approuver…',
  'tools.mcp.approveTitle': 'Approuver le serveur MCP {server} ?',
  'tools.mcp.approveBody':
    'Vous approuvez exactement ce qui est montré : {count} outils en version {version}. Tout changement ultérieur bloque à nouveau le serveur.',
  'tools.mcp.hash': 'Empreinte de la liste d’outils {hash}…',
  'tools.mcp.approveYes': 'Approuver cette version',
  'tools.mcp.approved': 'Serveur MCP {server} approuvé',
  'tools.mcp.notApproved': 'Le serveur MCP {server} n’a pas été approuvé',
  'tools.ext.title': { one: 'Compétence ou agent (1)', other: 'Compétences et agents ({count})' },
  'tools.ext.none': 'Aucune compétence ni agent nommé dans cet espace de travail.',
  'tools.kind.skill': 'compétence',
  'tools.kind.agent': 'agent',
  'tools.hooks.title': { one: 'Crochet (1)', other: 'Crochets ({count})' },
  'tools.hooks.allowed': 'autorisé à s’exécuter',
  'tools.hooks.asks': 'vous demande à chaque fois',
  'tools.tickets.title': { one: 'Ticket (1)', other: 'Tickets ({count})' },
  'tools.tickets.none': 'Aucun ticket. Écrivez-en un en Markdown dans {dir}.',
  'tools.tickets.caption': 'Tickets locaux',
  'tools.tickets.id': 'Ticket',
  'tools.tickets.titleCol': 'Titre',
  'tools.tickets.status': 'Statut',
  'tools.tickets.criteria': 'Vérifications',
  'tools.tickets.actions': 'Actions',
  'tools.tickets.show': 'Ouvrir {id}',
  'tools.tickets.request': 'La demande que fait ce ticket',
  'tools.tickets.plan': 'Planifier ce ticket',
  'tui.ent.title': 'Entreprise',
  'tui.ent.keys':
    'Ctrl+E espace de travail · Ctrl+X tout arrêter · Ctrl+U autoriser à nouveau · Ctrl+Q quitter',
  'tui.ent.loading': 'Chargement de l’entreprise…',
  'tui.ent.spend': 'Dépense : {spent} dépensés · {committed} engagés sur {cap} ({share})',
  'tui.ent.rate': 'Rythme : {rate}',
  'tui.ent.programs': { one: 'Programme (1)', other: 'Programmes ({count})' },
  'tui.ent.team':
    'Équipe : {total} postes · {working} au travail · {waiting} vous attendent · {blocked} bloqués · {idle} inactifs',
  'tui.ent.sources': 'Tourne sur : {local} local · {api} API · {subscription} abonnement',
  'tui.ent.inbox': { one: 'Vos décisions (1)', other: 'Vos décisions ({count})' },
  'tui.ent.inboxHint': 'Ouvrez les preuves et répondez dans la console web (kpai studio).',
  'tui.ent.more': { one: '… et 1 de plus', other: '… et {count} de plus' },
  'tui.ent.assurance': 'Vérifié : {mix}',
  'tui.ent.quota': 'Quota : {lines}',
  'tui.ent.killed': '■ Tout est arrêté. Ctrl+U autorise à nouveau le travail.',
};
