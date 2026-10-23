// Los comandos del bot (Python: class Comandos, líneas 1322-1419, y el texto
// de la ayuda, líneas 782-800). Cada método hace una sola cosa.
// Responsabilidad única: traducir una intención del usuario en acciones.
// No sabe de archivos ni de prompts: usa Sesiones y Selector.
import { CONFIG, RAIZ } from "../config.ts";
import type { Markup } from "../adaptadores/telegram.ts";
import type { Opencode } from "../adaptadores/opencode.ts";
import type { Sesiones } from "../dominio/sesiones.ts";
import { botones_proyectos, type Selector } from "./selector.ts";

/** Lo que `Comandos` pide de Telegram: el send (y el teclado del saludo). */
export interface SalidaTexto {
  send(chat_id: string, texto: string, markup?: Markup): Promise<boolean>;
  send_teclado(chat_id: string, texto: string, botones: ReturnType<typeof botones_proyectos>): Promise<boolean>;
}

/** Texto de /ayuda (se arma en el momento: el proyecto puede cambiar).
 * Los literales van tal cual el Python para que la ayuda no cambie. */
export function ayuda(): string {
  return `👋 *Saulo* — tu agente en el computador.

Escríbeme lo que necesites y te respondo acá. También recibo archivos (fotos
o documentos): los leo desde el computador y te devuelvo los que produzca.

*Comandos*
/ayuda — esta ayuda
/nueva — sesión nueva en modo general (en \`/home/dozelix\`)
/proyectos — ver y elegir proyecto (botones)
/proyecto — ver en qué carpeta estamos
/estado — ver la sesión y la carpeta
/si — aprobar un permiso que te pida
/no — rechazar un permiso

_Con los botones de abajo cambiás de proyecto al toque: al elegir uno se abre
una sesión nueva en esa carpeta. «Inicio» vuelve al modo general (el home)._
`;
}

/** La tabla de comandos: cada texto manda a un método (el getattr del Python). */
type Metodo = "saludo" | "ayuda" | "nueva" | "proyectos" | "proyecto" | "estado" | "si" | "no";
const COMANDOS: Record<string, Metodo> = {
  "/start": "saludo",
  "/ayuda": "ayuda",
  "/help": "ayuda",
  "/nueva": "nueva",
  "/proyectos": "proyectos",
  "/proys": "proyectos",
  "/ls": "proyectos",
  "/proyecto": "proyecto",
  "/estado": "estado",
  "/si": "si",
  "/no": "no",
};

export class Comandos {
  constructor(
    private readonly tg: SalidaTexto,
    private readonly sesiones: Sesiones,
    private readonly oc: Opencode,
    private readonly selector: Selector,
  ) {}

  /** Si el texto es un comando, lo ejecuta. True si era comando. */
  async atender(chat_id: string, texto: string): Promise<boolean> {
    if (!texto.startsWith("/")) return false;
    // Python: texto.split(maxsplit=1) — el comando es la primera palabra y
    // el resto queda tal cual (se le quita solo el espacio de la izquierda)
    const limpio = texto.trim();
    const corte = limpio.search(/\s/);
    const comando = corte < 0 ? limpio : limpio.slice(0, corte);
    const argumento = corte < 0 ? "" : limpio.slice(corte).replace(/^\s+/, "");
    const metodo = COMANDOS[comando.toLowerCase()];
    if (!metodo) return false;
    await this[metodo](chat_id, argumento);
    return true;
  }

  // --- un método por comando: una responsabilidad cada uno ---

  /** Bienvenida: qué soy, dónde estamos y el selector de proyectos. */
  async saludo(chat_id: string, _argumento = ""): Promise<void> {
    const actual = await this.sesiones.directorio_de(chat_id);
    await this.tg.send_teclado(
      chat_id,
      "👋 ¡Hola! Soy *Saulo*, tu agente en el computador.\n\n" +
        "Escríbeme lo que necesites y te respondo acá.\n" +
        `Trabajamos en: \`${actual}\``,
      botones_proyectos(2, actual),
    );
  }

  /** El manual: la lista de comandos. */
  async ayuda(chat_id: string, _argumento = ""): Promise<void> {
    await this.tg.send(chat_id, ayuda());
  }

  /** Una sesión nueva en modo general (el home, sin proyecto). */
  async nueva(chat_id: string, _argumento = ""): Promise<void> {
    await this.sesiones.sesion_de(chat_id, true, RAIZ);
    const real_actual = await this.sesiones.directorio_de(chat_id);
    await this.tg.send(
      chat_id,
      `✅ Sesión nueva abierta en \`${real_actual}\`\n` +
        "(modo general) · elegí un proyecto con /proyectos",
    );
  }

  /** El listado de proyectos, con botones. */
  async proyectos(chat_id: string, _argumento = ""): Promise<void> {
    await this.selector.listar(chat_id);
  }

  /** Ver la carpeta actual, o cambiar a la que se le pase. */
  async proyecto(chat_id: string, argumento = ""): Promise<void> {
    if (!argumento) {
      await this.selector.mostrar_actual(chat_id);
      return;
    }
    const nuevo = await this.selector.cambiar(chat_id, argumento);
    if (nuevo) {
      await this.tg.send(chat_id, `✅ Ahora trabajo en \`${nuevo}\` (sesión nueva).`);
    } else {
      await this.tg.send(
        chat_id,
        "⚠️ Esa ruta no existe. Probá con el nombre de un proyecto de la lista (/proyectos).",
      );
    }
  }

  /** Dónde estamos y con qué sesión. */
  async estado(chat_id: string, _argumento = ""): Promise<void> {
    const sid = await this.sesiones.sesion_de(chat_id);
    await this.tg.send(
      chat_id,
      `📍 \`${await this.sesiones.directorio_de(chat_id)}\`\n` +
        `Sesión: \`${sid}\`\nAgente: ${CONFIG.agente}`,
    );
  }

  /** Aprueba el permiso pendiente. */
  async si(chat_id: string, _argumento = ""): Promise<void> {
    await this._permiso(chat_id, "once");
  }

  /** Rechaza el permiso pendiente. */
  async no(chat_id: string, _argumento = ""): Promise<void> {
    await this._permiso(chat_id, "reject");
  }

  /** Resuelve el primer permiso pendiente de la sesión. */
  private async _permiso(chat_id: string, decision: "once" | "always" | "reject"): Promise<void> {
    const sid = await this.sesiones.sesion_de(chat_id);
    for (const p of await this.oc.permisos(sid)) {
      if (p.id && (await this.oc.responder_permiso(sid, p.id, decision))) {
        await this.tg.send(
          chat_id,
          decision === "once" ? "✅ Permiso aprobado." : "🚫 Permiso rechazado.",
        );
        return;
      }
    }
    await this.tg.send(chat_id, "No hay permisos pendientes.");
  }
}
