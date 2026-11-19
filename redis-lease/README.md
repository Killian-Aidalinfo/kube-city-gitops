# Redis en haute disponibilité sur DEUX nœuds, arbitré par Kubernetes

## Le problème

À deux nœuds, **aucun quorum interne à Redis ne peut fonctionner**. Redis Sentinel exige
la majorité des Sentinel pour autoriser une bascule ; perdre un nœud sur deux fait toujours
tomber la moitié ou plus des votants. Ajouter un Sentinel témoin aide (3 votants au lieu
de 2) mais ne ferme pas le trou : sur deux nœuds, le témoin partage forcément le nœud d'un
Redis, et perdre CE nœud laisse 1 votant sur 3. Ajouter un quatrième votant empire les
choses (quorum 3, perte de 2 → mort).

La seule issue est un arbitre **extérieur aux deux nœuds**. Sur Kapsule, il est déjà là :
le serveur d'API tourne sur le plan de contrôle managé par Scaleway. Il survit à la perte
de n'importe lequel de nos nœuds.

## Le montage

```
2 pods Redis, un par nœud (anti-affinité « required »), SANS Sentinel
  └─ conteneur voisin « promoteur » dans chaque pod, toutes les 2 s :
       tient ou prend le Lease Kubernetes « redis-master »
       ├─ détenteur : REPLICAOF NO ONE   + label redis-role=master
       │              + retire ce label aux autres pods
       └─ les autres : REPLICAOF <détenteur> 6379 + label redis-role=replica

Service « kc-redis-master » : selector redis-role=master  →  suit le maître tout seul
Le client écrit sur kc-redis-master:6379 et n'a rien à reconfigurer.
```

L'arbitrage tient dans une seule propriété : toute écriture du Lease porte son
`resourceVersion`. Si les deux pods tentent en même temps, **l'API en refuse un** (409).
Il n'y a pas d'autre élection, pas de vote, pas de protocole à déboguer.

### Pourquoi il n'y a pas de split-brain

Un pod coupé du réseau ne peut plus renouveler son bail auprès de l'API — et le promoteur
ne touche à rien quand l'API est injoignable. Il ne peut donc jamais se promouvoir seul.
Pendant ce temps, l'autre pod voit le bail expirer et prend la main légitimement.

### Mesures

| | |
|---|---|
| Bascule après mort brutale du maître | **11 s** (bail de 10 s + un tic de 2 s) |
| Donnée écrite avant la panne | relue intacte via le Service après bascule |
| Réglage | `LEASE_SECONDS` (10) et `TICK_MS` (2000) dans le StatefulSet |

Descendre `LEASE_SECONDS` raccourcit la bascule mais rend le système sensible à une
latence passagère de l'API : à 4 s, un hoquet de 4 s suffirait à déclencher une bascule
inutile. 10 s est un compromis, pas une limite physique.

## Installer

```bash
kubectl -n kube-city create secret generic redis-auth \
  --from-literal=REDIS_PASSWORD="$(openssl rand -hex 16)"     # s'il n'existe pas déjà
kubectl -n kube-city create configmap kc-redis-promoteur --from-file=promoteur.mjs
kubectl apply -f redis-lease.yaml
```

Après toute modification de `promoteur.mjs` : recréer le ConfigMap (`--dry-run=client -o yaml
| kubectl apply -f -`) puis `kubectl -n kube-city rollout restart sts/kc-redis`.

Côté application, remplacer le mode Sentinel par une simple URL :
`redis://:<mot de passe>@kc-redis-master.kube-city.svc.cluster.local:6379`

## Trois pièges rencontrés en l'écrivant

1. **Les dates d'un Lease sont des `MicroTime`** : l'API exige SIX décimales et répond
   `HTTP 400 cannot parse ".430Z" as ".000000"` pour les trois que produit `toISOString()`.
2. **Ne jamais nommer une variable `REDIS_PORT`** : Kubernetes en injecte une pour tout
   Service nommé `redis` du namespace, avec la valeur `tcp://10.x.x.x:6379`.
   `Number(...)` donne `NaN` et le socket refuse de s'ouvrir.
3. **L'identité du bail doit porter l'UID du pod**, pas son nom : un StatefulSet recrée
   `kc-redis-1` sous le même nom. Sans l'UID, un pod redémarré se reconnaît détenteur et
   redevient maître avec des données peut-être en retard — le réplica à jour se
   resynchronise alors sur lui et perd tout. Un pod qui vient de démarrer laisse en plus
   passer un cycle de bail complet avant de réclamer la main.

## En service

Depuis le 19/11/2026, le jeu du cluster `ec-grp-test` écrit sur ce Redis : la pile Bitnami
Sentinel a été retirée. La bascule s'est faite **sans une seule requête perdue** (0 échec sur
90 mesures, retrait de Bitnami compris), et la mémoire réservée des nœuds est passée de
83-86 % à 34-50 % — cinq pods Redis pour un seul service rendu, c'était le vrai coût.

Côté `values` du chart :

```yaml
redis:
  enabled: false
  existingSecret: redis-url      # Secret créé à la main, clé REDIS_URL
  sentinel:
    hosts: ""                    # vide : le chart choisit alors REDIS_URL
```

## Ce qui reste à éprouver

La coupure brutale du **nœud** qui porte le maître (et pas seulement du pod). Par
conception elle est couverte — le nouveau maître retire le label de l'ancien par l'API,
qui répond même si le nœud est mort — mais ça n'a pas encore été mesuré sur ce cluster.
