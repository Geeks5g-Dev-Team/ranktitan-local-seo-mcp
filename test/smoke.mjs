// Arranca un backend falso de Rank Titan y el servidor MCP, y habla JSON-RPC real.
import http from "node:http";

const FAKE_PORT = 3099;
const MCP_PORT = 3098;
const KEY = "rt_test_key_0123456789abcdef";
const KEY_PAGO = "rt_test_key_paid_0123456789abc";

let patchRecibido = null;
let heatmapConsultas = 0;
let ultimoResultBody = null;
const auditadas = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/internal/mcp/public/business") {
      return res.end(
        JSON.stringify({
          business: {
            placeId: "p1",
            name: "Castle Lock Co.",
            address: "Eastbourne",
            primaryCategory: "Locksmith",
            website: null,
            phone: "(818) 555-0100",
            rating: 4.9,
            reviewCount: 1096,
            hasHours: true,
            status: "OPERATIONAL",
            mapsUri: "https://maps.google.com/?cid=1",
          },
        }),
      );
    }
    if (req.url === "/internal/mcp/public/competitors") {
      return res.end(
        JSON.stringify({
          competitors: [
            {
              placeId: "c1",
              name: "Castle Lock Co.",
              address: "Eastbourne",
              rating: 4.9,
              reviewCount: 1096,
            },
            {
              placeId: "c2",
              name: "Riverside Keys",
              address: "Eastbourne",
              rating: 4.8,
              reviewCount: 50,
            },
          ],
        }),
      );
    }
    if (req.url === "/internal/mcp/usage") {
      const { userId } = JSON.parse(body || "{}");
      const suma = (c) =>
        auditadas
          .filter((a) => a.userId === userId && a.counter === c && a.status === "ok")
          .reduce((t, a) => t + (a.cost || 0), 0);
      return res.end(
        JSON.stringify({ heatmaps: suma("heatmaps"), review_replies: suma("review_replies") }),
      );
    }
    if (req.url === "/internal/mcp/tool-call") {
      auditadas.push(JSON.parse(body || "{}"));
      return res.end(JSON.stringify({ recorded: true }));
    }
    if (req.url === "/internal/mcp/resolve-api-key") {
      const { apiKey } = JSON.parse(body || "{}");
      if (apiKey === KEY_PAGO) {
        // userId distinto del gratuito a proposito: la cuota se lleva por
        // usuario, y compartir id hacia que el gasto de uno se cobrara al otro.
        return res.end(
          JSON.stringify({ userId: "u-pago", email: "pago@ranktitan.ai", plan: "paid" }),
        );
      }
      if (apiKey !== KEY) {
        res.statusCode = 404;
        return res.end("{}");
      }
      return res.end(JSON.stringify({ userId: "u-123", email: "demo@ranktitan.ai", plan: "free" }));
    }
    if (req.url.startsWith("/businesses/user/")) {
      return res.end(
        // Formato real del backend: { data, meta }, no un array suelto.
        JSON.stringify({
          meta: { total: 2, page: 1 },
          data: [
            {
              locationId: "10000000000000000022",
              name: "Northgate Lock & Key",
              active: true,
              gmbPlanType: "premium",
              gmbData: {
                websiteUri: "https://example.com",
                storefrontAddress: { addressLines: ["123 Hillhurst Ave"] },
              },
            },
            {
              locationId: "10000000000000000011",
              name: "Harbour Street Locksmiths",
              active: true,
              gmbPlanType: "premium",
              gmbData: {},
            },
          ],
        }),
      );
    }
    if (req.url.startsWith("/reviews/") && req.method === "PATCH") {
      patchRecibido = { url: req.url, body: JSON.parse(body || "{}") };
      return res.end(
        JSON.stringify({ id: "rev-1", replyContent: patchRecibido.body.replyContent }),
      );
    }
    if (req.url.startsWith("/reviews/") && req.method === "GET") {
      const id = req.url.split("/").pop();
      if (id === "rev-1")
        return res.end(JSON.stringify({ id: "rev-1", locationId: "10000000000000000011" }));
      if (id === "rev-ajena")
        return res.end(JSON.stringify({ id: "rev-ajena", locationId: "99999999999999999999" }));
      res.statusCode = 404;
      return res.end("{}");
    }
    if (req.url.startsWith("/reviews?")) {
      // Campos reales del modelo Review, no inventados.
      return res.end(
        JSON.stringify([
          {
            id: "rev-1",
            locationId: "10000000000000000011",
            reviewContent: "Fast and friendly, fixed my screen in an hour.",
            stars: 5,
            author: "Ana P.",
            createdAt: "2026-09-30T10:00:00.000Z",
            reviewUrl: "https://g.co/r/1",
          },
          {
            id: "rev-2",
            locationId: "10000000000000000011",
            reviewContent: "Waited too long.",
            stars: 2,
            author: "Luis M.",
            createdAt: "2026-09-29T10:00:00.000Z",
            reviewUrl: "https://g.co/r/2",
          },
        ]),
      );
    }
    if (req.url === "/internal/mcp/heatmap/start") {
      // Un negocio sin coordenadas: rechazo con motivo, no un 500.
      if ((JSON.parse(body || "{}").locationId || "") === "10000000000000000022") {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            message:
              "Northgate Lock & Key has no map coordinates stored yet, so a grid cannot be centred on it.",
            statusCode: 400,
          }),
        );
      }
      return res.end(JSON.stringify({ scan: { taskId: "task-1", previousReportId: "rep-41" } }));
    }
    if (req.url === "/internal/mcp/heatmap/result") {
      ultimoResultBody = JSON.parse(body || "{}");
      // Primero pendiente, despues completado: es el caso real, y el unico
      // que prueba que la herramienta no se queda colgada esperando.
      heatmapConsultas += 1;
      const pedida = (ultimoResultBody && ultimoResultBody.keyword) || null;
      // El reporte solo conoce "emergency plumber": pedir otra es "todavia no".
      if (pedida && pedida !== "emergency plumber") {
        return res.end(
          JSON.stringify({
            result: {
              reportId: "",
              reportUrl: "https://heatmap-front.example/reports/loc?by=location_id",
              keyword: pedida,
              businessName: "Harbour Street Locksmiths",
              state: "pending",
              averageRank: null,
              gridPoints: 0,
              highRelevance: 0,
              mediumRelevance: 0,
              lowRelevance: 0,
              competitors: [],
            },
          }),
        );
      }
      const base = {
        reportId: "rep-42",
        reportUrl: "https://heatmap-front.example/reports/rep-42",
        keyword: "emergency plumber",
        businessName: "Harbour Street Locksmiths",
      };
      if (heatmapConsultas < 2) {
        return res.end(
          JSON.stringify({
            result: {
              ...base,
              state: "pending",
              averageRank: null,
              gridPoints: 0,
              highRelevance: 0,
              mediumRelevance: 0,
              lowRelevance: 0,
              competitors: [],
            },
          }),
        );
      }
      return res.end(
        JSON.stringify({
          result: {
            ...base,
            state: "completed",
            averageRank: 4.2,
            gridPoints: 19,
            highRelevance: 11,
            mediumRelevance: 5,
            lowRelevance: 3,
            competitors: [
              { name: "Castle Lock Co.", score: 1200, reviews: 1098, rating: 4.9 },
              { name: "Riverside Keys", score: 900, reviews: 52, rating: 4.8 },
              { name: "Beacon Locksmiths", score: 400, reviews: 31, rating: 5 },
            ],
          },
        }),
      );
    }
    if (req.url.startsWith("/scored-keywords/by-location/")) {
      // Un negocio cuyo job de ranking nunca completo: tiene keywords y ni una
      // posicion. Pasa con cada negocio nuevo, asi que la salida importa.
      if (req.url.includes("10000000000000000022")) {
        return res.end(
          JSON.stringify([
            { keyword: "coffee shop eastbourne", score: 20, rankingStatus: "failed" },
            { keyword: "desayunos cerca de mi", score: 20, rankingStatus: "failed" },
          ]),
        );
      }
      return res.end(
        JSON.stringify([
          {
            keyword: "locksmith harbour street",
            score: 3.7,
            rankingStatus: "ranked",
            updatedAt: "2026-09-11T20:17:06.624Z",
          },
          {
            keyword: "car key replacement",
            score: 18.4,
            rankingStatus: "ranked",
            updatedAt: "2026-10-04T22:01:52.415Z",
          },
          {
            keyword: "emergency locksmith",
            score: 20,
            rankingStatus: "ranked",
            updatedAt: "2026-09-30T10:00:00.000Z",
          },
          { keyword: "rekey locks", score: 20, rankingStatus: "failed" },
        ]),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
});

await new Promise((r) => fake.listen(FAKE_PORT, r));

// Every variable the config requires, set explicitly and AFTER wiping anything
// a local .env may have supplied. Without the wipe this suite passes on a
// developer's machine and fails in CI, which is exactly how it failed: the
// local .env was quietly covering a variable the test never set.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("RANKTITAN_") || key.startsWith("QUOTA_") || key === "NODE_ENV") {
    delete process.env[key];
  }
}

process.env.PORT = String(MCP_PORT);
process.env.PUBLIC_URL = `http://127.0.0.1:${MCP_PORT}`;
process.env.RANKTITAN_API_URL = `http://127.0.0.1:${FAKE_PORT}`;
process.env.RANKTITAN_INTERNAL_API_KEY = "internal-key-for-tests-0000";
process.env.RANKTITAN_API_KEY = "api-key-for-tests-0000";
process.env.QUOTA_STORE = "ranktitan";
// Sin fijar las de respuestas: se prueba lo que de verdad se envia, que es
// "gratis en todos los planes". Fijarlas aqui hacia que el test siguiera
// pasando mientras el producto decia lo contrario.
process.env.LOG_LEVEL = "warn";
await import("../dist/main.js");
await new Promise((r) => setTimeout(r, 600));

const SIN_AUTH = Symbol("sin-auth");
const rpc = async (method, params, auth = `Bearer ${KEY}`, cabecera = "authorization") => {
  const res = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // Omitir la cabecera de verdad: pasar undefined activaría el valor por defecto.
      ...(auth === SIN_AUTH
        ? {}
        : cabecera === "x-account-key"
          ? { "x-account-key": auth }
          : { authorization: auth }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return {
    status: res.status,
    body: line ? JSON.parse(line.slice(6)) : text ? JSON.parse(text) : null,
  };
};

let fallos = 0;
const check = (nombre, ok, detalle = "") => {
  console.log(`${ok ? "✅" : "❌"} ${nombre}${detalle ? " — " + detalle : ""}`);
  if (!ok) fallos++;
};

// 1. Sin credencial
const sinAuth = await rpc("tools/list", {}, SIN_AUTH);
check(
  "sin credencial: entra como anónimo, no 401",
  sinAuth.status === 200,
  `status=${sinAuth.status}`,
);

// 2. Credencial inválida
const mala = await rpc("tools/list", {}, "Bearer rt_clave_que_no_existe_000000");
check(
  "una credencial INVÁLIDA sí da 401 (no se degrada en silencio)",
  mala.status === 401,
  `status=${mala.status}`,
);

// 3. Handshake
const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1" },
});
check(
  "handshake MCP",
  init.body?.result?.serverInfo?.name === "ranktitan-local-seo",
  init.body?.result?.serverInfo?.name,
);

// 4. Lista de herramientas
const tools = await rpc("tools/list", {});
const nombres = (tools.body?.result?.tools ?? []).map((t) => t.name).sort();
// El directorio de Claude rechaza automaticamente cualquier herramienta sin
// title y sin readOnlyHint/destructiveHint. Ademas es lo que permite a un
// cliente preguntar antes de publicar en el perfil publico de un cliente.
const sinAnotar = (tools.body?.result?.tools ?? []).filter(
  (t) => !t.annotations || typeof t.annotations.readOnlyHint !== "boolean" || !t.title,
);
check(
  "todas las herramientas vienen anotadas",
  sinAnotar.length === 0,
  sinAnotar.map((t) => t.name).join(", "),
);

// El directorio lee annotations.title, no el title de al lado, y marca la
// herramienta aunque tenga uno.
const sinTituloAnotado = (tools.body?.result?.tools ?? []).filter((t) => !t.annotations?.title);
check(
  "el titulo va tambien dentro de las anotaciones",
  sinTituloAnotado.length === 0,
  sinTituloAnotado.map((t) => t.name).join(", "),
);

const publicar = (tools.body?.result?.tools ?? []).find((t) => t.name === "post_review_reply");
check(
  "publicar una respuesta se marca destructiva",
  publicar?.annotations?.readOnlyHint === false && publicar?.annotations?.destructiveHint === true,
  JSON.stringify(publicar?.annotations),
);

check(
  "expone las 10 herramientas",
  nombres.length === 10 &&
    nombres.includes("audit_public_business") &&
    nombres.includes("get_local_heatmap") &&
    nombres.includes("get_heatmap_result"),
  nombres.join(", "),
);

// 4b. Cerrar sesion con una API key no borra la key: no es una sesion.
const salirConKey = await rpc("tools/call", { name: "sign_out", arguments: {} });
const salirKeyText = salirConKey.body?.result?.content?.[0]?.text ?? "";
check(
  "sign_out con API key explica que no hay sesion",
  salirKeyText.includes("API key") && salirKeyText.includes("no session"),
  salirKeyText.slice(0, 60),
);

// 4c. Sin credencial no hay nada que cerrar, y lo dice en vez de fallar.
const salirAnonimo = await rpc("tools/call", { name: "sign_out", arguments: {} }, SIN_AUTH);
const salirAnonText = salirAnonimo.body?.result?.content?.[0]?.text ?? "";
check(
  "sign_out sin sesion lo dice, no falla",
  salirAnonimo.status === 200 && salirAnonText.includes("already signed out"),
  `status=${salirAnonimo.status} ${salirAnonText.slice(0, 40)}`,
);

// 5. list_businesses
const lb = await rpc("tools/call", { name: "list_businesses", arguments: {} });
const lbText = lb.body?.result?.content?.[0]?.text ?? "";
check(
  "list_businesses devuelve tabla Markdown",
  lbText.includes("| Business |") && lbText.includes("Northgate Lock & Key"),
);

// 6. Rankings
const kr = await rpc("tools/call", {
  name: "get_keyword_rankings",
  arguments: { location_id: "10000000000000000011" },
});
const krText = kr.body?.result?.content?.[0]?.text ?? "";
check(
  "rankings ordenados, mejor primero",
  krText.indexOf("locksmith harbour street") < krText.indexOf("car key replacement"),
);
check(
  "distingue 'failed' de medido",
  krText.includes("waiting to be measured"),
  krText.split("\n").pop(),
);
// Una posicion guardada sin fecha se lee como la de hoy, y pueden ser de hace
// un mes. Se toma la mas reciente del conjunto.
check(
  "dice cuando se midio, con la fecha mas reciente",
  krText.includes("last on 2026-10-04"),
  krText.split("\n")[0],
);

// 6b. Sin ninguna medida: tiene keywords, no tiene posiciones. Decir "0
// medidas" sobre una tabla vacia se lee como "no tiene keywords".
const krVacio = await rpc("tools/call", {
  name: "get_keyword_rankings",
  arguments: { location_id: "10000000000000000022" },
});
const krVacioText = krVacio.body?.result?.content?.[0]?.text ?? "";
check(
  "sin medidas dice que SI hay keywords",
  krVacioText.includes("tracks 2 keywords") && krVacioText.includes("coffee shop eastbourne"),
  krVacioText.split("\n")[0],
);
check(
  "y no imprime una tabla vacia",
  !krVacioText.includes("| Keyword |"),
  krVacioText.slice(0, 40),
);

// 7. SEGURIDAD: negocio ajeno
const ajeno = await rpc("tools/call", {
  name: "get_keyword_rankings",
  arguments: { location_id: "99999999999999999999" },
});
const ajenoText = ajeno.body?.result?.content?.[0]?.text ?? "";
check(
  "bloquea un locationId ajeno",
  ajeno.body?.result?.isError === true && ajenoText.includes("not in this Rank Titan account"),
  ajenoText.slice(0, 60),
);

// 8. Entrada inválida
const malInput = await rpc("tools/call", { name: "get_keyword_rankings", arguments: {} });
check(
  "rechaza entrada sin location_id",
  malInput.body?.result?.isError === true || !!malInput.body?.error,
);

// 9. Auditoría de perfil
const au = await rpc("tools/call", {
  name: "audit_business_profile",
  arguments: { location_id: "10000000000000000022" },
});
const auText = au.body?.result?.content?.[0]?.text ?? "";
check(
  "audit_business_profile puntúa el perfil",
  auText.includes("profile score") && auText.includes("Primary category"),
);

// 10. Reseñas pendientes — comprueba que el mapeo usa los campos REALES
const fr = await rpc("tools/call", {
  name: "fetch_pending_reviews",
  arguments: { location_id: "10000000000000000011", limit: 5 },
});
const frText = fr.body?.result?.content?.[0]?.text ?? "";
check(
  "fetch_pending_reviews mapea los campos reales",
  frText.includes("Ana P.") && frText.includes("fixed my screen"),
  frText.split("\n")[0],
);
check("destaca las reseñas de 3 estrellas o menos", frText.includes("rated 3 stars or lower"));

// 11. Publicar respuesta
// Responder desde el chat es gratis en todos los planes: es el momento en que
// alguien prueba el producto. Lo que se cobra es la automatizacion.
const prFree = await rpc("tools/call", {
  name: "post_review_reply",
  arguments: { review_id: "rev-1", reply_text: "Gracias Ana, nos alegra haberte ayudado rápido." },
});
const prFreeText = prFree.body?.result?.content?.[0]?.text ?? "";
check(
  "plan gratuito: publica, no se le bloquea",
  prFreeText.includes("Reply published") && patchRecibido !== null,
  prFreeText.slice(0, 70),
);
// El precio aparece DESPUES de que funciono, como oferta y no como peaje.
check(
  "y le ofrece automatizar, despues de publicar",
  prFreeText.indexOf("Reply published") < prFreeText.indexOf("ranktitan.ai/pricing"),
  prFreeText.split("\n").pop(),
);
patchRecibido = null;

// Plan de pago: publica de verdad.
const pr = await rpc(
  "tools/call",
  {
    name: "post_review_reply",
    arguments: {
      review_id: "rev-1",
      reply_text: "Gracias Ana, nos alegra haberte ayudado rápido.",
    },
  },
  `Bearer ${KEY_PAGO}`,
);
check(
  "al plan de pago no se le vende lo que ya pago",
  !(pr.body?.result?.content?.[0]?.text ?? "").includes("paid plans"),
  (pr.body?.result?.content?.[0]?.text ?? "").slice(-70),
);
check(
  "plan de pago: publica",
  (pr.body?.result?.content?.[0]?.text ?? "").includes("Reply published"),
  (pr.body?.result?.content?.[0]?.text ?? "").slice(0, 80),
);
check(
  "envía PATCH /reviews/:id con replyContent",
  patchRecibido?.url === "/reviews/rev-1" && typeof patchRecibido?.body?.replyContent === "string",
  patchRecibido?.url,
);

// 12. SEGURIDAD: responder a una reseña de otro negocio
patchRecibido = null;
const pa = await rpc("tools/call", {
  name: "post_review_reply",
  arguments: { review_id: "rev-ajena", reply_text: "Texto cualquiera para la prueba." },
});
check(
  "bloquea responder a una reseña ajena",
  pa.body?.result?.isError === true && patchRecibido === null,
  "no se envió ningún PATCH",
);

// 13. Texto demasiado corto
const pc = await rpc("tools/call", {
  name: "post_review_reply",
  arguments: { review_id: "rev-1", reply_text: "ok" },
});
check(
  "rechaza una respuesta demasiado corta",
  pc.body?.result?.isError === true || !!pc.body?.error,
);

// 14. Auditoría: toda llamada deja rastro, también las rechazadas
const deLista = auditadas.filter((a) => a.tool === "list_businesses");
check(
  "audita una llamada gratuita con coste 0",
  deLista.length > 0 && deLista[0].cost === 0 && deLista[0].status === "ok",
);

const rechazadas = auditadas.filter((a) => a.status === "refused");
check("audita los rechazos", rechazadas.length >= 2, `${rechazadas.length} rechazos registrados`);
check(
  "un rechazo nunca cobra",
  rechazadas.every((a) => (a.cost || 0) === 0),
);

// 12. Heatmap: la rejilla arranca pendiente y la herramienta espera a que
// termine en vez de devolver un enlace y ya.
const hm = await rpc(
  "tools/call",
  {
    name: "get_local_heatmap",
    arguments: { location_id: "10000000000000000011", keyword: "emergency plumber" },
  },
  `Bearer ${KEY_PAGO}`,
);
const hmText = hm.body?.result?.content?.[0]?.text ?? "";
check(
  "el heatmap espera a que la rejilla termine",
  hmText.includes("Average position") && !hmText.includes("still running"),
  hmText.split("\n")[0],
);
check(
  "resume la cobertura y donde flojea",
  hmText.includes("Strong coverage") && hmText.includes("weak or missing from 8"),
  hmText.split("\n").find((l) => l.includes("weak or missing")) ?? hmText.slice(0, 60),
);
// Lo que Daniel pidio explicitamente: los 3 competidores locales.
check(
  "nombra a los competidores que se quedan el espacio",
  hmText.includes("Who else holds this search") && hmText.includes("Castle Lock Co."),
  hmText.split("\n").find((l) => l.includes("Prime")) ?? "",
);
check("y enlaza el mapa publico", hmText.includes("reports/rep-42"));

// La regla que Daniel escribio letra por letra: 1 gratis, y despues el mensaje
// con el enlace de pago. Es el unico punto del embudo donde se cobra algo.
const argsHm = { location_id: "10000000000000000011", keyword: "emergency plumber" };
const hmGratis1 = await rpc("tools/call", { name: "get_local_heatmap", arguments: argsHm });
check(
  "plan gratuito: el primer heatmap corre",
  (hmGratis1.body?.result?.content?.[0]?.text ?? "").includes("Average position"),
  (hmGratis1.body?.result?.content?.[0]?.text ?? "").slice(0, 50),
);
const hmGratis2 = await rpc("tools/call", { name: "get_local_heatmap", arguments: argsHm });
const hmGratis2Text = hmGratis2.body?.result?.content?.[0]?.text ?? "";
check(
  "y el segundo se bloquea con el mensaje de Daniel",
  hmGratis2Text.includes("Free quota reached (1/1 heatmaps used)") &&
    hmGratis2Text.includes("ranktitan.ai/pricing"),
  hmGratis2Text.slice(0, 90),
);

// Sin esto se devolveria el reporte anterior como si fuera el nuevo: pedir por
// location siempre trae el mas reciente, y hasta que el id cambia ese es el
// viejo. Entregar los numeros del mes pasado como los de hoy es el peor fallo
// posible aqui, porque parece que funciono.
check(
  "pasa el reporte anterior para no confundirlo con el nuevo",
  ultimoResultBody?.previousReportId === "rep-41",
  JSON.stringify(ultimoResultBody),
);

// Una rejilla cuesta dinero de verdad: la pertenencia se comprueba antes.
const hmAjeno = await rpc(
  "tools/call",
  { name: "get_local_heatmap", arguments: { location_id: "99999999999999999999", keyword: "x y" } },
  `Bearer ${KEY_PAGO}`,
);
const hmAjenoText = hmAjeno.body?.result?.content?.[0]?.text ?? "";
check(
  "no gasta un token en un negocio ajeno",
  hmAjeno.body?.result?.isError === true && hmAjenoText.includes("not in this Rank Titan account"),
  hmAjenoText.slice(0, 60),
);

// El fallo que vio Claude en produccion: pedir una keyword que el reporte no
// tiene devolvia los numeros de OTRA keyword. Numeros creibles para la
// pregunta equivocada, que es peor que no responder porque nadie los revisa.
const otraKw = await rpc(
  "tools/call",
  {
    name: "get_heatmap_result",
    arguments: { location_id: "10000000000000000011", keyword: "cerrajero madrid" },
  },
  `Bearer ${KEY_PAGO}`,
);
const otraKwText = otraKw.body?.result?.content?.[0]?.text ?? "";
check(
  "no devuelve los datos de otra keyword",
  otraKwText.includes("running") && !otraKwText.includes("Average position"),
  otraKwText.split("\n")[0],
);

// Un negocio sin coordenadas es una condicion explicable, no una caida. Como
// 500 se leia "Rank Titan no esta disponible", y mandaba a buscar un apagon
// que no existia mientras el problema real quedaba sin decir.
const sinCoords = await rpc(
  "tools/call",
  {
    name: "get_local_heatmap",
    arguments: { location_id: "10000000000000000022", keyword: "cerrajero" },
  },
  `Bearer ${KEY_PAGO}`,
);
const sinCoordsText = sinCoords.body?.result?.content?.[0]?.text ?? "";
check(
  "un negocio sin coordenadas explica por que, no finge una caida",
  sinCoordsText.includes("coordinates") && !sinCoordsText.includes("temporarily unavailable"),
  sinCoordsText.slice(0, 80),
);

// Leer un resultado ya pagado no vuelve a cobrar.
const hmr = await rpc(
  "tools/call",
  {
    name: "get_heatmap_result",
    arguments: { location_id: "10000000000000000011", keyword: "emergency plumber" },
  },
  `Bearer ${KEY_PAGO}`,
);
check(
  "releer el resultado funciona",
  (hmr.body?.result?.content?.[0]?.text ?? "").includes("Average position"),
);

const publicadas = auditadas.filter((a) => a.tool === "post_review_reply" && a.status === "ok");
// Se sigue contabilizando aunque hoy no se bloquee: es lo que permite saber el
// uso real y volver a poner un tope por entorno si alguna vez hace falta.
check(
  "cada publicacion cuenta exactamente 1",
  publicadas.length === 2 &&
    publicadas.every((a) => a.cost === 1 && a.counter === "review_replies"),
  `${publicadas.length} publicaciones`,
);

check(
  "guarda el locationId cuando lo hay",
  auditadas.some((a) => a.locationId === "10000000000000000011"),
);
check(
  "guarda la duración",
  auditadas.every((a) => typeof a.durationMs === "number"),
);
check(
  "el detalle del fallo no lleva traza de pila",
  rechazadas.every((a) => !String(a.detail || "").includes("    at ")),
);

// 15. La UI de Claude no permite cabecera Authorization: debe valer x-account-key
const porAccountKey = await rpc(
  "tools/call",
  { name: "list_businesses", arguments: {} },
  KEY,
  "x-account-key",
);
check(
  "acepta la clave por x-account-key",
  (porAccountKey.body?.result?.content?.[0]?.text ?? "").includes("active business"),
  "sin prefijo Bearer",
);

// 16. Búsqueda por nombre
const busq = await rpc("tools/call", {
  name: "list_businesses",
  arguments: { search: "harbour street" },
});
const busqText = busq.body?.result?.content?.[0]?.text ?? "";
check(
  "search filtra por nombre",
  busqText.includes("Harbour Street") && !busqText.includes("Northgate"),
  busqText.split("\n")[0],
);

const sinRes = await rpc("tools/call", { name: "list_businesses", arguments: { search: "zzzz" } });
check(
  "search sin resultados lo dice claro",
  (sinRes.body?.result?.content?.[0]?.text ?? "").includes("No active business matches"),
);

// 17. Herramientas públicas, SIN credencial
const audPub = await rpc(
  "tools/call",
  { name: "audit_public_business", arguments: { business: "Castle Lock Co." } },
  SIN_AUTH,
);
const audPubText = audPub.body?.result?.content?.[0]?.text ?? "";
check(
  "audita un negocio público sin cuenta",
  audPubText.includes("Castle Lock Co.") && audPubText.includes("Profile score"),
  audPubText.split("\n")[0],
);
check("detecta la web ausente", audPubText.includes("Website") && audPubText.includes("⚠️"));

const compPub = await rpc(
  "tools/call",
  { name: "get_local_competitors", arguments: { search: "locksmith in Eastbourne" } },
  SIN_AUTH,
);
const compText = compPub.body?.result?.content?.[0]?.text ?? "";
check(
  "lista competencia sin cuenta",
  compText.includes("Castle Lock Co.") && compText.includes("1096"),
);
check("resalta la diferencia de reseñas", compText.includes("Review counts run from"));

// 18. Las privadas piden entrar con un 401, no con un 200 y una frase amable:
// un 200 es "exito" para el cliente y nunca llega a ofrecer el login. El
// mensaje sigue invitando a registrarse para quien no tenga cuenta.
const privada = await rpc("tools/call", { name: "list_businesses", arguments: {} }, SIN_AUTH);
const privText = privada.body?.error?.message ?? "";
check(
  "una herramienta privada pide entrar, no finge exito",
  privada.status === 401,
  `status=${privada.status}`,
);
check(
  "y al hacerlo invita a crear cuenta",
  privText.includes("ranktitan.ai") && privText.includes("account"),
  privText.slice(0, 60),
);
check("y no filtra datos de nadie", !privText.includes("Location ID"));

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
