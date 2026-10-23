// El modelo de cada turno (Python: audio_remoto_ok, líneas 1042-1057, y
// class Router, líneas 1095-1137). El Router solo DECIDE qué modelo
// corresponde; no habla con Telegram ni ejecuta nada (invariantes 13-14).
//
// Por qué decidimos contra el CATÁLOGO VIVO del servidor (c.model.list) y no
// contra una matriz fija: esa matriz quedó obsoleta dos veces por debajo del
// puente — el proveedor se renovó (google → console-google) y apareció un
// gratuito con audio nativo (mimo-v2.6-flash-free). El catálogo trae
// capacidades, costo y el flag `enabled` por modelo (lo que se edita en la
// consola de OpenCode): suficiente para elegir sin listas fijas.
import { CONFIG, RAIZ, type Config } from "../config.ts";
import { dir_estado } from "../estado.ts";
import * as fs from "node:fs";
import { LOG } from "../config.ts";
import { datos_del_mensaje } from "../entrada/update.ts";
import { Opencode, type InfoCatalogo, type Modelo } from "../adaptadores/opencode.ts";
import type { Objeto } from "../adaptadores/telegram.ts";

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parte "provider/modelo" como el Python (solo el primer "/" cuenta:
 * "a/b/c".split("/", 1) → ["a", "b/c"]). */
export function partir_modelo(cadena: string): [string, string] {
  const i = cadena.indexOf("/");
  return i < 0 ? [cadena, ""] : [cadena.slice(0, i), cadena.slice(i + 1)];
}

export type Capacidad = "image" | "audio";

/** Lo que el Router decide para un turno.
 *
 * `candidatos` es la lista en orden de preferencia: si el cambio de modelo
 * falla con uno, se prueba el siguiente; si todos fallan, el turno queda con
 * el modelo de la sesión y el puente avisa. Para AUDIO, `modelo` es el
 * elegido tras la prueba real (audio_remoto_ok), que lo fija Adjuntos. */
export interface Plan {
  modo: "audio" | "imagen" | "normal";
  candidatos: Modelo[];
  modelo: Modelo | null;
}

/** ¿El modelo del catálogo sirve para la capacidad pedida? */
function sirve(m: InfoCatalogo, capacidad: Capacidad): boolean {
  return m.entrada.includes(capacidad);
}

/** Un tramo ordenado y estable (para que los candidatos no bailen entre turnos). */
function ordenado(ms: InfoCatalogo[]): Modelo[] {
  return ms
    .map((m) => ({ providerID: m.providerID, id: m.id }))
    .sort((a, b) => `${a.providerID}/${a.id}`.localeCompare(`${b.providerID}/${b.id}`));
}

/** Los candidatos para una capacidad, en orden de preferencia:
 *
 * 1. los preferidos (MODELO_AUDIO / MODELO_ADJUNTOS del env, o el default) —
 *    solo si el catálogo vivo los lista con esa capacidad, si no se caen;
 * 2. los de costo 0 con la capacidad (gratuitos de verdad);
 * 3. los de console-google con costo (la cuota de la clave propia de Samuel).
 *
 * Un modelo de pago de otro proveedor NUNCA se elige en automático: la regla
 * de Samuel es solo gratuitos, y su clave de Google propia sí cuenta como
 * gratis para él (la metió él con ese fin). */
export function elegir_candidatos(
  capacidad: Capacidad,
  catalogo: InfoCatalogo[],
  preferidos: string[],
): Modelo[] {
  const con_capacidad = catalogo.filter((m) => sirve(m, capacidad));
  const salida: Modelo[] = [];
  for (const preferido of preferidos) {
    if (!preferido) continue;
    const [pid, mid] = partir_modelo(preferido);
    if (con_capacidad.some((m) => m.providerID === pid && m.id === mid)) {
      salida.push({ providerID: pid, id: mid });
    }
  }
  salida.push(...ordenado(con_capacidad.filter((m) => m.costo_entrada === 0)));
  salida.push(
    ...ordenado(
      con_capacidad.filter(
        (m) => m.providerID === "console-google" && m.costo_entrada > 0 && m.costo_entrada < Infinity,
      ),
    ),
  );
  // dedup (un preferido también puede aparecer en la lista de costo 0)
  const vistos = new Set<string>();
  return salida.filter((m) => {
    const k = `${m.providerID}/${m.id}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

/** ¿El modelo configurado para audio escucha de verdad? (con caché)
 *
 * Los modelos, sin cuota o clave, a veces **fallan en silencio**: ni error ni
 * respuesta. Confiar a ciegas dejaría al puente esperando 12 minutos por cada
 * nota de voz. Así que se prueba UNA VEZ por modelo (crea una sesión de
 * prueba, cambia el modelo y pide «OK») y se cachea el resultado en
 * audio.json — por modelo, porque la lista de candidatos puede rotar. Un
 * cambio de modelo que no funciona (el id ya no existe) cuenta como fallo
 * sin gastar el prompt: es la resistencia que faltaba cuando el proveedor
 * se edita por debajo del puente.
 */
export async function audio_remoto_ok(oc: Opencode, modelo: string): Promise<boolean> {
  const cache = `${dir_estado()}/audio.json`;
  const registro = (): Record<string, { ok: boolean; when: number }> => {
    try {
      const d = JSON.parse(fs.readFileSync(cache, "utf8")) as { modelos?: unknown };
      if (d.modelos && typeof d.modelos === "object") return d.modelos as Record<string, { ok: boolean; when: number }>;
    } catch {
      // caché rota o del Python (forma vieja {modelo, ok}): se vuelve a probar
    }
    return {};
  };
  const guardado = registro()[modelo];
  if (guardado && typeof guardado.ok === "boolean") return guardado.ok;

  let ok = false;
  let sid: string | null = null;
  try {
    const [pid, mid] = partir_modelo(modelo);
    sid = await oc.crear_sesion("prueba-audio", RAIZ);
    if (sid && (await oc.cambiar_modelo(sid, { providerID: pid, id: mid }))) {
      await oc.prompt(sid, "Responde exactamente: OK", null);
      const t0 = Date.now();
      while (Date.now() - t0 < 75_000 && !ok) {
        for (const m of await oc.mensajes(sid)) {
          if (m.type !== "assistant") continue;
          for (const c of m.content ?? []) {
            if (c.type === "text" && (c.text ?? "").trim()) {
              ok = true;
              break;
            }
          }
        }
        if (!ok) await dormir(3000);
      }
    }
  } catch (e) {
    console.log(`${LOG} no pude probar el modelo de audio (${modelo}): ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (sid) await oc.eliminar_sesion(sid);
  }
  try {
    fs.mkdirSync(dir_estado(), { recursive: true });
    fs.writeFileSync(
      cache,
      JSON.stringify({ modelos: { ...registro(), [modelo]: { ok, when: Math.floor(Date.now() / 1000) } } }),
      "utf8",
    );
  } catch {
    // sin caché se volverá a probar en el próximo turno
  }
  console.log(
    `${LOG} modelo de audio ${modelo}: ` +
      (ok ? "responde" : "NO responde") +
      " → " +
      (ok ? "remoto" : "siguiente candidato o transcripción local"),
  );
  return ok;
}

export class Router {
  static readonly AUDIOS = [".oga", ".ogg", ".opus", ".wav", ".mp3", ".m4a", ".flac"];
  static readonly IMAGENES = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"];

  /** El turno por los nombres de los adjuntos (nota-de-voz.ogg, foto.jpg, el
   * file_name del documento…). Un documento no es un turno especial. */
  static modo_de(nombres: string[]): "audio" | "imagen" | "normal" {
    const en = (lista: string[]): string[] =>
      nombres.map((n) => n.toLowerCase()).filter((n) => lista.some((e) => n.endsWith(e)));
    if (en(Router.AUDIOS).length) return "audio";
    if (en(Router.IMAGENES).length) return "imagen";
    return "normal";
  }

  /** El plan del turno a partir del MENSAJE (antes de descargar el adjunto:
   * el nombre ya se sabe — nota-de-voz.ogg, foto.jpg, el file_name del
   * documento— y con eso más el catálogo vivo arma la lista de candidatos).
   *
   * `catalogo` existe para la autoprueba (catálogo falso, sin red); en
   * producción se omite y se pide al servidor a través de `oc.catalogo()`. */
  static async plan(
    mensaje: Objeto,
    oc: Opencode | null,
    cfg: Config = CONFIG,
    catalogo?: InfoCatalogo[],
  ): Promise<Plan> {
    const archivo = datos_del_mensaje(mensaje)[2];
    const modo = archivo ? Router.modo_de([archivo]) : "normal";
    if (modo === "normal") return { modo, candidatos: [], modelo: null };
    const cat = catalogo ?? (oc ? await oc.catalogo() : []);
    // preferido(s): el del env o defecto; en audio el MODELO_AUDIO tiene
    // prioridad si está fijado, si no el orden sale del costo (gratis primero)
    const preferidos = modo === "audio" ? [cfg.modeloAudio] : [cfg.modeloAdjuntos];
    return {
      modo,
      candidatos: elegir_candidatos(modo === "audio" ? "audio" : "image", cat, preferidos),
      modelo: null,
    };
  }
}
