# mrscoring-status - Chien de garde et page de statut de MRScoring

Vérifie [app.mrscoring.com](https://app.mrscoring.com) **hors de son hébergement** (GitHub Actions), toutes les 5 minutes,
et publie l'état sur [status.mrscoring.com](https://status.mrscoring.com) et dans l'onglet **Santé** du Tableau de bord
(les deux lisent le même `status.json`). Ne dépend ni de Vercel, ni d'un PC, et **n'a aucun accès à la base** : le site
fait ses vérifications de fond lui-même (`/api/health?full=1`).

**Pourquoi un passage dure 5 h 40.** Le calendrier de GitHub ne lance un workflow planifié que toutes les 2 à 2,5 h.
Chaque passage vérifie donc toutes les 5 min pendant 5 h 40, publie l'état après chaque tour, puis relance lui-même le
suivant. Le calendrier (toutes les 2 h) est un filet de sécurité.

## Ce qui est vérifié

| Fréquence | Vérification | Gravité si en échec |
|---|---|---|
| 5 min | Le site répond (page de connexion) | **critique** (ou mineure si seulement lent, > 5 s) |
| 5 min | Le site joint sa base (`/api/health`) | **critique** |
| 1 h | Import automatique passé depuis moins de 8 h | majeure |
| 1 h | Sauvegarde du jeudi faite et réussie (moins de 8 jours) | majeure |
| 1 h | Certificat https / domaine : plus de 7 / 30 jours | majeure (mineure sous 21 / 60 jours) |
| 1 h | Erreurs d'import répétées, fil du jour vide, résultats pas encore dans le fil, base chargée | mineure |

- **Critique** : les usagers sont touchés. **Majeure** : un service de fond a manqué. **Mineure** : à surveiller.
- Un échec est revérifié 20 s plus tard avant d'ouvrir une panne. La panne se ferme au retour à la normale.
- Courriel aux admins à l'ouverture et à la fermeture d'une panne critique ou majeure, et un résumé le lundi.

## Où va l'état

`status.json` sur la branche **data** (un seul commit, remplacé à chaque tour). La page de statut et l'onglet Santé le
lisent tous deux : ils ne peuvent pas diverger.

## Mise en route (une fois)

1. Dépôt public `nriouxgpnrca/mrscoring-status` sur GitHub, puis pousser ce dossier.
2. **Settings > Secrets and variables > Actions** : `RESEND_API_KEY` (clé d'envoi Resend), `ALERT_EMAILS` (courriels
   séparés par des virgules). Aucun secret de base de données.
3. **Settings > Pages** : Source = *Deploy from a branch*, branche `main`, dossier `/docs`. Domaine : `status.mrscoring.com`.
4. **GoDaddy > DNS de mrscoring.com** : enregistrement `CNAME`, nom `status`, valeur `nriouxgpnrca.github.io`.
5. **Actions** > *Chien de garde* > *Run workflow* pour un premier passage (ensuite toutes les 5 min).

## Essai local

```bash
node watchdog.mjs out/status.json
```

Un seul tour (sans `LOOP_MINUTES`), rien n'est publié (sans `PUBLISH=1`). Sans `RESEND_API_KEY`, les courriels sont
seulement écrits dans la console. Aucune dépendance à installer.
