// Autoprueba del puente TypeScript (port del --autoprueba del Python).
// Bloque 1 (adaptadores) + bloque 2 (dominio/aplicación/entrada): con el
// servidor REAL de OpenCode crea sesiones de prueba (estado aislado en
// /tmp via PUENTE_ESTADO_DIR, nunca el estado de producción), valida el
// fail-closed del config, el MarkdownV2 y los caminos del puente sin
// hablar con Telegram. Uso: bun run src/autoprueba.ts  (0 = TODO OK, 1 = FALLÓ)
import * as fs from "node:fs";
import * as pathlib from "node:path";
import { a_markdown_v2, lint_markdown_v2, partir } from "./markdown.ts";
import { Opencode, es_sesion_inexistente, mensaje_de } from "./adaptadores/opencode.ts";
import { CONFIG, RAIZ, cargar_config, validar_arranque, type Config } from "./config.ts";
import {
  dir_adjuntos,
  dir_estado,
  guardar_estado,
  leer_estado,
} from "./estado.ts";
import { Sesiones } from "./dominio/sesiones.ts";
import { Conversacion } from "./dominio/conversacion.ts";
import { Adjuntos, transcribir } from "./dominio/adjuntos.ts";
import { Router, audio_remoto_ok, elegir_candidatos } from "./aplicacion/router.ts";
import type { InfoCatalogo } from "./adaptadores/opencode.ts";
import { ayuda } from "./aplicacion/comandos.ts";
import {
  CTRL_INICIO,
  CTRL_OCULTAR,
  Selector,
  botones_proyectos,
  nombre,
  proyectos_ordenados,
  resolver_proyecto,
  sin_emoji,
  teclado_proyectos,
  type SalidaBotones,
} from "./aplicacion/selector.ts";
import {
  desenvolver,
  datos_del_mensaje,
  tiene_adjunto,
  archivo_id,
  es_voz,
  permitido,
} from "./entrada/update.ts";
import type { Boton, Markup, Objeto } from "./adaptadores/telegram.ts";

const fallos: string[] = [];

function chequear(nombre: string, ok: boolean, detalle = ""): boolean {
  console.log(`  ${ok ? "OK  " : "FALLA"}  ${nombre}${ok || !detalle ? "" : ` — ${detalle}`}`);
  if (!ok) fallos.push(detalle ? `${nombre}: ${detalle}` : nombre);
  return ok;
}

// ----------------------------------------------------------------- servidor real

async function sesion_invalida_reconocida(): Promise<boolean> {
  // — el 404 que llega por el canal declarado de la API se reconoce igual
  const declarado: unknown = Object.assign(new Error("Sesión no encontrada"), {
    name: "SessionNotFoundError",
  });
  const crudo: unknown = Object.assign(new Error("404"), {
    cause: { status: 404 },
  });
  const otro: unknown = Object.assign(new Error("500"), {
    cause: { status: 500 },
  });
  return (
    es_sesion_inexistente(declarado)
    && es_sesion_inexistente(crudo)
    && !es_sesion_inexistente(otro)
  );
}

/** La prueba real: crear sesión, comprobarla, detectar muerta y borrarla.
 * Esta es la parte que fallaba en producción: crear la sesión devolvía una
 * tupla y un Path, y el prompt se iba con un id corrupto. */
async function sesion_de_prueba(): Promise<boolean> {
  try {
    const oc = new Opencode();
    const [sid, real] = await oc.sesion("prueba-autoprueba", RAIZ);
    if (!sid || !(await oc.existe(sid))) return false;
    // el servidor tiene que respetar el directorio pedido
    if (pathlib.resolve(real) !== pathlib.resolve(RAIZ)) {
      console.log(`    la sesión quedó en ${real}, no en ${RAIZ}`);
      return false;
    }
    if ((await oc.directorio_de_sesion(sid)) !== real) return false;
    const ok = !(await oc.existe("ses_inexistente_autoprueba"));
    await oc.borrar_sesion(sid); // no dejar basura en el servidor
    if (ok && (await oc.existe(sid)) === false && (await oc.eliminar_sesion(sid)) === true) {
      // borrar de nuevo (404) cuenta como éxito en eliminar_sesion: igual que el Python
      return true;
    }
    return false;
  } catch (e) {
    console.log(`    no pude hablar con el servidor: ${mensaje_de(e)}`);
    return false;
  }
}

// ----------------------------------------------------------------- bloque 2

/** Doble de Telegram para el Selector: no hay red, solo un registro de lo
 * que la capa preferiría mandar. Cumple `SalidaBotones` por su forma. */
class TelegramDoble implements SalidaBotones {
  readonly impulsos: string[] = [];

  /** Jamás se llama en estas pruebas (los mensajes de prueba no traen adjuntos);
   * si alguien lo llama, falla ruidoso para no bajar datos de verdad. */
  async descargar(): Promise<[Uint8Array, string]> {
    throw new Error("el doble de Telegram no descarga archivos de verdad");
  }

  async send(chat_id: string, texto: string, _markup?: Markup): Promise<boolean> {
    this.impulsos.push(`send:${chat_id}:${texto.slice(0, 24)}`);
    return true;
  }

  async send_teclado(chat_id: string, texto: string, botones: Boton[][]): Promise<boolean> {
    this.impulsos.push(`send_teclado:${chat_id}:${texto.slice(0, 24)}:${botones.length}filas`);
    return true;
  }

  async send_teclado_fijo(
    chat_id: string,
    texto: string,
    botones: Boton[][],
    _placeholder?: string,
  ): Promise<boolean> {
    this.impulsos.push(`fijo:${chat_id}:${texto.slice(0, 24)}:${botones.length}filas`);
    return true;
  }

  async quitar_teclado(chat_id: string, _texto?: string): Promise<boolean> {
    this.impulsos.push(`quitar:${chat_id}`);
    return true;
  }

  async answer_callback(callback_id: string, texto = ""): Promise<boolean> {
    this.impulsos.push(`answer:${callback_id}:${texto}`);
    return true;
  }

  async edit_text(chat_id: string, message_id: number, texto: string, _markup?: Markup): Promise<boolean> {
    this.impulsos.push(`edit:${chat_id}:${message_id}:${texto.slice(0, 24)}`);
    return true;
  }

  limpiar(): void {
    this.impulsos.length = 0;
  }

  tuvo(prefijo: string): boolean {
    return this.impulsos.some((i) => i.startsWith(prefijo));
  }
}

/** Helpers de update del Python (desenvolver, datos…): caminos falsos, sin red. */
function pruebas_de_update(chat_prueba: string): void {
  const update: Objeto = {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 42, username: "prueba" },
      chat: { id: chat_prueba, type: "private" },
      date: 1792654000,
      text: "hola",
    },
  };
  const [tipo, mensaje] = desenvolver(update);
  chequear("update: el update se desenvuelve como message", tipo === "message", tipo);
  const [chat_id, texto, archivo] = datos_del_mensaje(mensaje);
  chequear("update: el chat_id llega", chat_id === chat_prueba, chat_id);
  chequear("update: el texto llega", texto === "hola", texto);
  chequear("update: mensaje sin archivo", archivo === "", archivo);

  const con_archivo: Objeto = {
    update_id: 2,
    message: { chat: { id: 42 }, document: { file_id: "abc", file_name: "foto.jpg" } },
  };
  const m2 = desenvolver(con_archivo)[1];
  const a2 = datos_del_mensaje(m2)[2];
  chequear("update: el documento se detecta", a2 === "foto.jpg", a2);
  chequear("update: tiene_adjunto lo ve", tiene_adjunto(m2));
  chequear("update: el file_id del documento", archivo_id(m2) === "abc", archivo_id(m2));
  chequear("update: un documento no es voz", !es_voz(m2));

  const con_voz: Objeto = {
    update_id: 3,
    message: { chat: { id: 42 }, voice: { file_id: "xyz", duration: 3 } },
  };
  const m3 = desenvolver(con_voz)[1];
  const a3 = datos_del_mensaje(m3)[2];
  chequear("update: la nota de voz se detecta", a3 === "nota-de-voz.ogg", a3);
  chequear("update: la nota de voz es voz", es_voz(m3));
  chequear("update: el file_id de la voz", archivo_id(m3) === "xyz", archivo_id(m3));
}

/** permitido(): fail-closed ya segn el chat fijado (invariantes 7 y 12). */
function pruebas_de_permitido(): void {
  chequear("permitido: fail-closed sin chat fijo", permitido("42", { chatFijo: "" }) === false);
  chequear(
    "permitido: con chat fijo vacío ni el propio vacío pasa",
    permitido("", { chatFijo: "" }) === false,
  );
  chequear("permitido: el chat fijado pasa", permitido("777", { chatFijo: "777" }) === true);
  chequear("permitido: otro chat no pasa", permitido("888", { chatFijo: "777" }) === false);
  // con la config de producción (si el chat fijo existe)
  if (CONFIG.chatFijo) {
    chequear(
      "permitido: la config real acepta su chat y rechaza los demás",
      permitido(CONFIG.chatFijo) === true && permitido(String(Number(CONFIG.chatFijo) + 1)) === false,
    );
  } else {
    chequear("permitido: la config real está fail-closed", permitido(CONFIG.chatFijo) === false);
  }
}

/** Los mensajes que el puente manda de verdad pasan el lint (el --lint del Python). */
function pruebas_de_lint_de_mensajes(): void {
  const reales: Array<[string, string]> = [
    ["ayuda", ayuda()],
    ["estado", `📍 \`${RAIZ}\`\nSesión: \`x\`\nAgente: ${CONFIG.agente}`],
    ["proyectos", `🗂 *Proyectos*\n\n• \`x\`\n\n_Ahora: \`${RAIZ}\`_ — tocá uno para trabajar en él.`],
    [
      "nueva",
      `✅ Sesión nueva abierta en \`${RAIZ}\`\n(modo general) · elegí un proyecto con /proyectos`,
    ],
  ];
  for (const [etiqueta, texto] of reales) {
    try {
      const md2 = a_markdown_v2(texto);
      const problemas = lint_markdown_v2(md2);
      chequear(`lint de mensajes reales: ${etiqueta}`, problemas.length === 0, problemas.join("; "));
    } catch (e) {
      chequear(`lint de mensajes reales: ${etiqueta}`, false, mensaje_de(e));
    }
  }
}

/** El Router decide contra el CATÁLOGO VIVO del servidor: este catálogo falso
 * reproduce la política de candidatos sin red (gratis primero, pago ajeno
 * fuera, cuenta propia de console-google después, preferido del env arriba). */
const CAT_FALSO: InfoCatalogo[] = [
  { providerID: "opencode", id: "texto-free", entrada: ["text"], costo_entrada: 0 },
  { providerID: "opencode", id: "pago-apep", entrada: ["text", "audio"], costo_entrada: 2 },
  { providerID: "opencode", id: "ojo-free", entrada: ["text", "image"], costo_entrada: 0 },
  { providerID: "opencode", id: "oreja-free", entrada: ["text", "image", "audio"], costo_entrada: 0 },
  {
    providerID: "console-google",
    id: "gemini-3.8-flash",
    entrada: ["text", "image", "audio"],
    costo_entrada: 0.75,
  },
];

function pruebas_de_candidatos(): void {
  const audio = elegir_candidatos("audio", CAT_FALSO, []);
  chequear(
    "router: candidatos de audio — gratis primero, pago ajeno fuera, cuenta propia después",
    audio.map((m) => `${m.providerID}/${m.id}`).join(",") ===
      "opencode/oreja-free,console-google/gemini-3.8-flash",
    audio.map((m) => `${m.providerID}/${m.id}`).join(","),
  );
  const imagen = elegir_candidatos("image", CAT_FALSO, ["console-google/gemini-3.8-flash"]);
  chequear(
    "router: candidatos de imagen — el preferido va primero y los gratis hacen de respaldo",
    imagen.map((m) => m.id).join(",") === "gemini-3.8-flash,ojo-free,oreja-free",
    imagen.map((m) => m.id).join(","),
  );
  const perdido = elegir_candidatos("image", CAT_FALSO, ["acme/ojo-1"]);
  chequear(
    "router: un preferido que ya no está en el catálogo se cae de la lista",
    perdido.map((m) => m.id).join(",") === "ojo-free,oreja-free,gemini-3.8-flash",
    perdido.map((m) => m.id).join(","),
  );
}

async function pruebas_del_router(): Promise<void> {
  const cfg: Config = { ...CONFIG, modeloAudio: "", modeloAdjuntos: "console-google/gemini-3.8-flash" };
  const voz = await Router.plan({ chat: { id: 42 }, voice: { file_id: "xyz" } }, null, cfg, CAT_FALSO);
  chequear(
    "router: nota de voz → turno de audio contra el catálogo vivo",
    voz.modo === "audio" && voz.modelo === null && voz.candidatos[0]?.id === "oreja-free",
    JSON.stringify(voz),
  );
  const foto = await Router.plan(
    { chat: { id: 42 }, photo: [{ file_id: "abc" }], caption: "hola" },
    null,
    cfg,
    CAT_FALSO,
  );
  chequear(
    "router: foto → preferido con visión primero, gratis de respaldo detrás",
    foto.modo === "imagen" &&
      foto.candidatos[0]?.id === "gemini-3.8-flash" &&
      foto.candidatos[1]?.id === "ojo-free",
    JSON.stringify(foto),
  );
  const doc = await Router.plan(
    { chat: { id: 42 }, document: { file_id: "a", file_name: "informe.pdf" } },
    null,
    cfg,
    CAT_FALSO,
  );
  chequear(
    "router: un documento normal no tiene turno especial",
    doc.modo === "normal" && doc.candidatos.length === 0 && doc.modelo === null,
    JSON.stringify(doc),
  );
  // el caso real del 22-oct: el proveedor se editó y el preferido desapareció
  const renovado = await Router.plan(
    { chat: { id: 42 }, photo: [{ file_id: "abc" }] },
    null,
    { ...cfg, modeloAdjuntos: "acme/ojo-1" },
    CAT_FALSO,
  );
  chequear(
    "router: preferido desaparecido → el catálogo cubre con otro modelo con visión",
    renovado.modo === "imagen" && renovado.candidatos[0]?.id === "ojo-free",
    JSON.stringify(renovado),
  );
  chequear("router: sin nombres de adjunto no hay turno especial", Router.modo_de([]) === "normal");
}

/** Sesiones contra el servidor real, con el estado en una carpeta de prueba. */
async function pruebas_de_sesiones(chat_prueba: string): Promise<void> {
  const oc = new Opencode();
  const sesiones = new Sesiones(oc);
  const sid1 = await sesiones.sesion_de(chat_prueba, true, RAIZ);
  chequear("sesiones: la sesión se crea en el home", Boolean(sid1), "sin id");
  chequear(
    "sesiones: directorio_de vuelve al home (la sesión es el estado)",
    (await sesiones.directorio_de(chat_prueba)) === RAIZ,
    await sesiones.directorio_de(chat_prueba),
  );
  const st = leer_estado();
  chequear(
    "sesiones: el estado guarda la sesión y la carpeta",
    (st.sesiones ?? {})[chat_prueba] === sid1 && (st.dirs ?? {})[chat_prueba] === RAIZ,
    JSON.stringify(st),
  );
  // el candado: dos llamadas en paralelo sin "nueva" no crean dos sesiones
  const en_paralelo = await Promise.all([sesiones.sesion_de(chat_prueba), sesiones.sesion_de(chat_prueba)]);
  chequear(
    "sesiones: el candado serializa (una sola sesión para dos llamadas)",
    en_paralelo[0] === en_paralelo[1],
    JSON.stringify(en_paralelo),
  );
  // última marca de respuesta
  await sesiones.marcar_respondido(chat_prueba);
  chequear("sesiones: marcar_respondido guarda la marca", (await sesiones.ultimo_ms(chat_prueba)) > 0);

  // sesión guardada muerta → se rehace en el mismo lugar (el 404 histórico)
  const st2 = leer_estado();
  st2.sesiones = { [chat_prueba]: "sesion-muerta-autoprueba" };
  st2.dirs = { [chat_prueba]: RAIZ };
  guardar_estado(st2);
  const sid3 = await sesiones.sesion_de(chat_prueba);
  chequear(
    "sesiones: la sesión muerta se rehace en el mismo lugar",
    Boolean(sid3) && sid3 !== "sesion-muerta-autoprueba" && (await sesiones.directorio_de(chat_prueba)) === RAIZ,
    sid3,
  );

  // cambiar_proyecto con un proyecto de verdad de ~/Proyectos
  const proyectos = proyectos_ordenados();
  if (proyectos.length) {
    const destino = await sesiones.cambiar_proyecto(chat_prueba, nombre(proyectos[0]));
    chequear(
      "sesiones: cambiar_proyecto abre la sesión en el proyecto",
      destino === proyectos[0],
      `${destino} ≠ ${proyectos[0]}`,
    );
  } else {
    console.log("  nota: no hay proyectos en ~/Proyectos para cambiar_proyecto");
  }
}

/** Selector con un doble de Telegram: botones y callbacks sin red real. */
async function pruebas_de_selector(chat_prueba: string, sesiones: Sesiones): Promise<void> {
  const doble = new TelegramDoble();
  const sel = new Selector(doble, sesiones);
  const botones = botones_proyectos();
  chequear("selector: se armaron los botones en línea", botones.length > 0, `${botones.length} filas`);
  const claves = botones.flat().map((b: Boton) => b["callback_data"] ?? "");
  chequear(
    "selector: botones de proyecto, Inicio y Ocultar",
    claves.some((c) => c.startsWith("proy:")) && claves.includes(CTRL_INICIO) && claves.includes(CTRL_OCULTAR),
    claves.join(","),
  );
  chequear("selector: se armó el teclado fijo", teclado_proyectos().length > 0);

  const proyectos = proyectos_ordenados();
  if (proyectos.length) {
    const p0 = proyectos[0];
    chequear("selector: resolver por nombre", resolver_proyecto(nombre(p0)) === p0, nombre(p0));
    chequear("selector: resolver por ruta", resolver_proyecto(p0) === p0, p0);
    chequear(
      "selector: no resuelve un proyecto que no existe",
      resolver_proyecto("no-existe-este-proyecto") === null,
    );
    chequear("selector: sin_emoji saca el icono", sin_emoji("🏠 Inicio") === "Inicio", sin_emoji("🏠 Inicio"));
  } else {
    console.log("  nota: sin proyectos, solo se prueban los controles");
  }

  // los callbacks tocan el servidor solo si el chat está fijado (permitido)
  if (!CONFIG.chatFijo) {
    console.log("  nota: sin TELEGRAM_CHAT_ID real no se prueban callbacks (podría rechazarlos permitido)");
    return;
  }
  const mensaje_de_cb = (id: string): Objeto => ({
    id,
    data: "",
    from: { username: "prueba" },
    message: { chat: { id: chat_prueba, type: "private" }, message_id: 7 },
  });

  // listar: listado con botones + teclado fijo puesto y marcado en el estado
  await sel.listar(chat_prueba);
  chequear(
    "selector: listar manda el listado con botones",
    doble.tuvo("send_teclado:") && doble.tuvo("fijo:"),
    doble.impulsos.join(" | "),
  );
  chequear(
    "selector: listar marca el teclado fijado",
    (leer_estado().teclado ?? {})[chat_prueba] === true,
  );
  doble.limpiar();

  if (proyectos.length) {
    const btn: Objeto = { ...mensaje_de_cb("cb-proy") };
    btn["data"] = `proy:${proyectos[0]}`;
    await sel.callback(btn);
    chequear(
      "selector: el botón de proyecto cambia y anuncia",
      doble.tuvo("answer:cb-proy:📂") && doble.tuvo("edit:"),
      doble.impulsos.join(" | "),
    );
    chequear(
      "selector: tras el botón la sesión vive en el proyecto",
      (await sesiones.directorio_de(chat_prueba)) === proyectos[0],
      await sesiones.directorio_de(chat_prueba),
    );
    doble.limpiar();
  }

  // Inicio: el modo general SIEMPRE vuelve al home (invariante 2)
  const btn_inicio: Objeto = { ...mensaje_de_cb("cb-inicio") };
  btn_inicio["data"] = CTRL_INICIO;
  await sel.callback(btn_inicio);
  chequear(
    "selector: el botón Inicio vuelve al modo general",
    doble.tuvo("answer:cb-inicio:🏠 Modo general") && (await sesiones.directorio_de(chat_prueba)) === RAIZ,
    doble.impulsos.join(" | "),
  );
  doble.limpiar();

  // Ocultar: apaga la barra y lo anota en el estado
  const btn_ocultar: Objeto = { ...mensaje_de_cb("cb-ocultar") };
  btn_ocultar["data"] = CTRL_OCULTAR;
  await sel.callback(btn_ocultar);
  chequear(
    "selector: el botón Ocultar quita la barra",
    doble.tuvo("answer:cb-ocultar:🙈 Listo") && doble.tuvo("quitar:"),
    doble.impulsos.join(" | "),
  );
  chequear(
    "selector: el teclado queda anotado como oculto",
    (leer_estado().teclado ?? {})[chat_prueba] === false,
  );
}

/** Adjuntos sin Telegram real: los respaldos no revienta (whisper/ffmpeg). */
async function pruebas_de_adjuntos(doble: TelegramDoble, oc: Opencode): Promise<void> {
  const sin_archivo: Objeto = { chat: { id: 42 }, text: "hola" };
  const adj = new Adjuntos(doble, oc);
  const [texto, lista] = await adj.preparar(sin_archivo, "hola");
  chequear("adjuntos: un mensaje sin adjunto no toca nada", texto === "hola" && lista.length === 0);
  // transcribir: nombre o modelo ausentes o archivo inexistente → "" sin lanzar
  const nada = await transcribir("/tmp/opencode/archivo-que-no-existe.ogg");
  chequear("adjuntos: transcribir de archivo inexistente no revienta", typeof nada === "string" && nada === "");
  // transcribir_local con una ruta que no existe: el texto vuelve intacto
  const vuelto = await adj.transcribir_local([{ uri: "file:///inexistente/nota.oga" }], "hola");
  chequear("adjuntos: transcribir_local ignora rutas inexistentes", vuelto === "hola", vuelto);
}

/** Conversación contra el servidor real: prompt + sondeo + respuesta. */
async function pruebas_de_conversacion(chat_prueba: string, sesiones: Sesiones): Promise<void> {
  const oc: Opencode = new Opencode();
  const conv = new Conversacion(oc);
  const sid = await sesiones.sesion_de(chat_prueba, true, RAIZ);
  const mandado = await conv.preguntar(sid, "Responde exactamente: OK", null);
  if (!mandado) {
    chequear("conversacion: el prompt salió", false, sid);
    return;
  }
  const [respuesta, archivos] = await conv.esperar(sid, 0, RAIZ, 5);
  chequear(
    "conversacion: la respuesta del agente llega",
    respuesta.trim().length > 0,
    respuesta.slice(0, 80) || "(vacía)",
  );
  chequear(
    "conversacion: una respuesta de texto no trae archivos",
    Array.isArray(archivos),
  );
}

/** El turno que cierra sin texto debe cortar al instante y decir por qué. */
async function pruebas_de_conversacion_corta(): Promise<void> {
  const ahora = Date.now();
  const falso = {
    mensajes: async () => [
      { type: "user", time: { created: ahora + 1 }, text: "hola" },
      {
        type: "assistant",
        time: { created: ahora + 2, completed: ahora + 3 },
        content: [],
        error: { type: "aborted", message: "Step interrupted" },
      },
      {
        type: "idle",
        time: { created: ahora + 4 },
        outcome: "interrupted",
        error: { type: "aborted", message: "Step interrupted" },
      },
    ],
  } as unknown as Opencode;
  const conv = new Conversacion(falso);
  const antes = Date.now();
  const [texto, archivos, motivo] = await conv.esperar("ses_prueba", ahora, RAIZ, 5);
  chequear(
    "conversacion: un turno interrumpido sin texto corta al instante y da el motivo",
    texto === "" && archivos.length === 0 && motivo.includes("interrumpió") && Date.now() - antes < 2000,
    motivo || "(sin motivo)",
  );
}

// ----------------------------------------------------------------- autoprueba

async function autoprueba(): Promise<number> {
  console.log("autoprueba — puente TypeScript (bloques 1 y 2)");

  // Estado de PRUEBA: jamás el de producción. La variable la leer
  // dir_estado() en cada llamada, así que basta con fijarla primero.
  process.env["PUENTE_ESTADO_DIR"] = "/tmp/opencode/autoprueba-estado";
  fs.rmSync(dir_estado(), { recursive: true, force: true });
  fs.rmSync(dir_adjuntos(), { recursive: true, force: true });

  // el chat de prueba: el chat real si está fijado (para no fallar por eso)
  const chat_prueba = CONFIG.chatFijo || "42";
  const oc_global = new Opencode();

  try {
    // --- config fail-closed (invariante 11): con datos de prueba, nunca los reales
    const base_sin_chat: Config = {
      token: "x",
      chatFijo: "",
      agente: "saulo",
      raiz: RAIZ,
      modeloAudio: "",
      modeloAdjuntos: "console-google/gemini-3.8-flash",
      urlServidor: "",
      whisperBin: "",
      whisperModelo: "",
      vozIdioma: "es",
    };
    const rechazo = validar_arranque(base_sin_chat);
    chequear(
      "config: sin TELEGRAM_CHAT_ID no arranca (fail-closed)",
      rechazo !== null && rechazo.includes("TELEGRAM_CHAT_ID"),
      rechazo ?? "no rechazó",
    );
    chequear("config: con chat y token se permite el arranque", validar_arranque({ ...base_sin_chat, chatFijo: "42" }) === null);
    const carga = cargar_config();
    chequear(
      "config: agente por defecto «saulo» y raíz = home",
      carga.agente === "saulo" && carga.raiz.length > 0,
    );

    // --- markdown (las pruebas del Python, líneas 1734-1744)
    const md2 = a_markdown_v2("*negrita* y `código`");
    chequear("markdown: se traducen la negrita y el código", md2.includes("*negrita*") && md2.includes("`código`"), md2);
    chequear("markdown: la traducción pasa el lint", lint_markdown_v2(md2).length === 0, lint_markdown_v2(md2).join("; "));
    chequear("markdown: el punto se escapa", a_markdown_v2("punto. final").includes("\\."));
    chequear(
      "markdown: snake_case no se vuelve cursiva",
      !a_markdown_v2("snake_case").includes("_snake_case_"),
      a_markdown_v2("snake_case"),
    );
    // un texto de 8000 caracteres en párrafos de 11 → varias partes ≤ 3800
    const trozos = partir("párrafo.\n\n".repeat(800));
    chequear(
      "markdown: partir respeta el límite",
      trozos.length > 1 && trozos.every((p) => p.length <= 3800),
      `${trozos.length} partes`,
    );

    // --- filtros de error (la vía del 404: el bug histórico de las sesiones muertas)
    chequear("client: el 404 se reconoce como sesión inexistente", await sesion_invalida_reconocida());

    // --- servidor real (bloque 1)
    chequear("servidor: sesión de prueba en el home (crear · existe · directorio · borrar)", await sesion_de_prueba());

    // --- bloque 2: helpers, seguridad, comandos y selector sin Telegram real
    pruebas_de_update(chat_prueba);
    pruebas_de_permitido();
    pruebas_de_lint_de_mensajes();
    pruebas_de_candidatos();
    await pruebas_del_router();
    await pruebas_de_sesiones(chat_prueba);
    const sesiones = new Sesiones(oc_global);
    await pruebas_de_selector(chat_prueba, sesiones);
    await pruebas_de_adjuntos(new TelegramDoble(), oc_global);

    // --- la prueba de audio real: un id que el servidor no tiene se descarta
    // rápido (falla el cambio de modelo antes del prompt: sin cuota ni espera)
    chequear(
      "router: audio_remoto_ok descarta un modelo que el servidor no tiene",
      (await audio_remoto_ok(oc_global, "acme/inexistente")) === false,
    );

    // --- conversación de verdad: prompt + sondeo de respuesta
    await pruebas_de_conversacion(chat_prueba, sesiones);
    await pruebas_de_conversacion_corta();
  }finally {
    // limpiar: la sesión del estado de prueba se borra en el servidor y el
    // estado de prueba desaparece (el estado real jamás se tocó)
    const oc = new Opencode();
    const sid_final = (leer_estado().sesiones ?? {})[chat_prueba];
    if (sid_final) await oc.borrar_sesion(sid_final);
    fs.rmSync(dir_estado(), { recursive: true, force: true });
  }

  console.log(fallos.length ? `autoprueba: FALLÓ — ${fallos.join("; ")}` : "autoprueba: TODO OK");
  return fallos.length ? 1 : 0;
}

export { autoprueba };

if (import.meta.main) {
  process.exit(await autoprueba());
}
