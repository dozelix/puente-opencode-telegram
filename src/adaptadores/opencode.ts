// Cliente del servidor de OpenCode (reemplaza al urllib crudo del Python).
// El Python (clase Opencode, líneas 478-641) leía ~/.local/state/opencode/
// service.json a mano porque el puerto del servidor cambiaba al reiniciarlo.
// Acá `Service.discover()` hace ese trabajo: lee el mismo registro, revisa la
// salud del servicio (/api/info) y devuelve la URL + la autenticación vigente.
// La URL y la contraseña se re-resuelven en cada llamada: si el servidor se
// reinicia, el puente sigue hablando con él sin intervención manual.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClientError, OpenCode, isSessionNotFoundError } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { PermissionRequest, SessionInboxUser, SessionInfo, SessionMessageInfo, SessionMessagesResponse } from "@opencode/client";
import { CONFIG, LOG } from "../config.ts";

/** Cliente promesa del paquete (el tipo devuelto por OpenCode.make). */
export type ClienteOc = ReturnType<typeof OpenCode.make>;

/** Modelo de la sesión: {providerID, id} como lo use el Router. */
export interface Modelo {
  providerID: string;
  id: string;
}
/** Adjunto para el prompt (el JSON que el Python enviaba). */
export interface Adjunto {
  uri: string;
  name?: string;
  description?: string;
}
/** Entrada mínima del catálogo para decidir (lo que el Router necesita de
 * c.model.list). `entrada` son las modalidades de entrada del modelo
 * (text · image · audio · video · pdf) y el costo va en USD por millón de
 * tokens de entrada (el mínimo entre sus tiers). */
export interface InfoCatalogo {
  providerID: string;
  id: string;
  entrada: string[];
  costo_entrada: number;
}

/** Respaldo si `Service.discover()` no responde: el registro del servicio
 * gestionado (`opencode serve --service`), que es el que usa el puente.
 *
 * Antes acá había `http://127.0.0.1:4096` (el servidor en primer plano, el de
 * la TUI): cuando el descubrimiento fallaba, TODAS las llamadas se iban a un
 * puerto muerto y el puente quedaba mudo con ECONNREFUSED aunque el servicio
 * real siguiera vivo. Devuelve "" si no hay registro: el llamador avisa. */
function respaldo_registro(): string {
  const registro = path.join(os.homedir(), ".local/state/opencode/service.json");
  try {
    const d = JSON.parse(fs.readFileSync(registro, "utf8")) as { url?: unknown };
    const url = typeof d.url === "string" ? d.url.trim() : "";
    return url.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function mensaje_de(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

function dormir_ms(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Errores declarados de la API (la respuesta lleva _tag y el client lo pone
// como `name` del Error). Son respuestas del servidor: no se reintentan.
const ERRORES_DECLARADOS = new Set([
  "InvalidRequestError",
  "UnauthorizedError",
  "LocationNotFoundError",
  "ServiceUnavailableError",
  "AgentNotFoundError",
  "SessionNotFoundError",
  "ConflictError",
  "UnknownError",
  "MessageNotFoundError",
  "SessionBusyError",
  "CommandNotFoundError",
  "CommandExecutionError",
  "SkillNotFoundError",
  "ProviderNotFoundError",
  "PermissionNotFoundError",
  "ForbiddenError",
]);

/** ¿El error definió una respuesta HTTP del servidor? (como el HTTPError de urllib) */
function es_error_de_servidor(e: unknown): boolean {
  if (e instanceof ClientError) return e.reason !== "Transport";
  const nombre = e instanceof Error ? e.name : "";
  return ERRORES_DECLARADOS.has(nombre);
}

/** ¿El error es de red (corte/timeout del fetch)? Esos sí se reintentan. */
function es_transitorio(e: unknown): boolean {
  if (es_error_de_servidor(e)) return false;
  if (e instanceof ClientError) return e.reason === "Transport";
  const nombre = e instanceof Error ? e.name : "";
  if (nombre === "AbortError" || nombre === "TimeoutError") return true;
  const texto = mensaje_de(e).toLowerCase();
  return /fetch failed|econn|enotfound|etimedout|eai_again|socket|connect|reset|refused|network/.test(texto);
}

/** Estado HTTP del error, si lo hay (el client lo guarda en cause.status). */
function estado_http(e: unknown): number | undefined {
  const causa = (e as { cause?: { status?: unknown } } | null)?.cause;
  if (typeof causa === "object" && causa !== null) {
    const s = (causa as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/** ¿La sesión que se buscó no existe? (404 por vía declarada o por vía cruda)
 * Lo usan `existe`/`eliminar_sesion` acá y `Conversacion.preguntar` en el dominio. */
export function es_sesion_inexistente(e: unknown): boolean {
  if (isSessionNotFoundError(e)) return true;
  if (e instanceof Error && e.name === "SessionNotFoundError") return true;
  return estado_http(e) === 404;
}

export class Opencode {
  private url_fallback: string;
  private cliente: ClienteOc | undefined;
  private url_cliente = "";
  private clave_cliente: string | undefined;
  private catalogo_cache: InfoCatalogo[] | undefined;
  private catalogo_momento = 0;

  constructor(url = "") {
    this.url_fallback = url.replace(/\/+$/, "");
  }

  /** El catálogo de modelos VIVO del servidor (caché de 60 s por instancia).
   *
   * Reemplaza a la matriz hardcodeada del Python (`Router.AUDIO` y compañía):
   * esa cambió dos veces por debajo del puente — el proveedor se renovó
   * (google → console-google) y apareció un gratuito con audio nativo
   * (mimo-v2.6-flash-free). Con `c.model.list()` la fuente de verdad es el
   * servidor, que ya trae capacidades y costo por modelo. Si el servidor no
   * responde, se devuelve la última copia buena (o vacía si nunca la hubo). */
  async catalogo(): Promise<InfoCatalogo[]> {
    const ahora = Date.now();
    if (this.catalogo_cache && ahora - this.catalogo_momento < TTL_CATALOGO_MS) {
      return this.catalogo_cache;
    }
    try {
      const r = await this._llamar((c) => c.model.list(), MS_CREACION);
      const cruda = (r.data ?? []) as unknown as Array<{
        providerID?: string;
        id?: string;
        modelID?: string;
        enabled?: boolean;
        capabilities?: { input?: unknown };
        cost?: unknown;
      }>;
      const vivos: InfoCatalogo[] = [];
      for (const m of cruda) {
        if (m.enabled === false) continue;
        const id = m.modelID ?? m.id;
        if (!id || !m.providerID) continue;
        const entrada = Array.isArray(m.capabilities?.input)
          ? (m.capabilities.input as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        const precios = Array.isArray(m.cost)
          ? (m.cost as unknown[]).filter((x): x is { input?: number } =>
              typeof x === "object" && x !== null && typeof (x as { input?: unknown }).input === "number",
            )
          : [];
        vivos.push({
          providerID: m.providerID,
          id,
          entrada,
          costo_entrada: precios.length ? Math.min(...precios.map((x) => x.input as number)) : Infinity,
        });
      }
      if (vivos.length) {
        this.catalogo_cache = vivos;
        this.catalogo_momento = ahora;
      }
    } catch (e) {
      console.log(`${LOG} no pude leer el catálogo de modelos: ${mensaje_de(e)}`);
    }
    return this.catalogo_cache ?? [];
  }

  /** Cliente VIGENTE. El registro del servicio puede cambiar en cada arranque
   * del servidor (otro puerto, otra contraseña), así que se descubre en cada
   * llamada y el client se rehace solo si el endpoint cambió. */
  private async cliente_vigente(): Promise<ClienteOc> {
    let url = (this.url_fallback || respaldo_registro()).replace(/\/+$/, "");
    if (!url) {
      // Sin registro no hay servidor al que hablar: mejor decirlo claro que
      // reintentar contra un puerto fijo que casi siempre está muerto.
      throw new Error(
        "no encuentro el servidor de OpenCode: falta ~/.local/state/opencode/service.json (¿opencode service start?)",
      );
    }
    let clave: string | undefined;
    let usuario_auth: string | undefined;
    try {
      const endpoint = await Service.discover();
      if (endpoint?.url) {
        url = endpoint.url.replace(/\/+$/, "");
        clave = endpoint.auth?.password;
        usuario_auth = endpoint.auth?.username;
      }
    } catch (e) {
      console.log(`${LOG} no pude descubrir el servicio: ${mensaje_de(e)}`);
    }
    if (clave === undefined) clave = "";
    if (!this.cliente || url !== this.url_cliente || clave !== this.clave_cliente) {
      const cab: Record<string, string> = { "Content-Type": "application/json" };
      if (clave) {
        const token = Buffer.from(`${usuario_auth ?? "opencode"}:${clave}`).toString("base64");
        cab["Authorization"] = `Basic ${token}`;
      }
      this.cliente = OpenCode.make({ baseUrl: url, headers: cab });
      this.url_cliente = url;
      this.clave_cliente = clave;
    }
    return this.cliente;
  }

  /** El _call del Python: 3 intentos para fallos de red (el servidor puede
   * estar reiniciando), sin reintentar errores HTTP del servidor. */
  private async _llamar<T>(
    op: (c: ClienteOc) => Promise<T>,
    tiempo_ms: number,
  ): Promise<T> {
    let ultimo: unknown = undefined;
    for (let intento = 0; intento < 3; intento++) {
      if (intento) await dormir_ms((1 + intento) * MS);
      try {
        const c = await this.cliente_vigente();
        return await op(c);
      } catch (e) {
        if (!es_transitorio(e)) throw e;
        ultimo = e;
        console.log(`${LOG} no pude hablar con el servidor (${mensaje_de(e)}); reintento`);
      }
    }
    throw ultimo ?? new Error("fallo de red");
  }

  // ---------------------------------------------------------------- existencias

  /** ¿La sesión sigue viva en el servidor?
   * En el Python CUALQUIER error HTTP (400/404/500…) se contaba como «no
   * existe»; solo un fallo de red deja la sesión por viva, porque un
   * servidor caído no puede borrar la sesión de un mensaje. Así mismo acá. */
  async existe(sid: string): Promise<boolean> {
    try {
      await this._llamar((c) => c.session.get({ sessionID: sid }), MS_TURNO);
      return true;
    } catch (e) {
      if (es_error_de_servidor(e)) return false;
      console.log(`${LOG} no pude verificar la sesión ${sid}: ${mensaje_de(e)}`);
      return true;
    }
  }

  /** Crea una sesión y devuelve su id (o null si el servidor no lo da). */
  async crear_sesion(titulo: string, directorio: string): Promise<string | null> {
    let info: SessionInfo;
    try {
      info = await this._llamar(
        (c) =>
          c.session.create({
            title: titulo,
            agent: CONFIG.agente,
            location: { directory: directorio },
          }),
        MS_CREACION,
      );
    } catch (e) {
      console.log(`${LOG} no pude crear la sesión: ${mensaje_de(e)}`);
      return null;
    }
    return info.id;
  }

  /** Borra una sesión en el servidor. Un 404 significa que ya no existe. */
  async eliminar_sesion(sid: string): Promise<boolean> {
    try {
      await this._llamar((c) => c.session.remove({ sessionID: sid }), MS_TURNO);
      return true;
    } catch (e) {
      return es_sesion_inexistente(e);
    }
  }

  /** El modelo que usa ahora la sesión ({providerID, id}). */
  async modelo_de(sid: string): Promise<Modelo | null> {
    let info: SessionInfo;
    try {
      info = await this._llamar((c) => c.session.get({ sessionID: sid }), MS_TURNO);
    } catch (e) {
      console.log(`${LOG} no pude leer el modelo de ${sid}: ${mensaje_de(e)}`);
      return null;
    }
    const m = info.model;
    if (m && m.id) return { providerID: m.providerID || "", id: m.id };
    return null;
  }

  /** Cambia el modelo de la sesión (el de la sesión manda sobre el del agente). */
  async cambiar_modelo(sid: string, modelo: Modelo): Promise<boolean> {
    try {
      await this._llamar(
        (c) =>
          c.session.switchModel({
            sessionID: sid,
            model: { id: modelo.id, providerID: modelo.providerID || "opencode" },
          }),
        MS_CREACION,
      );
      return true;
    } catch (e) {
      console.log(
        `${LOG} no pude cambiar el modelo de ${sid} a ${JSON.stringify(modelo)}: ${mensaje_de(e)}`,
      );
      return false;
    }
  }

  /** El directorio REAL en que quedó la sesión (fuente de verdad). */
  async directorio_de_sesion(sid: string): Promise<string> {
    let info: SessionInfo;
    try {
      info = await this._llamar((c) => c.session.get({ sessionID: sid }), MS_TURNO);
    } catch (e) {
      console.log(`${LOG} no pude leer el directorio de ${sid}: ${mensaje_de(e)}`);
      return "";
    }
    return info.location?.directory ?? "";
  }

  /** Cierra la sesión en el servidor (cuando el usuario empieza de cero). */
  async borrar_sesion(sid: string): Promise<boolean> {
    if (!sid) return false;
    try {
      await this._llamar((c) => c.session.remove({ sessionID: sid }), MS_TURNO);
      console.log(`${LOG} sesión ${sid} eliminada`);
      return true;
    } catch (e) {
      console.log(`${LOG} no pude borrar la sesión ${sid}: ${mensaje_de(e)}`);
      return false;
    }
  }

  /** Crea la sesión y devuelve [id, directorio real en que quedó]. */
  async sesion(titulo: string, directorio: string): Promise<[string, string]> {
    const directorio_str = String(directorio); // un Path no es serializable a JSON
    const info = await this._llamar(
      (c) =>
        c.session.create({
          title: titulo,
          agent: CONFIG.agente,
          location: { directory: directorio_str },
        }),
      MS_TURNO_LARGO,
    );
    const sid = info.id;
    if (!sid) throw new Error(`el servidor no devolvió id de sesión: ${JSON.stringify(info)}`);
    return [sid, info.location?.directory || directorio_str];
  }

  /** Manda el prompt. Revienta si la respuesta es un error del servidor
   * (404 = sesión muerta: `Conversacion.preguntar` rearma la sesión). */
  async prompt(sid: string, texto: string, archivos: Adjunto[] | null = null): Promise<SessionInboxUser> {
    const cuerpo: { sessionID: string; text: string; files?: Adjunto[] } = { sessionID: sid, text: texto };
    if (archivos && archivos.length) cuerpo.files = archivos;
    return this._llamar((c) => c.session.prompt(cuerpo), MS_PROMPT);
  }

  /** Los mensajes de la sesión (arreglo crudo, como en el Python). */
  async mensajes(sid: string): Promise<SessionMessageInfo[]> {
    const r = await this._llamar((c) => c.message.list({ sessionID: sid }), MS_TURNO_LARGO);
    return (r as SessionMessagesResponse).data ?? [];
  }

  /** Los permisos pendientes de la sesión. */
  async permisos(sid: string): Promise<PermissionRequest[]> {
    return this._llamar((c) => c.permission.list({ sessionID: sid }), MS_TURNO_LARGO);
  }

  /** Responde a un permiso (una vez para siempre, o rechazo). */
  async responder_permiso(
    sid: string,
    request_id: string,
    decision: "once" | "always" | "reject",
  ): Promise<boolean> {
    try {
      await this._llamar(
        (c) => c.permission.reply({ sessionID: sid, requestID: request_id, decision }),
        MS_TURNO_LARGO,
      );
      return true;
    } catch {
      return false;
    }
  }
}

// tiempos (ms), igual que los timeouts del Python (en segundos)
const MS = 1000;
const MS_TURNO = 20 * MS;
const MS_CREACION = 30 * MS;
const MS_TURNO_LARGO = 120 * MS;
const MS_PROMPT = 600 * MS;
/** El catálogo de modelos se refresca a lo sumo una vez por minuto: una foto
 * o una nota de voz no debe golpear la API del servidor cada vez. */
const TTL_CATALOGO_MS = 60 * MS;
export { mensaje_de };