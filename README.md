# mrscoring-status - Chien de garde et page de statut de MRScoring

Vérifie [app.mrscoring.com](https://app.mrscoring.com) **hors de son hébergement** (GitHub Actions) et publie l'état sur
[status.mrscoring.com](https://status.mrscoring.com). Ne dépend ni de Vercel, ni de Supabase pour afficher l'état, ni
d'un PC.

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

- `status.json` sur la branche **data** (un seul commit, remplacé à chaque passage) : lu par la page de statut.
- Recopié dans la base du site (`watchdog_status`, `watchdog_incidents`, `watchdog_daily`) pour l'onglet **Santé**
  du Tableau de bord. Si la base est injoignable, la recopie se fait au passage suivant.

## Mise en route (une fois)

1. Dépôt public `nriouxgpnrca/mrscoring-status` sur GitHub, puis pousser ce dossier.
2. **Settings > Secrets and variables > Actions** : `SITE_DATABASE_URL` (adresse « pooler » de la base du site, celle de
   `secrets.env`), `RESEND_API_KEY` (la clé d'envoi de Vercel), `ALERT_EMAILS` (courriels séparés par des virgules).
3. **Settings > Pages** : Source = *Deploy from a branch*, branche `main`, dossier `/docs`. Domaine : `status.mrscoring.com`.
4. **GoDaddy > DNS de mrscoring.com** : enregistrement `CNAME`, nom `status`, valeur `nriouxgpnrca.github.io`.
5. **Actions** > *Chien de garde* > *Run workflow* pour un premier passage (ensuite toutes les 5 min).

## Essai local

```bash
npm ci
SITE_DATABASE_URL=... node watchdog.mjs out/status.json
```

Sans `RESEND_API_KEY`, les courriels sont seulement écrits dans la console.
