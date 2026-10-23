// Estado del puente (Python: líneas 642-677).
// Shape idéntico a la producción: sesiones, dirs, ultimo_ms, teclado, offset.
//
// Ruta: por defecto es la misma del puente Python (`~/.local/state/
// telegram-saulo`). La variable de entorno PUENTE_ESTADO_DIR permite apuntar
// el estado a otra carpeta (la usa la autoprueba para no tocar el estado real
// de producción); sin esa variable el comportamiento es idéntico al Python.
import * as fs from "node:fs";
import * as os from "node:os";

/** El estado guarda: qué sesión vive en cada chat, en qué carpeta, hasta qué
 * ms se le entregó respuesta, si el teclado fijo está puesto y el offset de
 * getUpdates (si el puente se reinicia, no re-procesa lo ya atendido). */
export interface Estado {
  sesiones?: Record<string, string>;
  dirs?: Record<string, string>;
  ultimo_ms?: Record<string, number>;
  teclado?: Record<string, boolean>;
  offset?: number;
}

const CASA = os.homedir();
const ESTADO_DEFECTO = `${CASA}/.local/state/telegram-saulo`;

/** Constantes del defecto (igual que en el puente Python; para quien las
 * lea directamente). La ruta VIGENTE sale de dir_estado()/dir_adjuntos(). */
export const ESTADO_DIR = ESTADO_DEFECTO;
export const ADJUNTOS_DIR = `${ESTADO_DIR}/adjuntos`;

/** La carpeta de estado VIGENTE: PUENTE_ESTADO_DIR si está puesto, si no
 * el defecto de producción. Se lee en cada llamada (no al importar) para
 * que la autoprueba pueda fijarla antes de usar las funciones. */
export function dir_estado(): string {
  const alterna = (process.env["PUENTE_ESTADO_DIR"] ?? "").trim();
  return alterna || ESTADO_DEFECTO;
}

/** Carpeta de adjuntos vigente (hija de la de estado). */
export function dir_adjuntos(): string {
  return `${dir_estado()}/adjuntos`;
}

function es_objeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function estado_path(): string {
  const dir = dir_estado();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(`${dir}/adjuntos`, { recursive: true });
  return `${dir}/estado.json`;
}

export function leer_estado(): Estado {
  const p = estado_path();
  try {
    if (fs.existsSync(p)) {
      const d: unknown = JSON.parse(fs.readFileSync(p, "utf8"));
      if (es_objeto(d)) return d as Estado;
    }
  } catch {
    // estado roto: se empieza de cero (igual que el Python)
  }
  return {};
}

/** Escritura atómica (tmp + rename: invariante 5 — el estado se escribe entero). */
export function guardar_estado(d: Estado): void {
  const dir = dir_estado();
  const p = `${dir}/estado.json`;
  const tmp = `${dir}/estado.tmp`; // Python: p.with_suffix(".tmp")
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1), "utf8");
  fs.renameSync(tmp, p);
}

/** Anota si la barra de botones está puesta en este chat. */
export function marcar_teclado(chat_id: string, visible: boolean): void {
  const st = leer_estado();
  const teclado = st.teclado ?? {};
  teclado[chat_id] = visible;
  st.teclado = teclado;
  guardar_estado(st);
}
