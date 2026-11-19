#!/usr/bin/env bash
# Amorçage complet d'un cluster neuf pour Kube City.
# Rejouable : chaque étape est un « upgrade --install ».
#
#   export KUBECONFIG=~/.kube/bastion/par-killian-test.yaml
#   ./bootstrap/bootstrap.sh
#
# Ce que le script NE fait pas (volontairement) :
#   - créer les enregistrements DNS : il affiche l'IP, à vous de pointer les noms dessus ;
#   - créer le Secret redis-auth : un mot de passe ne se range pas dans un dépôt public.
set -euo pipefail
cd "$(dirname "$0")/.."

TRAEFIK_VERSION=42.4.1
CERT_MANAGER_VERSION=v1.21.3
ARGOCD_VERSION=10.18.1

helm repo add traefik https://traefik.github.io/charts >/dev/null
helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo add argo https://argoproj.github.io/argo-helm >/dev/null
helm repo update >/dev/null

echo "== 1/4 Traefik (contrôleur d'Ingress) =="
helm upgrade --install traefik traefik/traefik -n traefik --create-namespace \
  --version "$TRAEFIK_VERSION" -f bootstrap/traefik-values.yaml --wait --timeout 6m

echo "== IP publique du LoadBalancer =="
kubectl -n traefik get svc traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}'; echo
echo "   -> faites pointer kube-city.<domaine> et argocd.<domaine> sur cette IP, puis continuez."

echo "== 2/4 cert-manager (certificats Let's Encrypt) =="
helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --version "$CERT_MANAGER_VERSION" --set crds.enabled=true \
  --set resources.requests.cpu=20m --set resources.requests.memory=64Mi --wait --timeout 6m
kubectl apply -f bootstrap/cert-manager-clusterissuer.yaml

echo "== 3/4 Argo CD (moteur GitOps) =="
helm upgrade --install argocd argo/argo-cd -n argocd --create-namespace \
  --version "$ARGOCD_VERSION" -f bootstrap/argocd-values.yaml --wait --timeout 8m

echo "== 4/4 Application racine =="
kubectl get namespace kube-city >/dev/null 2>&1 || kubectl create namespace kube-city
if ! kubectl -n kube-city get secret redis-auth >/dev/null 2>&1; then
  echo "!! Secret redis-auth absent. Créez-le avant de continuer :"
  echo "   kubectl -n kube-city create secret generic redis-auth \\"
  echo "     --from-literal=REDIS_PASSWORD=\"\$(openssl rand -hex 16)\""
  exit 1
fi
kubectl apply -f apps/root.yaml

echo
echo "Fini. Mot de passe admin d'Argo CD :"
echo "  kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
