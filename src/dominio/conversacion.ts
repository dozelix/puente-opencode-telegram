// El diálogo con el agente (Python: class Conversacion, líneas 1138-1187).
// Manda el prompt y espera la respuesta sondeando los mensajes cada 3 s,
// hasta 12 minutos; recoge además los archivos que el agente produjo.
import * as fs from "node:fs";
import * as path from "node:path";
import { Adjunto, Opencode, es_sesion_inexistente, mensaje_de } from "../adaptadores/opencode.ts";

/** Espera de sondeo (igual que el time.sleep(3) del Python). */
function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class Conversacion {
  constructor(private readonly oc: Opencode) {}

  /** Manda el prompt. False si la sesión ya no existe (404). */
  async preguntar(sid: string, texto: string, archivos: Adjunto[] | null = null): Promise<boolean> {
    try {
      await this.oc.prompt(sid, texto || "(archivo)", archivos ?? null);
      return true;
    } catch (e) {
      if (es_sesion_inexistente(e)) return false;
      throw e;
    }
  }

  /** Espera a que el agente responda. Devuelve [texto, archivos, motivo].
   *
   * `motivo` explica por qué no hay texto cuando el turno terminó sin
   * respuesta (interrumpido, fallido o vacío): el puente lo muestra en vez de
   * un «(sin respuesta)» mudo. Antes solo se miraba el texto y, si el turno
   * cerraba sin él (p. ej. `Step interrupted`), se esperaban los 12 minutos
   * completos. */
  async esperar(
    sid: string,
    desde_ms: number,
    base: string,
    minutos = 12,
  ): Promise<[string, string[], string]> {
    const limite = Date.now() + minutos * 60 * 1000;
    while (Date.now() < limite) {
      let texto = "";
      const archivos: string[] = [];
      let hay_asistente = false;
      let fin: { outcome: string; error: string } | null = null;

      let mensajes;
      try {
        mensajes = await this.oc.mensajes(sid);
      } catch (e) {
        if (es_sesion_inexistente(e)) {
          return ["", [], "la sesión se cerró mientras esperaba la respuesta (¿/nueva o /proyecto?)"];
        }
        return ["", [], `no pude leer la respuesta: ${mensaje_de(e)}`];
      }

      for (const m of mensajes) {
        const creado = m.time?.created ?? 0;
        if (desde_ms && creado <= desde_ms) continue;
        if (m.type === "user") continue;
        if (m.type === "idle") {
          fin = { outcome: m.outcome, error: m.error?.message ?? "" };
          continue;
        }
        if (m.type !== "assistant") continue;
        hay_asistente = true;
        for (const parte of m.content ?? []) {
          if (parte.type === "text" && parte.text) texto += parte.text + "\n";
        }
        if (!m.time?.completed) continue;
        for (const ruta of m.snapshot?.files ?? []) {
          let p = ruta; // relativa a la carpeta de la sesión, si no es absoluta
          if (!path.isAbsolute(p)) p = path.join(base, p);
          if (fs.existsSync(p) && fs.statSync(p).isFile()) archivos.push(p);
        }
      }
      if (texto.trim()) return [texto.trim(), archivos, ""];
      // El turno marcó su final sin escribir texto: no hay nada que esperar.
      // Solo se cree en el aviso si el turno llegó a arrancar (hubo asistente),
      // para no confundir el idle de un turno anterior.
      if (fin && hay_asistente) {
        const detalle = fin.error ? `: ${fin.error}` : "";
        if (fin.outcome === "interrupted") {
          return ["", archivos, `el turno se interrumpió${detalle}`];
        }
        if (fin.outcome === "failed") {
          return ["", archivos, `el turno falló${detalle}`];
        }
        return ["", archivos, `el turno terminó sin texto${detalle}`];
      }
      await dormir(3000);
    }
    return ["", [], `el turno no terminó en ${minutos} minutos`];
  }
}
