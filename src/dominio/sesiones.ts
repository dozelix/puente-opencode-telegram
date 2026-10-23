// Qué sesión vive en cada chat y en qué carpeta (Python: class Sesiones,
// líneas 897-977). La sesión ES el estado (invariante 1): la carpeta real
// sale del servidor (location.directory); `estado.json["dirs"]` es solo
// caché. /nueva siempre vuelve al modo general: el home (invariante 2).
import { LOG, RAIZ } from "../config.ts";
import { guardar_estado, leer_estado } from "../estado.ts";
import { Opencode } from "../adaptadores/opencode.ts";
import { resolver_proyecto } from "../aplicacion/selector.ts";

/** Exclusión mutua para código asíncrono.
 *
 * El Python usaba `threading.RLock` porque el estado se toca desde varios
 * hilos; en Bun no hay hilos, pero las llamadas asíncronas se entrelazan
 * (dos mensajes de chats distintos procesándose a la vez). El candado encola
 * por promesas: quien entra, sale solo cuando terminó TODO su trabajo
 * (incluidas las llamadas al servidor). `Sesiones` no anida candados, así
 * que no se necesita la re-entrada del RLock.
 */
export class Mutex {
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  #cadena: Promise<any> = Promise.resolve(null);

  /** Corre `f` con exclusión mutua: no se en planta hasta que otra tarea con
   * el candado haya terminado por completo (éxito o error). */
  con<T>(f: () => Promise<T> | T): Promise<T> {
    const antes = this.#cadena; // lo que ya está en la fila, si algo
    let liberar!: () => void;
    this.#cadena = new Promise<void>((resume) => {
      liberar = () => resume();
    });
    return antes.then(f).finally(liberar);
  }
}

export class Sesiones {
  /** El estado se toca desde varias tareas a la vez: candado sí o sí. */
  private readonly candado = new Mutex();

  constructor(private readonly oc: Opencode) {}

  /** La carpeta en que se está trabajando ahora mismo.
   *
   * No hay proyecto «pineado»: la sesión ES el estado, y el servidor es
   * la fuente de verdad de su directorio.
   */
  async directorio_de(chat_id: string): Promise<string> {
    const st = leer_estado();
    const sid = (st.sesiones ?? {})[chat_id];
    if (!sid) return RAIZ;
    const guardado = (st.dirs ?? {})[chat_id];
    if (guardado) return guardado;
    const real = await this.oc.directorio_de_sesion(sid);
    if (real) {
      const fresco = leer_estado();
      fresco.dirs = fresco.dirs ?? {};
      fresco.dirs[chat_id] = real;
      guardar_estado(fresco);
      return real;
    }
    return RAIZ;
  }

  /** La sesión viva de este chat (se crea si no hay o si murió).
   *
   * Si la sesión guardada ya no existe en el servidor, se rehace EN EL
   * MISMO LUGAR: no se pierde el contexto del trabajo.
   */
  async sesion_de(chat_id: string, nueva = false, directorio = ""): Promise<string> {
    let viejo = "";
    const sid = await this.candado.con(async () => {
      let st = leer_estado();
      if (!nueva) {
        const guardada = (st.sesiones ?? {})[chat_id];
        if (guardada) {
          if (await this.oc.existe(guardada)) return guardada;
          console.log(`${LOG} la sesión ${guardada} ya no existe: creo otra`);
        }
      }
      viejo = (st.sesiones ?? {})[chat_id] ?? "";
      // dónde abrir la nueva: lo pedido, si no donde ya estábamos
      let destino = directorio || (st.dirs ?? {})[chat_id] || "";
      if (!destino) {
        // sin sesión previa no hay directorio que consultar (el 400 es seguro)
        destino = (viejo ? await this.oc.directorio_de_sesion(viejo) : "") || RAIZ;
      }
      const [nuevo, real] = await this.oc.sesion(`telegram-${chat_id}`, destino);
      st.sesiones = st.sesiones ?? {};
      st.sesiones[chat_id] = nuevo;
      st.dirs = st.dirs ?? {};
      st.dirs[chat_id] = real;
      st.ultimo_ms = st.ultimo_ms ?? {};
      st.ultimo_ms[chat_id] = 0;
      guardar_estado(st);
      return nuevo;
    });
    if (viejo && viejo !== sid) {
      await this.oc.borrar_sesion(viejo); // la que quedó atrás, cerrada
    }
    return sid;
  }

  /** Abre una sesión nueva en el proyecto indicado. Devuelve la ruta real. */
  async cambiar_proyecto(chat_id: string, ruta: string): Promise<string | null> {
    const destino = resolver_proyecto(ruta);
    if (!destino) return null;
    await this.sesion_de(chat_id, true, destino);
    return this.directorio_de(chat_id);
  }

  /** La marca de la última respuesta que ya le entregamos al usuario. */
  async ultimo_ms(chat_id: string): Promise<number> {
    return (leer_estado().ultimo_ms ?? {})[chat_id] ?? 0;
  }

  /** Guarda que ya entregamos la respuesta (así no la repetimos). */
  async marcar_respondido(chat_id: string): Promise<void> {
    const st = leer_estado();
    st.ultimo_ms = st.ultimo_ms ?? {};
    st.ultimo_ms[chat_id] = Date.now();
    guardar_estado(st);
  }
}
