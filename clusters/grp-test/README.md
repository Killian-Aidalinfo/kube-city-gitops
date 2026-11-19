# Cluster `ec-grp-test` — déploiement direct, sans Argo CD

Le cluster d'un groupe d'étudiants : **2 nœuds** DEV1-M, IP de LoadBalancer réservée,
domaine `game.grp-test.lab-cesi.fr`. Tout y est installé à la main avec Helm — pas d'Argo CD,
pour que les groupes voient les commandes.

```bash
export KUBECONFIG=<le kubeconfig du groupe>

helm upgrade --install traefik traefik/traefik -n traefik --create-namespace \
  --version 42.4.1 -f traefik-values.yaml
helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --version v1.21.3 --set crds.enabled=true
kubectl apply -f clusterissuer.yaml

kubectl create namespace kube-city
kubectl -n kube-city create secret generic redis-auth \
  --from-literal=REDIS_PASSWORD="$(openssl rand -hex 16)"
kubectl -n kube-city create secret generic redis-url \
  --from-literal=REDIS_URL="redis://:<ce mot de passe>@kc-redis-master.kube-city.svc.cluster.local:6379"

# Redis en HA à DEUX nœuds : voir ../../redis-lease/
kubectl -n kube-city create configmap kc-redis-promoteur --from-file=../../redis-lease/promoteur.mjs
kubectl apply -f ../../redis-lease/redis-lease.yaml

# Le jeu, depuis le chart du dépôt applicatif à son tag de release
git -C <clone de kube-city> archive v1.1.4 chart/kube-city | tar -x -C /tmp/chart
helm upgrade --install jeu /tmp/chart/chart/kube-city -n kube-city -f kube-city-values.yaml
```

## Ce que deux nœuds changent

* **L'IP du LoadBalancer est réservée** : sans les annotations de `traefik-values.yaml`,
  Scaleway en crée une seconde et le DNS du groupe ne tombe pas dessus.
* **Traefik est un DaemonSet**, pas un Deployment : sous `externalTrafficPolicy: Local`,
  un nœud sans Traefik local jette les paquets qu'il reçoit.
* **Redis n'utilise pas Sentinel** : à deux nœuds, aucun quorum interne à Redis ne survit
  à la perte d'un nœud. L'arbitre est le serveur d'API (voir `../../redis-lease/README.md`).
* `topologySpread.node: DoNotSchedule` fonctionne malgré les deux nœuds : `maxSkew: 1`
  autorise 2/1 pour 3 pods et 3/3 pour 6. Sans lui, le HPA avait empilé **les six pods
  sur un seul nœud**.
