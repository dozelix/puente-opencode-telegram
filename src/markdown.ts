// MarkdownV2 de Telegram (Python: líneas 164-343).
// Telegram NO entiende markdown de GitHub: usa MarkdownV2, donde casi todo
// carácter reservado hay que escaparlo con \. Acá va el traductor y el lint.

export const RESERVADOS_MD2 = "_*[]()~`>#+-=|{}.!";
export const _MARCA = "\x00{}\x00"; // marcador para las partes ya traducidas

/** Escapa los caracteres reservados de MarkdownV2 (fuera de código). */
export function _escapar(texto: string): string {
  const salida: string[] = [];
  for (const ch of texto) {
    if (ch === "\\") salida.push("\\\\");
    else if (RESERVADOS_MD2.includes(ch)) salida.push("\\" + ch);
    else salida.push(ch);
  }
  return salida.join("");
}

/** Dentro de un bloque de código solo se escapan ` y \. */
export function _escapar_codigo(texto: string): string {
  return texto.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

/** Traduce el markdown de siempre al MarkdownV2 que sí entiende Telegram.
 *
 * Reglas: **x** y *x* → negrita · _x_ → cursiva · __x__ → subrayado ·
 * ~~x~~ → tachado · `x` → código · [x](url) → enlace.
 * Los `_` entre letras (snake_case) NO se vuelven cursiva. */
export function a_markdown_v2(texto: string): string {
  if (!texto) return "";
  const guardadas: string[] = [];
  const guarda = (valor: string): string => {
    guardadas.push(valor);
    return _MARCA.replace("{}", String(guardadas.length - 1));
  };

  // 1) código (inline y bloques ```): se protege primero
  const proteger_codigo = (fuente: string): string => {
    const salida: string[] = [];
    let pos = 0;
    for (const m of fuente.matchAll(/(`+)(.+?)\1/gs)) {
      const ini = m.index;
      salida.push(fuente.slice(pos, ini));
      salida.push(guarda(`${m[1]}${_escapar_codigo(m[2] ?? "")}${m[1]}`));
      pos = ini + m[0].length;
    }
    salida.push(fuente.slice(pos));
    return salida.join("");
  };
  texto = proteger_codigo(texto);

  // 2) enlaces: en la URL solo se escapan ) y \
  texto = texto.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (_m, etiqueta: string, url: string) =>
      guarda(`[${_escapar(etiqueta)}](${url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)")})`),
  );

  // 3) negrita (**x** y *x*), cursiva (_x_), subrayado (__x__), tachado (~~x~~)
  texto = texto.replace(/\*\*(.+?)\*\*/gs, (_m, x: string) => guarda(`*${_escapar(x)}*`));
  texto = texto.replace(
    /(?<![\w*])\*([^*\n]{1,200}?)\*(?![\w*])/g,
    (_m, x: string) => guarda(`*${_escapar(x)}*`),
  );
  texto = texto.replace(
    /(?<![\w_])__([^_\n]{1,200}?)__(?![\w_])/g,
    (_m, x: string) => guarda(`__${_escapar(x)}__`),
  );
  texto = texto.replace(
    /(?<![\w~])~~([^~\n]{1,200}?)~~(?![\w~])/g,
    (_m, x: string) => guarda(`~${_escapar(x)}~`),
  );
  texto = texto.replace(
    /(?<![\w_])_([^_\n]{1,200}?)_(?![\w_])/g,
    (_m, x: string) => guarda(`_${_escapar(x)}_`),
  );

  // 4) el resto, escapado
  texto = _escapar(texto);

  // 5) se devuelven las partes ya traducidas
  return texto.replace(/\x00(\d+)\x00/g, (_m, i: string) => guardadas[Number(i)] ?? "");
}

/** Revisa que el texto sea MarkdownV2 válido. Devuelve los problemas. */
export function lint_markdown_v2(texto: string): string[] {
  const problemas: string[] = [];
  // los enlaces son entidades propias: se validan aparte y se ocultan del escaneo
  let resto = texto;
  for (const m of texto.matchAll(/\[((?:\\.|[^\]\\])*)\]\(((?:\\.|[^)\\])*)\)/g)) {
    const etiqueta = m[1] ?? "";
    const url = m[2] ?? "";
    for (const p of lint_markdown_v2(etiqueta)) problemas.push(`enlace: ${p}`);
    for (const esc of url.matchAll(/\\(.)/g)) {
      const c = esc[1] ?? "";
      if (c !== ")" && c !== "\\") problemas.push(`escape inválido en la URL: \\${c}`);
    }
    resto = resto.replaceAll(m[0], "\x01");
  }

  const n = resto.length;
  const delimitadores: Record<"*" | "_" | "~", number[]> = { "*": [], "_": [], "~": [] };
  let i = 0;
  while (i < n) {
    const ch = resto[i] ?? "";
    if (ch === "\\") {
      if (i + 1 >= n) {
        problemas.push("escape suelto al final del texto");
        i += 1;
        continue;
      }
      const nxt = resto[i + 1] ?? "";
      if (!RESERVADOS_MD2.includes(nxt) && nxt !== "`" && nxt !== "\\") {
        problemas.push(`escape inválido: \\${nxt}`);
      }
      i += 2;
      continue;
    }
    if (ch === "`") {
      let j = i;
      while (j < n && resto[j] === "`") j += 1;
      const largo = j - i;
      let k = j;
      let cierre = -1;
      while (k < n) {
        if (resto[k] === "\\") {
          k += 2;
          continue;
        }
        if (resto[k] === "`") {
          let m2 = k;
          while (m2 < n && resto[m2] === "`") m2 += 1;
          if (m2 - k === largo) {
            cierre = k;
            break;
          }
          k = m2;
          continue;
        }
        k += 1;
      }
      if (cierre < 0) {
        problemas.push("bloque de código sin cerrar");
        i = j;
        continue;
      }
      for (let idx = j; idx < cierre; idx++) {
        if (resto[idx] === "\\" && idx + 1 < cierre) {
          const nx = resto[idx + 1] ?? "";
          if (nx !== "`" && nx !== "\\") problemas.push(`escape inválido dentro de código: \\${nx}`);
        }
      }
      i = cierre + largo;
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      delimitadores[ch].push(i);
      i += 1;
      continue;
    }
    if (RESERVADOS_MD2.includes(ch)) problemas.push(`carácter sin escapar: ${JSON.stringify(ch)}`);
    i += 1;
  }

  for (const ch of ["*", "_", "~"] as const) {
    const posiciones = delimitadores[ch];
    if (posiciones.length % 2 === 1) {
      problemas.push(`delimitador sin pareja: ${JSON.stringify(ch)}`);
      continue;
    }
    for (let p = 0; p + 1 < posiciones.length; p += 2) {
      if ((posiciones[p] ?? 0) >= (posiciones[p + 1] ?? 1)) {
        problemas.push(`delimitadores cruzados: ${JSON.stringify(ch)}`);
      }
    }
  }
  return problemas;
}

/** Parte un texto largo sin cortar entidades de markdown (por párrafos). */
export function partir(texto: string, limite = 3800): string[] {
  if (texto.length <= limite) return [texto];
  const partes: string[] = [];
  let actual = "";
  for (const parrafo of texto.split(/(\n\n)/)) {
    if (actual.length + parrafo.length <= limite) {
      actual += parrafo;
      continue;
    }
    if (actual) {
      partes.push(actual);
      actual = "";
    }
    let resto = parrafo;
    while (resto.length > limite) {
      // rfind("\n", 0, limite): el último salto dentro del primer trozo
      let corte = resto.slice(0, limite).lastIndexOf("\n");
      if (corte <= 0) corte = limite;
      partes.push(resto.slice(0, corte));
      resto = resto.slice(corte);
    }
    actual = resto;
  }
  if (actual) partes.push(actual);
  return partes;
}
