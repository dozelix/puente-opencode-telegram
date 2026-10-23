// Lo que llega de Telegram y no es texto (Python: class Adjuntos, líneas
// 978-1094, y la función transcribir, líneas 872-896): bajar el adjunto,
// transcribir la voz y armar el texto que verá el agente.
//
// La voz NO se transcribe localmente por defecto: el audio viaja adjunto y lo
// escucha un modelo con audio nativo, elegido del catálogo vivo por el Router;
// whisper.cpp queda como respaldo local (invariantes 13-14).
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CONFIG, LOG } from "../config.ts";
import { dir_adjuntos } from "../estado.ts";
import { archivo_id, es_voz, tiene_adjunto } from "../entrada/update.ts";
import { mensaje_de, type Adjunto, type Modelo, type Opencode } from "../adaptadores/opencode.ts";
import type { Objeto } from "../adaptadores/telegram.ts";
import { audio_remoto_ok, type Plan } from "../aplicacion/router.ts";

/** Lo único que `Adjuntos` pide de Telegram: bajar el archivo.
 * `Telegram` cumple esta interfaz; la autoprueba puede inyectar un doble. */
export interface FuenteDescarga {
  descargar(file_id: string): Promise<[Uint8Array, string]>;
}

/** Corre un comando externo y devuelve su salida (null si revienta o se pasa
 * del plazo). El Python usaba subprocess.run(..., timeout=...); acá el hijo
 * se mata al cumplirse el plazo y ninguna falla sale disparando. */
function capturar(comando: string[], plazo_ms: number): Promise<{ codigo: number; texto: string } | null> {
  return new Promise((resolver) => {
    let texto = "";
    let hijo: ReturnType<typeof spawn>;
    try {
      hijo = spawn(comando[0], comando.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolver(null);
      return;
    }
    const plazo = setTimeout(() => {
      try { hijo.kill("SIGTERM"); } catch { /* muerto del todo */ }
    }, plazo_ms);
    hijo.stdout?.on("data", (trozo: Uint8Array) => { texto += Buffer.from(trozo).toString("utf8"); });
    hijo.on("error", () => {
      clearTimeout(plazo);
      resolver(null);
    });
    hijo.on("close", (codigo) => {
      clearTimeout(plazo);
      resolver({ codigo: typeof codigo === "number" ? codigo : -1, texto });
    });
  });
}

/** Transcribe un audio local con whisper.cpp. Devuelve "" si no se puede:
 * falta el binario o el modelo, o ffmpeg/whisper fallan. Nunca revienta
 * (le importa el puente vivo antes que la transcripción perfecta). */
export async function transcribir(origen: string): Promise<string> {
  if (!fs.existsSync(CONFIG.whisperBin) || !fs.existsSync(CONFIG.whisperModelo)) return "";
  fs.mkdirSync(dir_adjuntos(), { recursive: true });
  const sin_ext = path.basename(origen).replace(/\.[^.]*$/, "");
  const wav = `${dir_adjuntos()}/${sin_ext}.16k.wav`;
  // el audio que entiende whisper: 16 kHz, mono
  const ffmpeg = await capturar(
    ["ffmpeg", "-y", "-loglevel", "error", "-i", origen, "-ar", "16000", "-ac", "1", wav],
    120_000,
  );
  if (!ffmpeg || ffmpeg.codigo !== 0) return "";
  const res = await capturar(
    [CONFIG.whisperBin, "-m", CONFIG.whisperModelo, "-f", wav, "-l", CONFIG.vozIdioma, "-nt", "-np"],
    600_000,
  );
  if (!res) return "";
  const lineas: string[] = [];
  for (let linea of res.texto.split(/\r?\n/)) {
    linea = linea.trim();
    if (!linea || linea.startsWith("whisper_") || linea.startsWith("main:")) continue;
    lineas.push(linea);
  }
  return lineas.join(" ").trim();
}

export class Adjuntos {
  constructor(
    private readonly tg: FuenteDescarga,
    private readonly oc: Opencode,
  ) {}

  /** Descarga el adjunto si viene uno. Devuelve [texto, archivos para el agente].
   *
   * La voz NO se transcribe acá: el audio viaja adjunto y lo escucha un
   * modelo con audio nativo elegido del CATÁLOGO VIVO (candidatos del `plan`,
   * probados uno a uno con audio_remoto_ok — que se cachea por modelo).
   * Razón: whisper.cpp en esta máquina es lento y come RAM; el modelo remoto
   * es mejor y es el único que además entiende el contexto de la conversación.
   * Si ningún candidato escucha, queda el respaldo local.
   */
  async preparar(mensaje: Objeto, texto: string, plan?: Plan): Promise<[string, Adjunto[]]> {
    let salida = texto;
    const adjuntos: Adjunto[] = [];
    if (!tiene_adjunto(mensaje)) return [salida, adjuntos];
    try {
      const [datos, nombre] = await this.tg.descargar(archivo_id(mensaje));
      const segundos = Math.floor(Date.now() / 1000);
      const destino = `${dir_adjuntos()}/${segundos}-${nombre}`;
      fs.writeFileSync(destino, datos);
      if (es_voz(mensaje)) {
        // candidatos del plan (Router + catálogo vivo): el primero que
        // pruebe que escucha se queda con el turno y queda anotado en el plan
        const candidatos = plan && plan.modo === "audio" ? plan.candidatos : [];
        let modelo: Modelo | null = null;
        for (const c of candidatos) {
          if (await audio_remoto_ok(this.oc, `${c.providerID}/${c.id}`)) {
            modelo = c;
            break;
          }
        }
        if (modelo && plan) {
          plan.modelo = modelo;
          adjuntos.push({
            uri: pathToFileURL(destino).href,
            name: nombre,
            description: "Nota de voz de Samuel (audio)",
          });
          salida = (
            salida +
            `\n\n[Nota de voz de Samuel adjunta: ${nombre} — transcríbela y responde a lo que dice.]`
          ).trim();
        } else {
          // respaldo local: whisper.cpp en esta máquina
          const voz = await transcribir(destino);
          salida = (
            salida +
            (voz
              ? `\n\n[Nota de voz de Samuel (transcripción): ${voz}]`
              : "\n\n[Nota de voz de Samuel: no se pudo transcribir]")
          ).trim();
        }
      } else {
        adjuntos.push({
          uri: pathToFileURL(destino).href,
          name: nombre,
          description: `Archivo recibido de Samuel por Telegram: ${nombre}`,
        });
        salida = (salida + `\n\n[Archivo adjunto: ${nombre} — ${destino}]`).trim();
      }
    } catch (e) {
      console.log(`${LOG} no pude descargar el archivo: ${mensaje_de(e)}`);
    }
    return [salida, adjuntos];
  }

  /** Respaldo: si no hay modelo de audio, transcribe con whisper.cpp local. */
  async transcribir_local(adjuntos: Adjunto[] | null, texto: string): Promise<string> {
    for (const a of adjuntos ?? []) {
      const uri = (a.uri ?? "").replace("file://", "");
      const ruta = decodeURIComponent(uri);
      if (!fs.existsSync(ruta)) continue;
      if (![".oga", ".ogg", ".wav", ".mp3", ".opus", ".m4a"].includes(path.extname(ruta).toLowerCase())) {
        continue;
      }
      const voz = await transcribir(ruta);
      if (voz) return (texto + `\n\n[Nota de voz (transcripción local): ${voz}]`).trim();
    }
    return texto;
  }
}

