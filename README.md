# kube-city-gitops

Configuration du cluster Kubernetes qui fait tourner [Kube City](https://github.com/Killian-Aidalinfo/kube-city),
le jeu de ville multijoueur en haute disponibilité.

Tout ce qui tourne sur le cluster est décrit ici : **Argo CD lit ce dépôt et applique ce qu'il y trouve.**
Pour changer le jeu de version, son nombre de pods ou son nom de domaine, on modifie un fichier ici —
on ne lance pas de `helm install` à la main.

## Le cluster

| | |
|---|---|
| Cluster | `k8s-par-killian-test` — Scaleway Kapsule, région `fr-par`, zone `fr-par-1` |
| Nœuds | 3 × PLAY2-NANO (2 vCPU, 4 Go) — 3 nœuds, parce que le jeu veut un pod et un Redis par nœud |
| CNI | Cilium |
| Jeu | <https://kube-city.killian-s.lab-cesi.fr> (page enseignant : `/status`) |
| Argo CD | <https://argocd.killian-s.lab-cesi.fr> |

## Les quatre briques

```
Internet
   │
   ▼
Traefik ───────────── contrôleur d'Ingress, DaemonSet (un par nœud), LoadBalancer Scaleway
   │                  termine le TLS, redirige tout le HTTP vers le HTTPS
   ├── cert-manager ── demande et renouvelle les certificats Let's Encrypt (défi HTTP-01 via Traefik)
   ├── Argo CD ─────── lit ce dépôt, crée et resynchronise les applications
   └── Kube City ───── 3 pods de jeu + Redis Sentinel (3 pods), namespace « kube-city »
```

* **Traefik** crée l'IngressClass `traefik`, celle que demandent les Ingress du jeu et d'Argo CD.
  En **DaemonSet** : avec `externalTrafficPolicy: Local`, le LoadBalancer n'envoie du trafic
  qu'aux nœuds portant un Traefik local, et un nœud sans Traefik jette ce qu'il reçoit.
  Un Deployment à 3 réplicas s'était reconcentré 2/0/1 après la perte d'un nœud le 19/11/2026 ;
  le DaemonSet rend ce cas impossible. `Local` garde par ailleurs l'IP réelle du joueur.
* **cert-manager** répond aux annotations `cert-manager.io/cluster-issuer: letsencrypt`.
  Deux autorités : `letsencrypt-staging` pour répéter sans brûler le quota, `letsencrypt` pour de vrai.
* **Argo CD** est en `server.insecure` : c'est Traefik qui porte le HTTPS, sinon on obtient une
  boucle de redirection. Dex et les notifications sont désactivés (inutiles ici, et le cluster est petit).
* **Kube City** vient du dépôt applicatif ; seules ses *valeurs* sont ici.

## Organisation du dépôt

```
bootstrap/     ce qu'on installe À LA MAIN une fois, avant qu'Argo CD existe
  traefik-values.yaml
  cert-manager-clusterissuer.yaml
  argocd-values.yaml
  bootstrap.sh                   le tout, dans l'ordre
apps/          les Applications Argo CD (ce qu'Argo CD gère tout seul ensuite)
  root.yaml                      « app-of-apps » : la seule appliquée à la main
  redis.yaml                     Redis + Sentinel (vague 1)
  kube-city.yaml                 le jeu (vague 2)
values/        les valeurs Helm lues par les Applications
  redis.yaml
  kube-city.yaml
redis-lease/   Redis en HA sur DEUX nœuds, arbitré par un Lease Kubernetes
               (hors apps/ : Argo CD ne l'applique pas, c'est une brique à reprendre)
clusters/
  grp-test/    le cluster d'un groupe : 2 nœuds, Helm direct, sans Argo CD
```

Les Applications sont **multi-sources** : le chart vient d'ailleurs (dépôt applicatif ou registre Bitnami),
les valeurs viennent de ce dépôt via `$values`. C'est ce qui permet de garder la configuration ici
sans dupliquer les charts.

## Reconstruire le cluster depuis zéro

```bash
# 1. Un cluster Kapsule à 3 nœuds et son kubeconfig
scw -p cesi k8s cluster create name=kube-city version=1.36.5 cni=cilium region=fr-par \
  pools.0.name=jeu pools.0.node-type=PLAY2-NANO pools.0.size=3 pools.0.zone=fr-par-1
scw -p cesi k8s kubeconfig get <cluster-id> > ~/.kube/bastion/par-killian-test.yaml
export KUBECONFIG=~/.kube/bastion/par-killian-test.yaml

# 2. Le mot de passe Redis (il ne doit exister nulle part dans ce dépôt)
kubectl create namespace kube-city
kubectl -n kube-city create secret generic redis-auth \
  --from-literal=REDIS_PASSWORD="$(openssl rand -hex 16)"

# 3. Traefik, cert-manager, Argo CD, puis l'application racine
./bootstrap/bootstrap.sh
```

Le script s'arrête après Traefik pour afficher l'IP du LoadBalancer : faites pointer
`kube-city.<domaine>` et `argocd.<domaine>` dessus (ici, zone `lab-cesi.fr` chez Scaleway)
avant de laisser cert-manager demander les certificats.

Mot de passe `admin` d'Argo CD :

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

## Ce qui n'est PAS dans ce dépôt

* **Le mot de passe Redis** (`Secret redis-auth`) : créé à la main, régénérable à tout moment.
* **Le mot de passe admin d'Argo CD** : généré à l'installation, dans un Secret du cluster.

Un dépôt de configuration se partage et se lit ; aucun secret n'y entre, même chiffré à la va-vite.

## Au quotidien

| Je veux… | Je modifie… |
|---|---|
| changer la version du jeu | `values/kube-city.yaml` → `image.tag` |
| changer le nom de domaine | `values/kube-city.yaml` → `ingress.host` (+ le DNS) |
| plus de pods de jeu | `values/kube-city.yaml` → `replicaCount` / `autoscaling` |
| régler la bascule Redis | `values/redis.yaml` → `sentinel.downAfterMilliseconds`, `quorum` |
| ajouter une application | un fichier de plus dans `apps/` |

Un `git push` suffit : Argo CD resynchronise tout seul (`automated`, `selfHeal`, `prune`).

## Les épreuves de chaos

Elles vivent dans le dépôt applicatif : `deploy/kapsule/chaos.sh` et `scripts/sonde.mjs`.
Mesurez toujours via l'Ingress (`https://kube-city.killian-s.lab-cesi.fr`), jamais par
`kubectl port-forward` : un port-forward meurt avec le pod visé et fausse la mesure.

```bash
node scripts/sonde.mjs https://kube-city.killian-s.lab-cesi.fr   # terminal A
NS=kube-city REL=jeu ./deploy/kapsule/chaos.sh 4                 # terminal B : tuer le maître Redis
```

`selfHeal` d'Argo CD ne gêne pas ces épreuves : tuer un pod n'est pas une dérive de configuration,
c'est le contrôleur Kubernetes qui le remplace, pas Argo CD.
