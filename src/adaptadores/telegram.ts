// Cliente de la Bot API de Telegram (Python: clase Telegram, líneas 345-477).
// JSON por HTTPS con el fetch de Bun. Ninguna otra clase habla con Telegram:
// toda salida pasa por acá (invariante 4).
import { a_markdown_v2, lint_markdown_v2, partir } from "../markdown.ts";
import { LOG } from "../config.ts";
import * as fs from "node:fs";

export const API_TELEGRAM = "https://api.telegram.org";
const MS_SEGUNDO = 1000;

/** Error HTTP de la Bot API (el urllib.error.HTTPError del Python).
 * `.code` expone el estado para los chequeos 400/409 que atiende el puente. */
export class HTTPError extends Error {
  override readonly name = "HTTPError";
  readonly code: number;
  readonly cuerpo: string;

  constructor(code: number, cuerpo: string) {
    super(`HTTP Error ${code}: ${cuerpo.slice(0, 200)}`);
    this.code = code;
    this.cuerpo = cuerpo;
  }
}

/** Botones y teclados que acepta sendMessage (reply_markup). */
export interface Boton {
  text: string;
  callback_data?: string;
}
export type Markup = {
  inline_keyboard?: Boton[][];
  keyboard?: Boton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
  remove_keyboard?: boolean;
};

/** Objetos crudos de Telegram (updates, callbacks…). El puente los desenvuelve. */
export type Objeto = Record<string, unknown>;

export function guess_mime(nombre: string): string {
  const ext = nombre.includes(".") ? nombre.slice(nombre.lastIndexOf(".") + 1).toLowerCase() : "";
  const conocidos: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    html: "text/html",
    json: "application/json",
    zip: "application/zip",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    mp3: "audio/mpeg",
    wav: "audio/x-wav",
    m4a: "audio/mp4",
    webm: "video/webm",
    mp4: "video/mp4",
  };
  return conocidos[ext] ?? "application/octet-stream";
}

export class Telegram {
  constructor(private readonly token: string) {}

  private url(metodo: string): string {
    return `${API_TELEGRAM}/bot${this.token}/${metodo}`;
  }

  /** Llama a un método de la Bot API. Los errores HTTP suben como HTTPError. */
  async llamar(metodo: string, cuerpo?: Objeto, tiempo_ms = 90 * MS_SEGUNDO): Promise<Objeto> {
    const res = await fetch(this.url(metodo), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo ?? {}),
      signal: AbortSignal.timeout(tiempo_ms),
    });
    const texto = await res.text();
    if (!res.ok) throw new HTTPError(res.status, texto || res.statusText);
    if (!texto.trim()) return {};
    return JSON.parse(texto) as Objeto;
  }

  /** Long polling como el Python: 30 s de espera y 90 s de timeout de red.
   *
   * `callback_query` HACE FALTA en allowed_updates: sin ella Telegram nunca
   * entrega los toques en los botones en línea (Inicio, Ocultar teclado,
   * proyectos…) y esos botones quedaban muertos sin que nadie se enterara.
   */
  async updates(offset: number, tiempo = 30): Promise<Objeto[]> {
    const r = (await this.llamar(
      "getUpdates",
      { offset, timeout: tiempo, allowed_updates: ["message", "callback_query"] },
      (tiempo + 60) * MS_SEGUNDO,
    )) as { result?: unknown };
    return Array.isArray(r.result) ? (r.result as Objeto[]) : [];
  }

  /** Manda el texto en MarkdownV2 (con lint de por medio).
   *
   * El markup (teclado) va solo en la primera parte: Telegram acepta un
   * teclado por mensaje, no uno por cada trozo de un texto largo. */
  async send(chat_id: string, texto: string, markup?: Markup): Promise<boolean> {
    let md2: string | null = null;
    try {
      md2 = a_markdown_v2(texto);
    } catch (e) {
      console.log(`${LOG} no pude traducir a MarkdownV2: ${e instanceof Error ? e.message : String(e)}`);
    }
    const partes = partir(md2 ?? texto);
    for (let i = 0; i < partes.length; i++) {
      const parte = partes[i] ?? "";
      const cuerpo: Record<string, unknown> = { chat_id, text: parte };
      if (md2 !== null) {
        const problemas = lint_markdown_v2(parte);
        if (problemas.length) {
          console.log(`${LOG} markdown inválido: ${problemas[0]} → mando texto plano`);
        } else {
          cuerpo["parse_mode"] = "MarkdownV2";
        }
      }
      if (markup && i === 0) cuerpo["reply_markup"] = markup;
      try {
        await this.llamar("sendMessage", cuerpo);
      } catch (e) {
        if (!(e instanceof HTTPError) || !("parse_mode" in cuerpo) || e.code !== 400) throw e;
        // Telegram no lo parseó: reintento ese trozo como texto plano
        console.log(`${LOG} Telegram rechazó el markdown → texto plano`);
        delete cuerpo["parse_mode"];
        await this.llamar("sendMessage", cuerpo);
      }
    }
    return true;
  }

  /** Botones en línea: adjuntos al mensaje (se pulsan y desaparecen). */
  async send_teclado(chat_id: string, texto: string, botones: Boton[][]): Promise<boolean> {
    return this.send(chat_id, texto, { inline_keyboard: botones });
  }

  /** Teclado fijo: la barra de botones que queda bajo el campo de texto. */
  async send_teclado_fijo(
    chat_id: string,
    texto: string,
    botones: Boton[][],
    placeholder = "",
  ): Promise<boolean> {
    const markup: Markup = { keyboard: botones, resize_keyboard: true, one_time_keyboard: false };
    if (placeholder) markup["input_field_placeholder"] = placeholder.slice(0, 64);
    return this.send(chat_id, texto, markup);
  }

  /** Saca la barra de botones del chat. */
  async quitar_teclado(chat_id: string, texto = "🫥 Teclado oculto."): Promise<boolean> {
    return this.send(chat_id, texto, { keyboard: [], remove_keyboard: true });
  }

  /** Confirma el toque en un botón en línea (el aviso de arriba). */
  async answer_callback(callback_id: string, texto = ""): Promise<boolean> {
    const cuerpo: Record<string, unknown> = { callback_query_id: callback_id };
    if (texto) cuerpo["text"] = texto.slice(0, 200);
    try {
      await this.llamar("answerCallbackQuery", cuerpo);
      return true;
    } catch (e) {
      console.log(`${LOG} no pude responder al callback: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Edita un mensaje ya enviado (para que el botón no quede mentiroso). */
  async edit_text(chat_id: string, message_id: number, texto: string, markup?: Markup): Promise<boolean> {
    let md2: string;
    try {
      md2 = a_markdown_v2(texto);
    } catch {
      md2 = texto;
    }
    const cuerpo: Record<string, unknown> = { chat_id, message_id, text: md2 };
    if (!lint_markdown_v2(md2).length) cuerpo["parse_mode"] = "MarkdownV2";
    if (markup) cuerpo["reply_markup"] = markup;
    try {
      await this.llamar("editMessageText", cuerpo);
      return true;
    } catch (e) {
      console.log(`${LOG} no pude editar el mensaje: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Avisa a Telegram que el bot está «escribiendo» (dura ~5 s). */
  async typing(chat_id: string): Promise<boolean> {
    try {
      await this.llamar("sendChatAction", { chat_id, action: "typing" });
      return true;
    } catch (e) {
      console.log(`${LOG} no pude enviar typing: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** Manda un archivo como documento (multipart como el Python). */
  async send_file(chat_id: string, ruta: string, pie = ""): Promise<boolean> {
    const datos = new Uint8Array(fs.readFileSync(ruta));
    const nombre = ruta.includes("/") ? ruta.slice(ruta.lastIndexOf("/") + 1) : ruta;
    const fd = new FormData();
    fd.append("chat_id", chat_id);
    if (pie) fd.append("caption", pie.slice(0, 200));
    fd.append("document", new Blob([datos], { type: guess_mime(nombre) }), nombre);
    const res = await fetch(this.url("sendDocument"), {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(180 * MS_SEGUNDO),
    });
    const texto = await res.text();
    if (!res.ok) throw new HTTPError(res.status, texto || res.statusText);
    return true;
  }

  /** Baja un archivo por file_id. Devuelve (datos, nombre). */
  async descargar(file_id: string): Promise<[Uint8Array, string]> {
    const info = (await this.llamar("getFile", { file_id })) as { result?: unknown };
    const f = (info.result && typeof info.result === "object" ? info.result : {}) as { file_path?: string };
    const ruta = f.file_path;
    if (!ruta) throw new Error("Telegram no devolvió el archivo");
    const res = await fetch(`${API_TELEGRAM}/file/bot${this.token}/${ruta}`, {
      signal: AbortSignal.timeout(180 * MS_SEGUNDO),
    });
    if (!res.ok) throw new HTTPError(res.status, res.statusText);
    const datos = new Uint8Array(await res.arrayBuffer());
    const nombre = ruta.includes("/") ? ruta.slice(ruta.lastIndexOf("/") + 1) : ruta;
    return [datos, nombre];
  }
}
