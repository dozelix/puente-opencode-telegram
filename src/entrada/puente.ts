// Punto de entrada del proceso (Python: class Puente, líneas 1422-1772,
// watchdog_loop 119-148, registrar_comandos 1750-1770, lint(), y main()
// líneas 1773-1803). El enrutador de mensajes: decide qué hacer con cada
// update de Telegram. Lo demás lo hace cada clase según su oficio.
//
// Barreras de fallo: toda la manipulación de un update va en try/catch que
// avisa por Telegram (invariante 6 — una excepción no mata el puente), y el
// bucle de getUpdates tolera 409 (otro poller con el mismo token) y cortes.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { HTTPError, Telegram, type Objeto } from "../adaptadores/telegram.ts";
import { Opencode, mensaje_de, type Modelo } from "../adaptadores/opencode.ts";
import { CONFIG, RAIZ, LOG, validar_arranque } from "../config.ts";
import { guardar_estado, leer_estado } from "../estado.ts";
import { Sesiones } from "../dominio/sesiones.ts";
import { Adjuntos } from "../dominio/adjuntos.ts";
import { Conversacion } from "../dominio/conversacion.ts";
import { Router } from "../aplicacion/router.ts";
import { Selector } from "../aplicacion/selector.ts";
import { Comandos, ayuda } from "../aplicacion/comandos.ts";
import { a_markdown_v2, lint_markdown_v2 } from "../markdown.ts";
import { campo, cadena_en, objeto_en, desenvolver, datos_del_mensaje, permitido } from "./update.ts";
import { autoprueba } from "../autoprueba.ts";

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class Puente {
  readonly sesiones: Sesiones;
  readonly adjuntos: Adjuntos;
  readonly conversacion: Conversacion;
  readonly selector: Selector;
  readonly comandos: Comandos;

  /** Cola por chat: dentro de un chat, un turno a la vez (ver _despachar). */
  private readonly cola = new Map<string, Promise<void>>();

  constructor(
    private readonly tg: Telegram,
    private readonly oc: Opencode,
  ) {
    this.sesiones = new Sesiones(oc);
    this.adjuntos = new Adjuntos(tg, oc);
    this.conversacion = new Conversacion(oc);
    this.selector = new Selector(tg, this.sesiones);
    this.comandos = new Comandos(tg, this.sesiones, oc, this.selector);
  }

  /** Recibe un update de Telegram y lo manda a quien corresponda. */
  async manejar(update: Objeto): Promise<void> {
    const cb = update["callback_query"];
    if (campo(update, "callback_query")) {
      await this.selector.callback(cb as Objeto);
      return;
    }
    const [tipo, mensaje] = desenvolver(update);
    const [chat_id, texto, archivo] = datos_del_mensaje(mensaje);
    if (!chat_id) {
      console.log(`${LOG} update sin chat (tipo ${tipo})`);
      return;
    }
    if (!permitido(chat_id)) {
      const usuario = cadena_en(objeto_en(mensaje, "from"), "username", "?");
      console.log(`${LOG} RECHAZADO · chat ${chat_id} · @${usuario} · ${tipo}`);
      return;
    }
    const usuario = cadena_en(objeto_en(mensaje, "from"), "username", "?");
    console.log(`${LOG} ${tipo} · chat ${chat_id} · ${usuario} · ${(texto || archivo).slice(0, 70)}`);

    if (tipo === "my_chat_member" || tipo === "chat_member") {
      await this.comandos.saludo(chat_id);
      return;
    }
    if (await this.comandos.atender(chat_id, texto)) return;
    if (await this.selector.atajo(chat_id, texto)) return;
    await this._mensaje(chat_id, texto, mensaje);
  }

  /** Un mensaje normal: va al agente y vuelve la respuesta. */
  private async _mensaje(chat_id: string, texto: string, mensaje: Objeto): Promise<void> {
    let sid = await this.sesiones.sesion_de(chat_id);
    const desde_ms = await this.sesiones.ultimo_ms(chat_id);

    // --- router: candidatos del turno contra el catálogo VIVO del servidor ---
    // Audio e imagen cambian de modelo (el catálogo dice quién las acepta y
    // el costo); si el modelo preferido ya no existe o falla, siguen los otros
    // candidatos. El texto puro usa el modelo de la sesión.
    const plan = await Router.plan(mensaje, this.oc);
    const preparado = await this.adjuntos.preparar(mensaje, texto, plan);
    let texto_final = preparado[0];
    let adjuntos = preparado[1];

    // audio: UN candidato ya validado con prueba real (lo anotó Adjuntos);
    // imagen: la lista se recorre hasta que un cambio de modelo funcione.
    const lista = plan.modelo ? [plan.modelo] : plan.candidatos;
    let previo: Modelo | null = null;
    let elegido: Modelo | null = null;
    for (const c of lista) {
      if (!previo) previo = await this.oc.modelo_de(sid);
      if (await this.oc.cambiar_modelo(sid, c)) {
        elegido = c;
        break;
      }
    }
    if (elegido && lista.length > 1 && lista[0] && elegido.id !== lista[0].id) {
      console.log(`${LOG} router · ${lista[0].id} no respondió al cambio → ${elegido.id}`);
      await this.tg.send(
        chat_id,
        `⚙️ ${lista[0].id} no respondió al cambio; el turno de ${plan.modo} va con ${elegido.id}.`,
      );
    } else if (elegido) {
      console.log(`${LOG} router · turno de ${plan.modo} con ${elegido.id}`);
    }
    // respaldos si ningún candidato se pudo aplicar
    if (plan.modo === "audio" && !elegido) {
      console.log(`${LOG} sin modelo de audio disponible: transcripción local`);
      texto_final = await this.adjuntos.transcribir_local(adjuntos, texto_final);
      adjuntos = [];
    }
    if (plan.modo === "imagen" && !elegido) {
      console.log(`${LOG} sin modelo con visión disponible: el mensaje va sin la imagen`);
      await this.tg.send(
        chat_id,
        "⚠️ Ahora mismo no hay modelo con visión disponible; mando tu mensaje sin la imagen (el archivo quedó guardado en el computador).",
      );
      adjuntos = [];
    }

    // --- typing: aviso de «escribiendo» mientras el agente piensa ---
    const paro = { parado: false };
    iniciar_typing(this.tg, chat_id, paro);
    try {
      try {
        if (!(await this.conversacion.preguntar(sid, texto_final, adjuntos))) {
          // la sesión ya no existe (se cerró, o el servidor se reinició): rearmo
          console.log(`${LOG} sesión ${sid} muerta (404): creo otra`);
          sid = await this.sesiones.sesion_de(chat_id, true);
          if (!(await this.conversacion.preguntar(sid, texto_final, adjuntos))) {
            throw new Error("la sesión nueva tampoco existe");
          }
        }
      } catch (e) {
        console.log(`${LOG} error mandando el prompt: ${mensaje_de(e)}`);
        await this.tg.send(chat_id, `⚠️ No pude mandar tu mensaje al agente: ${mensaje_de(e)}`);
        return;
      }
      const base = await this.sesiones.directorio_de(chat_id);
      const [respuesta, archivos, motivo] = await this.conversacion.esperar(sid, desde_ms, base);
      await this.sesiones.marcar_respondido(chat_id);
      // Si el turno cerró sin texto, `motivo` dice por qué (interrumpido,
      // fallido o vacío) en vez de un «(sin respuesta)» que no explica nada.
      await this.tg.send(chat_id, respuesta || (motivo ? `⚠️ ${motivo}` : "(sin respuesta)"));
      for (const p of archivos) {
        try {
          await this.tg.send_file(chat_id, p);
        } catch (e) {
          console.log(`${LOG} no pude enviar ${path.basename(p)}: ${mensaje_de(e)}`);
        }
      }
    } finally {
      paro.parado = true;
      // el modelo prestado se devuelve a la sesión (solo si de verdad lo
      // cambiaste: si nadie se pudo aplicar, no hay nada que devolver).
      // Si la sesión se cerró mientras tanto (un /nueva, un /proyecto), la
      // restauración falla: no debe tumbar el turno ni callar el aviso.
      if (elegido && previo) {
        try {
          await this.oc.cambiar_modelo(sid, previo);
        } catch (e) {
          console.log(`${LOG} no pude devolver el modelo a ${sid}: ${mensaje_de(e)}`);
        }
      }
    }
  }

  /** Ejecuta manejar() sin dejar que una excepción mate el despacho en silencio.
   *
   * Antes, un error raro (por ejemplo, el servidor reiniciándose) mataba el
   * hilo del mensaje y vos nunca te enterabas: el puente quedaba mudo
   * (invariante 6). Acá se captura, se loguea y se avisa por Telegram.
   *
   * Los updates de un mismo chat van EN ORDEN: si llega un mensaje mientras
   * otro turno espera respuesta, se encola. Antes corrían en paralelo y un
   * cambio de proyecto podía borrar la sesión del turno en curso (y su
   * respuesta moría con ella). /si y /no van directo: responden permisos del
   * turno que está esperando; encolarlos sería un abrazo mortal. */
  private async _despachar(update: Objeto): Promise<void> {
    const [, mensaje] = desenvolver(update);
    const chat_id = datos_del_mensaje(mensaje)[0];
    const texto = datos_del_mensaje(mensaje)[1];
    if (!chat_id || /^\/(si|no)(\s|$)/i.test(texto)) {
      await this._despachar_ahora(update);
      return;
    }
    const en_curso = this.cola.has(chat_id);
    const anterior = this.cola.get(chat_id) ?? Promise.resolve();
    const tarea = anterior.then(
      () => this._despachar_ahora(update),
      () => this._despachar_ahora(update),
    );
    const guardado = tarea.catch(() => {});
    this.cola.set(chat_id, guardado);
    if (en_curso) {
      try {
        await this.tg.send(chat_id, "⏳ Sigo con el turno anterior; atiendo esto en cuanto termine.");
      } catch {
        // el aviso es cortesía: si falla, el mensaje ya está en cola
      }
    }
    try {
      await tarea;
    } finally {
      if (this.cola.get(chat_id) === guardado) this.cola.delete(chat_id);
    }
  }

  /** El cuerpo de siempre: maneja un update y avisa si algo falla. */
  private async _despachar_ahora(update: Objeto): Promise<void> {
    try {
      await this.manejar(update);
    } catch (e) {
      console.log(
        `${LOG} error procesando el mensaje: ${mensaje_de(e)}` +
          (e instanceof Error && e.stack ? `\n${e.stack}` : ""),
      );
      try {
        const cb = campo(update, "callback_query");
        if (cb) {
          // un botón: hay que confirmar el toque o Telegram lo marca como roto
          const cid = typeof cb["id"] === "string" ? (cb["id"] as string) : "";
          await this.tg.answer_callback(cid, "⚠️ Error");
          return;
        }
        const mensaje = desenvolver(update)[1];
        const chat_id = datos_del_mensaje(mensaje)[0];
        if (chat_id) {
          await this.tg.send(chat_id, `⚠️ Me falló procesar tu mensaje: ${mensaje_de(e)}`);
        }
      } catch {
        // no hay nada más que hacer si ni siquiera el aviso sale
      }
    }
  }

  /** Trae los mensajes de Telegram. El offset se guarda: si el puente se
   * reinicia, no vuelve a procesar lo que ya atendió. */
  async escuchar(): Promise<void> {
    const st = leer_estado();
    let offset = Math.trunc(Number(st.offset ?? 0)) || 0;
    while (true) {
      let updates: Objeto[];
      try {
        updates = await this.tg.updates(offset);
      } catch (e) {
        if (e instanceof HTTPError) {
          // 409: hay otro getUpdates vivo (el puente anterior, recién parado)
          console.log(`${LOG} Telegram dice ${e.code}: espero un poco`);
          await dormir(10_000);
          continue;
        }
        console.log(`${LOG} error consultando Telegram: ${mensaje_de(e)}`);
        await dormir(5000);
        continue;
      }
      for (const u of updates) {
        const dato = u["update_id"];
        const n = typeof dato === "number" ? dato : offset;
        offset = Math.max(offset, n + 1);
        // cada mensaje en su tarea: una respuesta larga no bloquea al resto
        void this._despachar(u).catch((e2) =>
          console.log(`${LOG} el despacho se cayó: ${mensaje_de(e2)}`),
        );
      }
      if (updates.length) {
        const fresco = leer_estado();
        fresco.offset = offset;
        guardar_estado(fresco);
      }
    }
  }
}

/** Aviso de «escribiendo» mientras el agente piensa (cada 4 s, igual que el
 * Python: se para desde el finally de _mensaje). */
function iniciar_typing(tg: Telegram, chat_id: string, paro: { parado: boolean }): void {
  void (async () => {
    while (!paro.parado) {
      await dormir(4000);
      if (paro.parado) break;
      try {
        await tg.typing(chat_id);
      } catch {
        // el typing no es crítico: falla y sigue
      }
    }
  })();
}

/** La URL del servidor de OpenCode, para el banner (el url_servidor del
 * Python, líneas 108-115): el registro del servicio manda; el env es respaldo. */
function url_servidor(): string {
  try {
    const registro = path.join(os.homedir(), ".local/state/opencode/service.json");
    if (fs.existsSync(registro)) {
      const d = JSON.parse(fs.readFileSync(registro, "utf8")) as { url?: unknown };
      const u = String(d.url ?? "").trim();
      if (u) return u.replace(/\/+$/, "");
    }
  } catch {
    // registro roto: queda el respaldo
  }
  return CONFIG.urlServidor || "(sin registro de servidor)";
}

// ----------------------------------------------------------------- watchdog
// systemd pide un ping (WATCHDOG=1) por un socket AF_UNIX de datagramas.
// El node:dgram de Bun no soporta el tipo "unix", así que el ping sale por
// libc (socket/connect/send de C). Sin NOTIFY_SOCKET, el watchdog se apaga
// solo (igual que el Python: fuera de systemd no hay ping).
type Simbolos = {
  socket: (dominio: number, tipo: number, protocolo: number) => number;
  connect: (fd: number, direccion: Uint8Array, largo: number) => number;
  send: (fd: number, buf: Uint8Array, largo: number, flags: number) => number;
  close: (fd: number) => number;
};
let libc: Simbolos | undefined = undefined;
let libc_fallo = false;

function libc_de(): Simbolos | null {
  if (libc) return libc;
  if (libc_fallo) return null;
  try {
    libc = dlopen("libc.so.6", {
      socket: { args: [FFIType.int, FFIType.int, FFIType.int], returns: FFIType.int },
      connect: { args: [FFIType.int, FFIType.pointer, FFIType.u32], returns: FFIType.int },
      send: { args: [FFIType.int, FFIType.pointer, FFIType.u64, FFIType.int], returns: FFIType.i64 },
      close: { args: [FFIType.int], returns: FFIType.int },
    }).symbols as unknown as Simbolos;
  } catch (e) {
    libc_fallo = true;
    console.log(`${LOG} sin libc por FFI: el watchdog no va a poder avisar (${mensaje_de(e)})`);
    return null;
  }
  return libc;
}

/** Envía WATCHDOG=1 al socket de systemd (con un socket nuevo por aviso,
 * igual que hacía el Python). Solo hace falta con SOCK_DGRAM de UNIX. */
function avisar_watchdog(ruta: string, libc: Simbolos): void {
  const AF_UNIX = 1;
  const SOCK_DGRAM = 2;
  const fd = libc.socket(AF_UNIX, SOCK_DGRAM, 0);
  if (fd < 0) throw new Error("socket(AF_UNIX, SOCK_DGRAM) falló");
  try {
    // struct sockaddr_un: sun_family (2 bytes) + sun_path[108]
    const direccion = new Uint8Array(110);
    direccion[0] = AF_UNIX;
    direccion[1] = 0;
    // systemd usa sockets abstractos con la forma "@/run/…": el @ es un
    // marcador, el primer byte del nombre debe ser NUL.
    const limpia = ruta.startsWith("@") ? `\0${ruta.slice(1)}` : ruta;
    const bytes = Buffer.from(limpia, "utf8");
    if (bytes.length > 106) throw new Error("la ruta del NOTIFY_SOCKET es demasiado larga");
    direccion.set(bytes, 2);
    if (libc.connect(fd, direccion, 110) !== 0) throw new Error(`connect(${ruta}) falló`);
    const mensaje = Buffer.from("WATCHDOG=1");
    libc.send(fd, mensaje, mensaje.length, 0);
  } finally {
    libc.close(fd);
  }
}

/** Le dice a systemd que el puente sigue vivo (WATCHDOG=1).
 *
 * Sin esto, un puente colgado (vivo pero mudo) seguiría "activo" para
 * systemd y nadie se enteraría. Con esto, systemd lo reinicia solo.
 */
export function watchdog_loop(): void {
  const activado = process.env["WATCHDOG_USEC"];
  if (!activado) return;
  const uso = Number(activado);
  if (!Number.isFinite(uso) || uso <= 0) return;
  const libc = libc_de();
  if (!libc) return;
  // systemd quiere el aviso a la mitad del plazo, para tener margen
  const intervalo = Math.max(5, uso / 2 / 1_000_000);
  const del_pid = process.env["WATCHDOG_PID"];
  if (del_pid && del_pid !== String(process.pid)) return;
  const ruta = process.env["NOTIFY_SOCKET"];
  if (!ruta) return;
  void (async () => {
    while (true) {
      try {
        avisar_watchdog(ruta, libc);
      } catch {
        // el ping fallido no mata el puente: se reintenta en el próximo ciclo
      }
      await dormir(intervalo * 1000);
    }
  })();
}

// ----------------------------------------------------------------- arranque
/** Pone la lista de comandos en el menú «/» de Telegram.
 *
 * Sin esto, el usuario tiene que acordarse los comandos de memoria.
 */
async function registrar_comandos(tg: Telegram): Promise<void> {
  const comandos = [
    { command: "ayuda", description: "Lista de comandos" },
    { command: "proyectos", description: "Ver y elegir proyecto" },
    { command: "proyecto", description: "Ver o cambiar la carpeta de trabajo" },
    { command: "nueva", description: "Sesión nueva en modo general (home)" },
    { command: "estado", description: "Ver la sesión y la carpeta" },
    { command: "si", description: "Aprobar un permiso" },
    { command: "no", description: "Rechazar un permiso" },
    { command: "start", description: "Empezar" },
  ];
  try {
    await tg.llamar("setMyCommands", { commands: comandos });
    console.log(
      `${LOG} comandos registrados en Telegram: ${comandos.map((c) => "/" + c.command).join(", ")}`,
    );
  } catch (e) {
    console.log(`${LOG} no pude registrar los comandos: ${mensaje_de(e)}`);
  }
}

// ----------------------------------------------------------------- lint
const MUESTRAS_LINT = [
  "👋 *Saulo* — tu agente en el computador.",
  "Trabajo en: `/home/dozelix/Proyectos/huachi-sport`",
  "✅ Sesión nueva abierta en `/home/dozelix`",
  "📂 Ahora trabajo en `/home/dozelix/Proyectos/huachi-sport` (sesión nueva).",
  "🗂 *Proyectos* (3)\n\n• `a`\n• `b`\n\n_Ahora: `/home/dozelix`_ — tocá uno para trabajar en él.",
  "⚠️ No pude mandar tu mensaje al agente: HTTP Error 404: Not Found",
  "Se encontró `snake_case` y `allowImportingTsExtensions` (camelCase) — sin tocar.",
  "Lista:\n* primero\n* segundo\n* tercero",
  "**negrita** y *negrita* y _cursiva_ y __subrayado__ y ~~tachado~~",
  "Enlace: [OpenCode](https://opencode.ai/docs)",
  "Bloque:\n```ts\nconst x = 1;\n```",
  "Tabla: | a | b |\n|---|---|\n| 1 | 2 |",
  "Precio: 5.000 CLP (u$ 20) — ¿va?",
  "100% de los casos; 3 + 2 = 5; a > b; x = y; fin.",
  "Emoji: ⚠️ ✅ 👋 📂 📍 🙈 🗂 ⌨️ 🏠",
];

/** Pasa el lint de MarkdownV2 a los mensajes que manda el puente (el --lint). */
function lint(): number {
  const fallos: string[] = [];
  for (const muestra of MUESTRAS_LINT) {
    try {
      const md2 = a_markdown_v2(muestra);
      const problemas = lint_markdown_v2(md2);
      if (problemas.length) {
        fallos.push(`${JSON.stringify(muestra.slice(0, 40))} → ${problemas[0]}`);
      } else {
        console.log(`  ok  ${JSON.stringify(muestra.slice(0, 52))}`);
        console.log(`      → ${JSON.stringify(md2.slice(0, 80))}`);
      }
    } catch (e) {
      fallos.push(`traducción falló: ${JSON.stringify(muestra.slice(0, 40))}: ${mensaje_de(e)}`);
    }
  }
  // los mensajes reales que arma el puente también tienen que pasar
  const reales: Array<[string, string]> = [
    ["ayuda", ayuda()],
    ["estado", `📍 \`${RAIZ}\`\nSesión: \`x\`\nAgente: ${CONFIG.agente}`],
    [
      "proyectos",
      `🗂 *Proyectos*\n\n• \`x\`\n\n_Ahora: \`${RAIZ}\`_ — tocá uno para trabajar en él.`,
    ],
    [
      "nueva",
      `✅ Sesión nueva abierta en \`${RAIZ}\`\n(modo general) · elegí un proyecto con /proyectos`,
    ],
  ];
  for (const [etiqueta, texto] of reales) {
    try {
      const problemas = lint_markdown_v2(a_markdown_v2(texto));
      if (problemas.length) fallos.push(`${etiqueta}: ${problemas[0]}`);
      else console.log(`  ok  mensaje real: ${etiqueta}`);
    } catch (e) {
      fallos.push(`${etiqueta}: no se pudo traducir (${mensaje_de(e)})`);
    }
  }
  console.log("lint:", fallos.length ? `FALLÓ:\n  ${fallos.join("\n  ")}` : "TODO OK");
  return fallos.length ? 1 : 0;
}

/** main() del Python: los modos de chequeo (--autoprueba, --lint), la
 * validación fail-closed y la puesta en marcha. */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--autoprueba")) return autoprueba();
  if (argv.includes("--lint")) return lint();
  const razon = validar_arranque();
  if (razon) {
    console.error(razon); // fail-closed: sin chat fijado el bot no habla con NADIE
    return 1;
  }
  const tg = new Telegram(CONFIG.token);
  const puente = new Puente(tg, new Opencode(CONFIG.urlServidor));
  console.log(`${LOG} Telegram → OpenCode · agente ${CONFIG.agente} · modo general ${RAIZ}`);
  console.log(`${LOG} servidor: ${url_servidor()}`);
  await registrar_comandos(tg);
  // watchdog: si el puente se cuelga, systemd lo reinicia
  watchdog_loop();
  console.log(`${LOG} esperando mensajes…`);
  await puente.escuchar();
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (e) {
    const interrupcion =
      e instanceof Error &&
      (e.name === "AbortError" || (e as { code?: unknown }).code === "ABORT_ERR");
    if (interrupcion) {
      console.log("\nPuente detenido.");
      process.exit(0);
    }
    console.error(e);
    process.exit(1);
  }
}
