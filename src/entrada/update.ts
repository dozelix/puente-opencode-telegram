// Helpers de-update y filtro de seguridad (Python: líneas 803-871).
// Viven en su propio módulo para que `Selector` y `Puente` los compartan sin
// hacerse importaciones circulares: el comportamiento es el mismo que en el
// Python, donde eran funciones de nivel de módulo.
import { CONFIG } from "../config.ts";
import type { Objeto } from "../adaptadores/telegram.ts";

/** Devuelve el campo como objeto, o undefined si no es un objeto. */
export function campo(o: Objeto, k: string): Objeto | undefined {
  const v = o[k];
  return es_objeto(v) ? (v as Objeto) : undefined;
}

function es_objeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Saca el valor de un campo como cadena (vacío si no es cadena). */
export function cadena(o: Objeto, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : "";
}

/** Saca el campo anidado como cadena con defecto (Python: d.get(k, defecto)). */
export function cadena_en(o: Objeto | undefined, k: string, defecto: string): string {
  const v = o?.[k];
  return typeof v === "string" && v ? v : defecto;
}

/** Saca el campo anidado como objeto ({}, si falta). */
export function objeto_en(o: Objeto | undefined, k: string): Objeto {
  return campo(o ?? {}, k) ?? {};
}

/** Saca (tipo, mensaje) de un update de Telegram.
 *
 * OJO: Telegram envuelve el contenido: {"update_id": N, "message": {...}}.
 * El texto vive en update["message"]["text"], no en update["text"].
 */
export function desenvolver(update: Objeto): [string, Objeto] {
  for (const clave of ["message", "edited_message", "channel_post"]) {
    if (es_objeto(update[clave])) return [clave, update[clave] as Objeto];
  }
  for (const clave of ["my_chat_member", "chat_member"]) {
    if (es_objeto(update[clave])) return [clave, update[clave] as Objeto];
  }
  const cb = update["callback_query"];
  if (es_objeto(cb)) {
    const cb_obj = cb as Objeto;
    return ["callback_query", objeto_en(cb_obj, "message")];
  }
  return ["desconocido", {}];
}

/** (chat_id, texto, nombre_archivo) de un mensaje. */
export function datos_del_mensaje(mensaje: Objeto): [string, string, string] {
  const chat = objeto_en(mensaje, "chat")["id"];
  const texto = (cadena(mensaje, "text") || cadena(mensaje, "caption")).trim();
  let archivo = "";
  if ("voice" in mensaje) {
    archivo = "nota-de-voz.ogg";
  } else if ("audio" in mensaje) {
    archivo = cadena_en(campo(mensaje, "audio"), "file_name", "audio.mp3");
  } else if ("document" in mensaje) {
    archivo = cadena_en(campo(mensaje, "document"), "file_name", "documento");
  } else if ("photo" in mensaje) {
    archivo = "foto.jpg";
  }
  // Python: str(chat) — el id puede venir como número; vacío si no está
  return [typeof chat === "string" || typeof chat === "number" ? String(chat) : "", texto, archivo];
}

/** ¿El mensaje trae un archivo (foto, documento o audio)? */
export function tiene_adjunto(mensaje: Objeto): boolean {
  return ["voice", "audio", "document", "photo"].some((k) => k in mensaje);
}

/** El file_id del adjunto que trae el mensaje. */
export function archivo_id(mensaje: Objeto): string {
  if ("voice" in mensaje) return cadena_en(campo(mensaje, "voice"), "file_id", "");
  if ("audio" in mensaje) return cadena_en(campo(mensaje, "audio"), "file_id", "");
  if ("document" in mensaje) return cadena_en(campo(mensaje, "document"), "file_id", "");
  if ("photo" in mensaje) {
    const fotos = campo(mensaje, "photo");
    if (Array.isArray(fotos) && fotos.length) {
      const ultima = fotos[fotos.length - 1];
      if (es_objeto(ultima)) return cadena_en(ultima as Objeto, "file_id", "");
    }
  }
  return "";
}

/** ¿El adjunto es una nota de voz (o un audio)? */
export function es_voz(mensaje: Objeto): boolean {
  return "voice" in mensaje || "audio" in mensaje;
}

/** ¿Este chat puede hablar con el bot? Solo el chat fijado.
 *
 * **Fail-closed a propósito**: si `TELEGRAM_CHAT_ID` está vacío (env roto,
 * variable renombrada, carga fallida) el bot NO habla con nadie. Un bot
 * abierto a internet es peor que un bot mudo, y el fallo sería silencioso.
 *
 * El parámetro `cfg` solo existe para la autoprueba: en producción se omite
 * y sale de CONFIG (igual que el CHAT_FIJO del Python). */
export function permitido(chat_id: string, cfg: { chatFijo: string } = CONFIG): boolean {
  if (!cfg.chatFijo) return false;
  return chat_id === cfg.chatFijo;
}
