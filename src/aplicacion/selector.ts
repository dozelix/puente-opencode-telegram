// La pantalla de elegir proyecto (Python: class Selector, líneas 1188-1321,
// y los helpers de proyectos, líneas 673-778). Listado, botones y atajos.
// No habla con el agente: solo abre sesiones (a través de Sesiones) y
// dibuja botones.
import * as fs from "node:fs";
import * as path from "node:path";
import { RAIZ } from "../config.ts";
import { marcar_teclado, leer_estado } from "../estado.ts";
import type { Boton, Markup, Objeto } from "../adaptadores/telegram.ts";
import type { Sesiones } from "../dominio/sesiones.ts";
import { permitido } from "../entrada/update.ts";

/** Lo que `Selector` pide de Telegram. `Telegram` cumple la interfaz; la
 * autoprueba puede inyectar un doble que capture las llamadas. */
export interface SalidaBotones {
  send(chat_id: string, texto: string, markup?: Markup): Promise<boolean>;
  send_teclado(chat_id: string, texto: string, botones: Boton[][]): Promise<boolean>;
  send_teclado_fijo(
    chat_id: string,
    texto: string,
    botones: Boton[][],
    placeholder?: string,
  ): Promise<boolean>;
  quitar_teclado(chat_id: string, texto?: string): Promise<boolean>;
  answer_callback(callback_id: string, texto?: string): Promise<boolean>;
  edit_text(chat_id: string, message_id: number, texto: string, markup?: Markup): Promise<boolean>;
}

/** Carpetas de trabajo de la casa: ~/Proyectos/* (los proyectos de verdad).
 * NO hay proyecto pineado: la sesión ES el estado, y su directorio real
 * (el que devuelve el servidor) es la carpeta en la que estamos. */
export function proyectos_de_casa(): string[] {
  const base = path.join(RAIZ, "Proyectos");
  if (!es_dir(base)) return [];
  return fs
    .readdirSync(base)
    .filter((n) => !n.startsWith(".") && es_dir(path.join(base, n)))
    .map((n) => path.join(base, n));
}

// Botones de control del teclado (no son proyectos: el puente los atiende aparte)
export const CTRL_INICIO = "inicio";
export const CTRL_OCULTAR = "ocultar";
export const CTRL_PROYECTOS = "proyectos";
export const CONTROLES = new Set([CTRL_INICIO, CTRL_OCULTAR, CTRL_PROYECTOS]);

function es_alnum(caracter: string): boolean {
  return /^[\p{L}\p{N}]+$/u.test(caracter);
}

/** Saca el emoji o símbolo del principio ("🏠 Inicio" → "Inicio"). */
export function sin_emoji(texto: string): string {
  let puntos = Array.from(texto.trim());
  while (puntos.length && !(es_alnum(puntos[0]) || "_-.".includes(puntos[0]))) {
    puntos.shift();
    // Python: t[1:].lstrip() — el espacio que deja el emoji también se va
    while (puntos.length && /^\s$/u.test(puntos[0])) puntos.shift();
  }
  return puntos.join("").trim();
}

function es_dir(ruta: string): boolean {
  try {
    return fs.statSync(ruta).isDirectory();
  } catch {
    return false;
  }
}

function real(ruta: string): string {
  try {
    return fs.realpathSync(ruta);
  } catch {
    return path.resolve(ruta);
  }
}

/** El Python usaba os.path.expanduser: ~ y ~/ruta van al home. */
function expandir_hogar(ruta: string): string {
  if (ruta === "~") return RAIZ;
  if (ruta.startsWith("~/")) return path.join(RAIZ, ruta.slice(2));
  return ruta;
}

/** Resuelve un nombre de proyecto (o una ruta) a su carpeta.
 *
 * Acepta: «huachi-sport», «~/Proyectos/huachi-sport», «/ruta/absoluta».
 */
export function resolver_proyecto(texto: string): string | null {
  const crudo = texto.trim().replace(/^['"]+|['"]+$/g, "");
  if (!crudo) return null;
  const p = expandir_hogar(crudo);
  if (es_dir(p)) return real(p);
  const base = path.join(RAIZ, "Proyectos");
  const cand = path.join(base, crudo);
  if (es_dir(cand)) return real(cand);
  if (es_dir(base)) {
    for (const d of fs.readdirSync(base)) {
      const ruta = path.join(base, d);
      if (es_dir(ruta) && d.toLowerCase() === crudo.toLowerCase()) return real(ruta);
    }
  }
  return null;
}

/** Los proyectos de casa, ordenados por nombre. */
export function proyectos_ordenados(): string[] {
  return [...proyectos_de_casa()].sort((a, b) => {
    const na = a.slice(a.lastIndexOf("/") + 1).toLowerCase();
    const nb = b.slice(b.lastIndexOf("/") + 1).toLowerCase();
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
}

/** El nombre corto de una carpeta (el p.name del Python). */
export function nombre(ruta: string): string {
  return ruta.slice(ruta.lastIndexOf("/") + 1);
}

/** Botones en línea: un botón por proyecto (tecla «proy:<ruta>»). */
export function botones_proyectos(filas = 2, activo = ""): Boton[][] {
  const proyectos = proyectos_ordenados();
  if (!proyectos.length) return [];
  const teclado: Boton[][] = [];
  let fila: Boton[] = [];
  for (const p of proyectos) {
    const marca = activo && p === activo ? " ✅" : "";
    fila.push({ text: `📂 ${nombre(p)}${marca}`, callback_data: `proy:${p}` });
    if (fila.length === filas) {
      teclado.push(fila);
      fila = [];
    }
  }
  if (fila.length) teclado.push(fila);
  teclado.push([
    { text: "🏠 Inicio", callback_data: CTRL_INICIO },
    { text: "🙈 Ocultar teclado", callback_data: CTRL_OCULTAR },
  ]);
  return teclado;
}

/** Barra fija de botones: un botón por proyecto + los controles. */
export function teclado_proyectos(): Boton[][] {
  const proyectos = proyectos_ordenados();
  const teclado: Boton[][] = [];
  let fila: Boton[] = [];
  for (const p of proyectos) {
    fila.push({ text: nombre(p) });
    if (fila.length === 2) {
      teclado.push(fila);
      fila = [];
    }
  }
  if (fila.length) teclado.push(fila);
  teclado.push([{ text: "🏠 Inicio" }, { text: "🙈 Ocultar" }]);
  return teclado;
}

export class Selector {
  constructor(
    private readonly tg: SalidaBotones,
    private readonly sesiones: Sesiones,
  ) {}

  /** Manda el listado de proyectos: botones en línea + barra fija abajo. */
  async listar(chat_id: string): Promise<void> {
    const proyectos = proyectos_ordenados();
    if (!proyectos.length) {
      await this.tg.send(chat_id, `⚠️ No encontré proyectos en \`${path.join(RAIZ, "Proyectos")}\`.`);
      return;
    }
    const actual = await this.sesiones.directorio_de(chat_id);
    const lista = proyectos.map((p) => `• \`${nombre(p)}\``).join("\n");
    await this.tg.send_teclado(
      chat_id,
      `🗂 *Proyectos* (${proyectos.length})\n\n${lista}\n\n` +
        `_Ahora: \`${actual}\`_ — tocá uno para trabajar en él.`,
      botones_proyectos(2, actual),
    );
    await this._poner_teclado(chat_id);
  }

  /** Dónde estamos, con los botones para cambiar. */
  async mostrar_actual(chat_id: string): Promise<void> {
    const actual = await this.sesiones.directorio_de(chat_id);
    await this.tg.send_teclado(
      chat_id,
      `📂 Trabajamos en: \`${actual}\`\n\nElegí un proyecto (o escribí /proyecto ~/ruta):`,
      botones_proyectos(2, actual),
    );
  }

  /** Abre una sesión nueva en el proyecto indicado. Devuelve la ruta real. */
  async cambiar(chat_id: string, ruta: string): Promise<string | null> {
    return this.sesiones.cambiar_proyecto(chat_id, ruta);
  }

  /** Un toque en la barra fija. True si el mensaje era un atajo. */
  async atajo(chat_id: string, texto: string): Promise<boolean> {
    const limpio = sin_emoji(texto);
    if (!limpio) return false;
    const control = limpio.toLowerCase();
    if (control === CTRL_OCULTAR) {
      await this.ocultar_teclado(chat_id);
      return true;
    }
    if (control === CTRL_PROYECTOS) {
      await this.listar(chat_id);
      return true;
    }
    if (control === CTRL_INICIO) {
      await this.sesiones.sesion_de(chat_id, true, RAIZ);
      const real_actual = await this.sesiones.directorio_de(chat_id);
      await this.tg.send(chat_id, `🏠 Modo general: sesión nueva en \`${real_actual}\`.`);
      return true;
    }
    // el nombre de un proyecto (o su ruta) también cambia de proyecto
    const destino = resolver_proyecto(limpio);
    if (destino) {
      const nuevo = await this.cambiar(chat_id, destino);
      if (nuevo) await this.tg.send(chat_id, `✅ Ahora trabajo en \`${nuevo}\` (sesión nueva).`);
      return true;
    }
    return false;
  }

  /** Un toque en un botón: cambia de proyecto o vuelve al modo general. */
  async callback(cb: Objeto): Promise<void> {
    const cid = typeof cb["id"] === "string" ? (cb["id"] as string) : "";
    const data = String(cb["data"] ?? "").trim();
    const mensaje = objeto(cb, "message");
    const chat = objeto(mensaje, "chat");
    const chat_id = typeof chat["id"] === "string" || typeof chat["id"] === "number"
      ? String(chat["id"])
      : "";
    const mid = mensaje["message_id"];
    if (!chat_id || chat_id === "None") return;
    if (!permitido(chat_id)) {
      const quien = cadena_de(cb, "from", "username") ?? "?";
      console.log(`${LOG} RECHAZADO · callback · chat ${chat_id} · @${quien} · ${data}`);
      return;
    }
    console.log(`${LOG} callback · chat ${chat_id} · ${data}`);

    if (data === "ocultar") {
      await this.tg.answer_callback(cid, "🙈 Listo");
      await this.ocultar_teclado(chat_id);
      if (typeof mid === "number") {
        await this.tg.edit_text(chat_id, mid, "🙈 Teclado oculto.", { inline_keyboard: [] });
      }
      return;
    }

    if (data === "inicio") {
      await this.sesiones.sesion_de(chat_id, true, RAIZ);
      const real_actual = await this.sesiones.directorio_de(chat_id);
      await this.tg.answer_callback(cid, "🏠 Modo general");
      await this._anunciar(chat_id, mid, `🏠 Ahora trabajo en \`${real_actual}\` (modo general).`, real_actual);
      return;
    }

    if (data.startsWith("proy:")) {
      const ruta = data.slice("proy:".length);
      const nuevo = await this.cambiar(chat_id, ruta);
      if (!nuevo) {
        await this.tg.answer_callback(cid, "⚠️ No existe");
        return;
      }
      await this.tg.answer_callback(cid, `📂 ${nombre(nuevo)}`);
      await this._anunciar(chat_id, mid, `✅ Ahora trabajo en \`${nuevo}\` (sesión nueva).`, nuevo);
      return;
    }

    await this.tg.answer_callback(cid);
  }

  /** Pone la barra de botones abajo del chat (una sola vez). */
  private async _poner_teclado(chat_id: string): Promise<void> {
    const st = leer_estado();
    if ((st.teclado ?? {})[chat_id]) return;
    marcar_teclado(chat_id, true);
    await this.tg.send_teclado_fijo(
      chat_id,
      "⌨️ Teclado de proyectos abajo (se saca con «Ocultar»).",
      teclado_proyectos(),
      "Elegí un proyecto…",
    );
  }

  /** Saca la barra de botones del chat. */
  async ocultar_teclado(chat_id: string): Promise<void> {
    await this.tg.quitar_teclado(chat_id);
    marcar_teclado(chat_id, false);
  }

  /** Edita el mensaje del botón (si existe) o manda uno nuevo. */
  private async _anunciar(chat_id: string, mid: unknown, texto: string, activo: string): Promise<void> {
    if (typeof mid === "number") {
      await this.tg.edit_text(chat_id, mid, texto, {
        inline_keyboard: botones_proyectos(2, activo),
      });
    } else {
      await this.tg.send(chat_id, texto);
    }
  }
}

// ----------------------------------------------------------------- utilidades
function objeto(o: Objeto, k: string): Objeto {
  const v = o[k];
  return typeof v === "object" && v !== null ? (v as Objeto) : {};
}

function cadena_de(o: Objeto, k: string, sub: string): string | undefined {
  const v = (o[k] as Objeto | undefined)?.[sub];
  return typeof v === "string" ? v : undefined;
}

const LOG = "[puente]";
