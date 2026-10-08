import http from "node:http";
// backend simulado
http
  .createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/internal/mcp/oauth/register-client") {
        const d = JSON.parse(b || "{}");
        return res.end(
          JSON.stringify({
            client_id: "mcp_test123",
            redirect_uris: d.redirectUris,
            client_id_issued_at: 1,
          }),
        );
      }
      if (req.url === "/internal/mcp/resolve-user") {
        return res.end(
          JSON.stringify({
            userId: "100000000000000000001",
            email: "prueba@ranktitan.ai",
            plan: "paid",
            isSuperAdmin: false,
          }),
        );
      }
      if (req.url === "/internal/mcp/oauth/grant/active") {
        // grantRevocado lo cambia a mitad de la prueba.
        return res.end(
          JSON.stringify(
            global.grantRevocado
              ? { grant: null }
              : {
                  grant: {
                    id: "grant-1",
                    userId: "100000000000000000001",
                    clientId: "mcp_test123",
                    scopes: ["mcp"],
                  },
                },
          ),
        );
      }
      if (req.url === "/internal/mcp/oauth/client")
        return res.end(
          JSON.stringify({
            client: { client_id: "mcp_test123", redirect_uris: ["https://claude.ai/cb"] },
          }),
        );
      res.statusCode = 404;
      res.end("{}");
    });
  })
  .listen(3095);

process.env.PORT = "3091";
process.env.PUBLIC_URL = "http://127.0.0.1:3091";
process.env.RANKTITAN_API_URL = "http://127.0.0.1:3095";
process.env.RANKTITAN_INTERNAL_API_KEY = "x".repeat(20);
process.env.RANKTITAN_API_KEY = "y".repeat(20);
process.env.GOOGLE_CLIENT_ID = "prueba.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "secreto-de-prueba";
process.env.OAUTH_SIGNING_SECRET = "x".repeat(40);
process.env.LOG_LEVEL = "error";
await import("../dist/main.js");
await new Promise((r) => setTimeout(r, 900));

const pedir = async (ruta, opts) => {
  const r = await fetch(`http://127.0.0.1:3091${ruta}`, opts);
  return { status: r.status, body: await r.text() };
};
let f = 0;
const ck = (n, ok, d = "") => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`);
  if (!ok) f++;
};

const meta = await pedir("/.well-known/oauth-authorization-server");
const m = meta.status === 200 ? JSON.parse(meta.body) : {};
ck(
  "publica los metadatos de OAuth",
  meta.status === 200 && !!m.authorization_endpoint,
  m.authorization_endpoint || meta.status,
);
ck("anuncia PKCE S256", (m.code_challenge_methods_supported || []).includes("S256"));
ck("anuncia el registro dinámico", !!m.registration_endpoint);

const prot = await pedir("/.well-known/oauth-protected-resource/mcp");
ck("publica los metadatos del recurso protegido", prot.status === 200, `status=${prot.status}`);

const reg = await pedir("/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] }),
});
ck(
  "acepta el registro de un cliente",
  reg.status === 201 || reg.status === 200,
  `status=${reg.status}`,
);

const aut = await fetch(
  "http://127.0.0.1:3091/authorize?client_id=mcp_test123&response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=abc123def456&code_challenge_method=S256&state=xyz",
  { redirect: "manual" },
);
const loc = aut.headers.get("location") || "";
ck(
  "authorize redirige a Google",
  aut.status === 302 && loc.startsWith("https://accounts.google.com/"),
  loc.slice(0, 52),
);
ck(
  "pide solo identidad, no permisos de negocio",
  loc.includes("openid+email+profile") || loc.includes("openid%20email%20profile"),
);
ck("no filtra el state del cliente a Google", !loc.includes("xyz"));

// El reto del 401 es lo que convierte un conector fallido en un boton de
// Connect: sin el, un cliente no sabe que aqui se puede iniciar sesion y el
// usuario solo ve un error.
const credencialMala = await fetch("http://127.0.0.1:3091/mcp", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-account-key": "rtk_esta_no_existe",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
const reto = credencialMala.headers.get("www-authenticate") || "";
ck("un 401 anuncia donde iniciar sesion", credencialMala.status === 401 && reto.startsWith("Bearer "), `${credencialMala.status} ${reto.slice(0, 40)}`);
ck(
  "el reto apunta al metadata del recurso",
  reto.includes('resource_metadata="http://127.0.0.1:3091/.well-known/oauth-protected-resource/mcp"'),
  reto,
);

// El punto del que dependia todo: un desconocido pidiendo datos privados tiene
// que recibir 401, porque un 200 con una frase amable es "exito" para el
// cliente y nunca llega a ofrecer el login.
const llamar = (nombre, cabeceras = {}) =>
  fetch("http://127.0.0.1:3091/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...cabeceras,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: nombre, arguments: {} },
    }),
  });

const privada = await llamar("list_businesses");
ck(
  "una herramienta privada en anonimo pide entrar",
  privada.status === 401 && (privada.headers.get("www-authenticate") || "").startsWith("Bearer "),
  `status=${privada.status}`,
);

const publica = await llamar("audit_public_business");
ck("una herramienta publica sigue abierta sin cuenta", publica.status === 200, `status=${publica.status}`);

const listar = await fetch("http://127.0.0.1:3091/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
});
ck("conectarse sin cuenta sigue permitido", listar.status === 200, `status=${listar.status}`);

// Lo que hace que cerrar sesion signifique algo: un token perfectamente
// firmado deja de valer en cuanto su autorizacion se revoca, sin esperar a que
// expire. Se firma aqui uno legitimo para poder probarlo sin pasar por Google.
import { createHmac } from "node:crypto";
const firmar = (payload) => {
  const cuerpo = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", "x".repeat(40)).update(cuerpo).digest("base64url");
  return `${cuerpo}.${mac}`;
};
const token = firmar({
  k: "access",
  userId: "100000000000000000001",
  grantId: "grant-1",
  scopes: ["mcp"],
  exp: Math.floor(Date.now() / 1000) + 3600,
  jti: "prueba",
});

const conToken = () =>
  fetch("http://127.0.0.1:3091/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });

global.grantRevocado = false;
const antes = await conToken();
ck("una sesion viva funciona", antes.status === 200, `status=${antes.status}`);

global.grantRevocado = true;
// La cache dura 15s: se espera a que caduque para medir el peor caso real.
await new Promise((r) => setTimeout(r, 16000));
const despues = await conToken();
const retoTrasRevocar = despues.headers.get("www-authenticate") || "";
ck(
  "revocar corta el token sin esperar a que expire",
  despues.status === 401,
  `status=${despues.status}`,
);
// Sin esto el cliente reporta "el servidor dio error" en vez de ofrecer
// volver a entrar: es el parametro por el que sabe que renovar sirve de algo.
ck(
  "y le dice al cliente que vuelva a iniciar sesion",
  retoTrasRevocar.includes('error="invalid_token"'),
  retoTrasRevocar,
);

// Quien no presento nada no recibe esa instruccion: no tiene sesion que renovar.
const sinNada = await fetch("http://127.0.0.1:3091/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "list_businesses", arguments: {} },
  }),
});
const retoSinNada = sinNada.headers.get("www-authenticate") || "";
ck(
  "a quien no presento token no se le dice que renueve",
  sinNada.status === 401 && !retoSinNada.includes("invalid_token"),
  retoSinNada,
);

// El punto donde se rompio todo en produccion: Claude vio invalid_token, fue a
// renovar, y /token respondio 500. Un 500 es "el servidor esta roto" y el
// cliente se rinde; invalid_grant es "ese refresh ya no vale, pide uno nuevo",
// que es lo unico que lo devuelve al login.
const refrescoMuerto = firmar({
  k: "refresh",
  userId: "100000000000000000001",
  grantId: "grant-1",
  scopes: ["mcp"],
  exp: Math.floor(Date.now() / 1000) + 3600,
  jti: "refresh-prueba",
});
global.grantRevocado = true;
const renovar = await fetch("http://127.0.0.1:3091/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refrescoMuerto,
    client_id: "mcp_test123",
  }).toString(),
});
const cuerpoRenovar = await renovar.json().catch(() => ({}));
ck(
  "renovar con un grant revocado no es un 500",
  renovar.status !== 500,
  `status=${renovar.status}`,
);
ck(
  "sino invalid_grant, que manda al cliente a iniciar sesion",
  cuerpoRenovar.error === "invalid_grant",
  JSON.stringify(cuerpoRenovar).slice(0, 90),
);

// Detras de un proxy, sin trust proxy, Express ve la IP del proxy y TODO el
// trafico anonimo cae en el mismo cubo del limitador: el primero que llegue se
// lo gasta y el resto recibe 429. No se nota hasta que hay publico.
const conIpFalsa = (ip) =>
  fetch("http://127.0.0.1:3091/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list" }),
  });
const unaIp = await conIpFalsa("203.0.113.9");
const otraIp = await conIpFalsa("198.51.100.7");
ck(
  "distingue clientes por su IP real tras el proxy",
  unaIp.status === 200 && otraIp.status === 200,
  `${unaIp.status} / ${otraIp.status}`,
);

console.log(f === 0 ? "\nTODO OK" : `\n${f} FALLO(S)`);
process.exit(f === 0 ? 0 : 1);
