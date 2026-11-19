// Promoteur Redis : décide qui est le maître, en s'appuyant sur un Lease Kubernetes.
//
// Pourquoi : à deux nœuds, aucun quorum INTERNE à Redis ne peut survivre à la perte
// d'un nœud (on perd toujours la moitié des votants). L'arbitre doit donc être
// ailleurs. Sur Kapsule, le serveur d'API tourne sur le plan de contrôle managé,
// hors de nos nœuds : c'est lui l'arbitre, et il survit à la perte de n'importe
// lequel d'entre eux.
//
// Un exemplaire tourne dans chaque pod Redis, en conteneur voisin :
//   - il tient (ou prend) le Lease « redis-master » ;
//   - le détenteur rend son Redis local maître et porte le label redis-role=master ;
//   - les autres suivent le détenteur (REPLICAOF) et retirent leur label.
// Le Service « …-master » a pour sélecteur ce label : il suit le maître tout seul.
//
// Pas de dépendance npm : protocole RESP et API Kubernetes écrits à la main.
import net from "node:net";
import https from "node:https";
import fs from "node:fs";

const NS = process.env.POD_NAMESPACE;
const ME = process.env.POD_NAME;                       // ex. kc-redis-0
// L'identité porte l'UID du pod, pas seulement son nom : un StatefulSet recrée
// kc-redis-1 SOUS LE MÊME NOM, et sans cela le pod redémarré se reconnaîtrait
// détenteur du bail. Il redeviendrait maître avec des données potentiellement en
// retard, et le réplica à jour se resynchroniserait sur lui — donc perdrait tout.
const INSTANCE = `${process.env.POD_NAME}#${process.env.POD_UID}`;
const HEADLESS = process.env.HEADLESS_SERVICE;         // ex. kc-redis
const LEASE = process.env.LEASE_NAME || "redis-master";
// Surtout pas REDIS_PORT : Kubernetes injecte une variable de ce nom pour tout
// Service nommé « redis » du namespace, et sa valeur est « tcp://10.x.x.x:6379 ».
// Le « || 6379 » rattrape aussi un NaN, pas seulement une variable absente.
const PORT = Number(process.env.PROMOTEUR_REDIS_PORT) || 6379;
const PASSWORD = process.env.REDIS_PASSWORD || "";
const TICK_MS = Number(process.env.TICK_MS || 2000);
const LEASE_SECONDS = Number(process.env.LEASE_SECONDS || 10);

const DEMARRE_A = Date.now();
const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const TOKEN = fs.readFileSync(`${SA}/token`, "utf8").trim();
const CA = fs.readFileSync(`${SA}/ca.crt`);
const host = (pod) => `${pod}.${HEADLESS}.${NS}.svc.cluster.local`;
// Les dates d'un Lease sont des MicroTime : l'API exige SIX décimales et refuse
// (HTTP 400) les trois que produit toISOString().
const microTime = (d = new Date()) => d.toISOString().replace("Z", "000Z");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- Redis (RESP)
// Un aller-retour par commande : le promoteur en envoie une poignée toutes les 2 s,
// garder une connexion ouverte coûterait plus cher à surveiller qu'à rouvrir.
function redis(...commands) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port: PORT, timeout: 2000 });
    const all = PASSWORD ? [["AUTH", PASSWORD], ...commands] : commands;
    let buf = "";
    const replies = [];
    sock.on("connect", () => sock.write(all.map(encode).join("")));
    sock.on("data", (d) => {
      buf += d.toString("binary");
      let r;
      while ((r = decode(buf)) !== null) {
        replies.push(r.value);
        buf = buf.slice(r.length);
        if (replies.length === all.length) { sock.end(); resolve(PASSWORD ? replies.slice(1) : replies); return; }
      }
    });
    sock.on("timeout", () => { sock.destroy(); reject(new Error("redis: délai dépassé")); });
    sock.on("error", reject);
  });
}
const encode = (args) =>
  `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join("");

// Renvoie { value, length } ou null si la réponse n'est pas encore complète.
function decode(s) {
  if (!s) return null;
  const end = s.indexOf("\r\n");
  if (end < 0) return null;
  const head = s.slice(1, end);
  const after = end + 2;
  switch (s[0]) {
    case "+": case "-": case ":":
      return { value: head, length: after };
    case "$": {
      const n = Number(head);
      if (n === -1) return { value: null, length: after };
      if (s.length < after + n + 2) return null;
      return { value: s.slice(after, after + n), length: after + n + 2 };
    }
    case "*": {                                    // ROLE répond un tableau
      const n = Number(head);
      if (n === -1) return { value: null, length: after };
      const arr = [];
      let off = after;
      for (let i = 0; i < n; i++) {
        const r = decode(s.slice(off));
        if (r === null) return null;               // réponse encore incomplète
        arr.push(r.value);
        off += r.length;
      }
      return { value: arr, length: off };
    }
    default:
      return { value: head, length: after };
  }
}

// ------------------------------------------------------- API Kubernetes (HTTPS)
function api(method, path, body, contentType) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: "kubernetes.default.svc", port: 443, path, method, ca: CA, timeout: 4000,
        headers: {
          authorization: `Bearer ${TOKEN}`, accept: "application/json",
          ...(data ? { "content-type": contentType || "application/json", "content-length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (d) => (out += d));
        res.on("end", () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("api: délai dépassé")); });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const leasePath = `/apis/coordination.k8s.io/v1/namespaces/${NS}/leases/${LEASE}`;

function leaseBody(holder, { acquireTime, renewTime, transitions, resourceVersion }) {
  return {
    apiVersion: "coordination.k8s.io/v1", kind: "Lease",
    metadata: { name: LEASE, namespace: NS, ...(resourceVersion ? { resourceVersion } : {}) },
    spec: {
      holderIdentity: holder, leaseDurationSeconds: LEASE_SECONDS,
      acquireTime, renewTime, leaseTransitions: transitions,
    },
  };
}

// Rend le nom du pod qui DOIT être maître, ou null si on n'a pas pu trancher.
// Toute écriture passe par resourceVersion : si deux pods tentent en même temps,
// l'API en refuse un (409). C'est là qu'est l'arbitrage, et nulle part ailleurs.
async function elire() {
  const now = microTime();
  const got = await api("GET", leasePath);

  if (got.status === 404) {
    const created = await api("POST", `/apis/coordination.k8s.io/v1/namespaces/${NS}/leases`,
      leaseBody(INSTANCE, { acquireTime: now, renewTime: now, transitions: 0 }));
    if (created.status < 300) { log(`bail créé par ${ME}`); return INSTANCE; }
    log(`création du bail refusée : HTTP ${created.status} ${created.body?.message || ""}`);
    return null;
  }
  if (got.status >= 300) throw new Error(`lease: HTTP ${got.status}`);

  const spec = got.body.spec || {};
  const rv = got.body.metadata.resourceVersion;

  if (spec.holderIdentity === INSTANCE) {
    const renewed = await api("PUT", leasePath,
      leaseBody(INSTANCE, { acquireTime: spec.acquireTime, renewTime: now, transitions: spec.leaseTransitions || 0, resourceVersion: rv }));
    if (renewed.status < 300) return INSTANCE;
    log(`renouvellement refusé : HTTP ${renewed.status} ${renewed.body?.message || ""}`);
    return null;                               // 409 : on a perdu la main entre-temps
  }

  // Tronqué aux millisecondes : Date ne garantit pas la lecture de 6 décimales.
  const expireLe = new Date(String(spec.renewTime).replace(/(\.\d{3})\d*/, "$1")).getTime() + (spec.leaseDurationSeconds || LEASE_SECONDS) * 1000;
  if (Date.now() < expireLe) return spec.holderIdentity;   // le bail court toujours

  // Un pod qui vient de démarrer laisse passer un cycle de bail complet avant de
  // réclamer la main : si l'autre est vivant et à jour, il l'aura prise d'ici là,
  // et ce pod deviendra son réplica. C'est ce qui évite qu'un Redis redémarré,
  // donc possiblement en retard, s'impose comme maître.
  if (Date.now() - DEMARRE_A < (LEASE_SECONDS + 2) * 1000) {
    log("bail expiré mais je viens de démarrer : je laisse la main à l'autre");
    return spec.holderIdentity;
  }

  const pris = await api("PUT", leasePath,
    leaseBody(INSTANCE, { acquireTime: now, renewTime: now, transitions: (spec.leaseTransitions || 0) + 1, resourceVersion: rv }));
  if (pris.status < 300) {
    log(`bail expiré : ${ME} prend la main (ancien détenteur ${String(spec.holderIdentity).split("#")[0]})`);
    return INSTANCE;
  }
  log(`prise du bail refusée : HTTP ${pris.status} (un autre a été plus rapide ?)`);
  return null;
}

// Quand ce pod devient maître, il retire le label « master » des autres. Sans
// cela, un pod resté sur un nœud MORT garde son label (Kubernetes le laisse
// « Running » cinq minutes) et le Service du maître enverrait la moitié des
// écritures dans le vide. Le patch, lui, aboutit tout de suite : il passe par
// l'API, pas par le nœud en panne.
async function degraderLesAutres() {
  const res = await api("GET", `/api/v1/namespaces/${NS}/pods?labelSelector=app%3Dkc-redis%2Credis-role%3Dmaster`);
  if (res.status >= 300) { log(`liste des pods refusée : HTTP ${res.status}`); return; }
  for (const pod of res.body.items || []) {
    if (pod.metadata.name === ME) continue;
    const r = await api("PATCH", `/api/v1/namespaces/${NS}/pods/${pod.metadata.name}`,
      { metadata: { labels: { "redis-role": "replica" } } }, "application/merge-patch+json");
    log(`label master retiré à ${pod.metadata.name} : HTTP ${r.status}`);
  }
}

let dernierLabel = null;
async function etiqueter(role) {
  if (role === dernierLabel) return;
  const res = await api("PATCH", `/api/v1/namespaces/${NS}/pods/${ME}`,
    { metadata: { labels: { "redis-role": role } } }, "application/merge-patch+json");
  if (res.status < 300) { dernierLabel = role; log(`label redis-role=${role}`); }
  else log(`pose du label refusée : HTTP ${res.status} ${res.body?.message || ""}`);
}

async function boucle() {
  let maitre;
  try {
    maitre = await elire();
  } catch (e) {
    // L'API est injoignable : on ne touche à RIEN. Un pod isolé du réseau ne peut
    // donc jamais se promouvoir — c'est ce qui écarte le split-brain.
    log(`arbitre injoignable (${e.message}) : on ne change rien`);
    return;
  }
  if (!maitre) return;
  const maitrePod = String(maitre).split("#")[0];   // « kc-redis-1#<uid> » -> « kc-redis-1 »

  // ROLE renvoie un tableau dont le premier élément est « master » ou « slave ».
  const [reponse] = await redis(["ROLE"]);
  const role = Array.isArray(reponse) ? reponse[0] : reponse;
  if (maitre === INSTANCE) {
    if (role !== "master") { await redis(["REPLICAOF", "NO", "ONE"]); log("promu maître"); }
    const etaitDejaMaitre = dernierLabel === "master";
    await etiqueter("master");
    if (!etaitDejaMaitre) await degraderLesAutres();
  } else if (maitrePod === ME) {
    // Le bail est à une AUTRE vie de ce même pod (nom identique, UID différent) :
    // se répliquer sur soi-même n'a aucun sens, on attend que le bail expire.
    log("le bail appartient à une instance précédente de ce pod : j'attends son expiration");
  } else {
    const [info] = await redis(["INFO", "replication"]);
    const suitDeja = role === "slave" && info.includes(`master_host:${host(maitrePod)}`);
    if (!suitDeja) { await redis(["REPLICAOF", host(maitrePod), String(PORT)]); log(`suit désormais ${maitrePod}`); }
    await etiqueter("replica");
  }
}

log(`promoteur démarré : instance ${INSTANCE}, bail « ${LEASE} » de ${LEASE_SECONDS} s, tic ${TICK_MS} ms`);
setInterval(() => boucle().catch((e) => log(`erreur : ${e.message}`)), TICK_MS);
