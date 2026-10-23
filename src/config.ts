// Configuración del puente (Python: cargar_config, líneas 44-96 + arranque 1778-1786).
// El contenido del env nunca se imprime: solo se leen las variables.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LOG = "[puente]";

const RUTA_ENV = path.join(os.homedir(), ".config/opencode/telegram.env");
export { RUTA_ENV };

export interface Config {
  token: string;
  chatFijo: string;
  agente: string;
  /** BASE del Python: el home del usuario (base de rutas relativas). */
  raiz: string;
  /** Prioridad manual para los turnos de voz (env MODELO_AUDIO). Vacío = el
   * Router elige del catálogo vivo, gratis primero; whisper queda al final. */
  modeloAudio: string;
  /** Modelo con VISIÓN para los turnos con imagen. */
  modeloAdjuntos: string;
  /** Respaldo de URL del servidor si el registro del servicio no existe. */
  urlServidor: string;
  whisperBin: string;
  whisperModelo: string;
  vozIdioma: string;
}

function leer_env(ruta: string): Record<string, string> {
  const cfg: Record<string, string> = {};
  let crudo: string;
  try {
    crudo = fs.readFileSync(ruta, "utf8");
  } catch {
    return cfg; // sin env: se sigue; el fail-closed decide al arrancar
  }
  for (const linea0 of crudo.split(/\r?\n/)) {
    const linea = linea0.trim();
    if (!linea || linea.startsWith("#") || !linea.includes("=")) continue;
    const i = linea.indexOf("=");
    const k = linea.slice(0, i).trim();
    const v = linea.slice(i + 1).trim().replace(/^['"]+|['"]+$/g, "");
    cfg[k] = v;
  }
  return cfg;
}

export function cargar_config(): Config {
  const c = leer_env(RUTA_ENV);
  // del entorno solo el token y el chat fijo: el runtime trae variables propias
  for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] as const) {
    const v = process.env[k];
    if (v) c[k] = v;
  }
  if (!c["TELEGRAM_BOT_TOKEN"] && c["telegram"]) c["TELEGRAM_BOT_TOKEN"] = c["telegram"];
  const casa = os.homedir();
  return {
    token: c["TELEGRAM_BOT_TOKEN"] ?? "",
    chatFijo: c["TELEGRAM_CHAT_ID"] ?? "",
    agente: c["AGENT"] || "saulo",
    raiz: casa,
    /** Prioridad manual de audio (env MODELO_AUDIO). Vacío = el Router elige
     * del catálogo vivo, gratis primero (hoy: mimo-v2.6-flash-free). */
    modeloAudio: (c["MODELO_AUDIO"] ?? "").trim(),
    /** Preferido para imagen. Es el PRIMER candidato, no un punto único de
     * fallo: si el catálogo no lo lista o el cambio falla, se usa el
     * siguiente candidato disponible (hoy tu clave propia de Google). */
    modeloAdjuntos: (c["MODELO_ADJUNTOS"] || "console-google/gemini-3.8-flash").trim(),
    urlServidor: (c["OPENCODE_URL"] ?? "").replace(/\/+$/, ""),
    whisperBin: c["WHISPER_BIN"] || path.join(casa, ".local/bin/whisper-cli"),
    whisperModelo: c["WHISPER_MODEL"] || path.join(casa, ".local/share/whisper/models/ggml-base.bin"),
    vozIdioma: c["VOZ_IDIOMA"] || "es",
  };
}

/** Config cargada una vez (el CFG del Python). */
export const CONFIG = cargar_config();
/** El home: el modo general del agente (sin proyecto). */
export const RAIZ = CONFIG.raiz;

/** Fail-closed (invariante 11): sin token o sin TELEGRAM_CHAT_ID el puente NO
 * arranca. Devuelve el texto del error, o null si se puede arrancar. */
export function validar_arranque(cfg: Config = CONFIG): string | null {
  if (!cfg.token) return `Falta el token del bot en ${RUTA_ENV}`;
  if (!cfg.chatFijo) {
    return `Falta TELEGRAM_CHAT_ID en ${RUTA_ENV}: el bot queda cerrado. No arranco.`;
  }
  return null;
}
